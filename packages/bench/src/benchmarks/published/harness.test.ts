import assert from "node:assert/strict";
import test from "node:test";

import {
  runPublishedHarness,
  type HarnessContext,
  type HarnessPlan,
} from "./harness.ts";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../types.ts";

/**
 * Fake system under test that records every call into a deterministic
 * log. Recall always returns a synthesized string containing the session
 * ID + the question so tests can verify session routing.
 */
function makeFakeSystem(opts?: {
  recallPrefix?: string;
  searchHits?: number;
  judgeScore?: number;
  responderModel?: string;
  judgeModel?: string;
}) {
  const calls: Array<
    | { kind: "reset" }
    | { kind: "store"; sessionId: string; messageCount: number }
    | { kind: "recall"; sessionId: string; question: string }
    | { kind: "search"; query: string; limit: number }
    | { kind: "judge"; question: string; predicted: string; expected: string }
    | { kind: "respond"; question: string }
  > = [];

  const system = {
    async reset() {
      calls.push({ kind: "reset" });
    },
    async store(sessionId: string, messages: Array<unknown>) {
      calls.push({ kind: "store", sessionId, messageCount: messages.length });
    },
    async recall(sessionId: string, question: string) {
      calls.push({ kind: "recall", sessionId, question });
      return `${opts?.recallPrefix ?? "recall"}:${sessionId}:${question}`;
    },
    async search(query: string, limit: number) {
      calls.push({ kind: "search", query, limit });
      return new Array(opts?.searchHits ?? 0).fill({ id: "r", text: "t" });
    },
    async destroy() {},
    async getStats() {
      return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
    },
    responder: {
      async respond(question: string) {
        calls.push({ kind: "respond", question });
        return {
          text: `answer:${question}`,
          tokens: { input: 1, output: 2 },
          latencyMs: 1,
          model: opts?.responderModel ?? "smoke-responder",
        };
      },
    },
    judge: {
      async score() {
        return opts?.judgeScore ?? 1;
      },
      async scoreWithMetrics(
        question: string,
        predicted: string,
        expected: string,
      ) {
        calls.push({ kind: "judge", question, predicted, expected });
        return {
          score: opts?.judgeScore ?? 1,
          tokens: { input: 0, output: 0 },
          latencyMs: 0,
          model: opts?.judgeModel ?? "smoke-judge",
        };
      },
    },
  };
  return { system, calls };
}

const smokeDefinition: BenchmarkDefinition = {
  id: "harness-test",
  title: "Harness Test",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "harness-test",
    version: "0.0.0",
    description: "test",
    category: "retrieval",
    citation: "test",
  },
};

function makeOptions(
  system: ReturnType<typeof makeFakeSystem>["system"],
  overrides?: Partial<ResolvedRunBenchmarkOptions>,
): ResolvedRunBenchmarkOptions {
  return {
    benchmark: smokeDefinition,
    mode: "quick",
    system: system as unknown as ResolvedRunBenchmarkOptions["system"],
    seed: 42,
    ...overrides,
  };
}

test("runPublishedHarness resets once per plan and stores every non-empty session", async () => {
  const { system, calls } = makeFakeSystem();
  const plans: HarnessPlan[] = [
    {
      ingestSessions: [
        { sessionId: "a", messages: [{ role: "user", content: "hi" }] },
        { sessionId: "empty", messages: [] },
        { sessionId: "b", messages: [{ role: "user", content: "hello" }] },
      ],
      trials: [
        {
          taskId: "t1",
          question: "Q1",
          expected: "A1",
          recallSessionIds: ["a", "b"],
        },
      ],
    },
    {
      ingestSessions: [
        { sessionId: "c", messages: [{ role: "user", content: "x" }] },
      ],
      trials: [
        {
          taskId: "t2",
          question: "Q2",
          expected: "A2",
          recallSessionIds: ["c"],
        },
      ],
    },
  ];

  const ctx: HarnessContext = {
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1", "contains_answer"] },
    plans,
  };
  const result = await runPublishedHarness(ctx);

  const resets = calls.filter((call) => call.kind === "reset");
  assert.equal(resets.length, 2, "expected one reset per plan");

  const stores = calls.filter((call) => call.kind === "store");
  assert.equal(stores.length, 3, "empty session should not be stored");
  assert.deepEqual(stores.map((store) => (store as any).sessionId), [
    "a",
    "b",
    "c",
  ]);

  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.meta.seeds[0], 42);
  assert.equal(result.meta.benchmark, "harness-test");
  assert.equal(result.config.adapterMode, "direct");
});

test("runPublishedHarness recalls from ALL recallSessionIds per trial", async () => {
  const { system, calls } = makeFakeSystem();
  const plans: HarnessPlan[] = [
    {
      ingestSessions: [
        { sessionId: "s1", messages: [{ role: "user", content: "x" }] },
        { sessionId: "s2", messages: [{ role: "user", content: "y" }] },
      ],
      trials: [
        {
          taskId: "multi",
          question: "who",
          expected: "nobody",
          recallSessionIds: ["s1", "s2"],
        },
      ],
    },
  ];

  await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1"] },
    plans,
  });

  const recalls = calls.filter((call) => call.kind === "recall") as Array<{
    kind: "recall";
    sessionId: string;
    question: string;
  }>;
  assert.deepEqual(
    recalls.map((recall) => recall.sessionId).sort(),
    ["s1", "s2"],
  );
  for (const recall of recalls) {
    assert.equal(recall.question, "who");
  }
});

test("runPublishedHarness postAnswerHook runs between answer and judge", async () => {
  const { system, calls } = makeFakeSystem({ searchHits: 4 });
  const order: string[] = [];
  const plans: HarnessPlan[] = [
    {
      ingestSessions: [
        { sessionId: "s", messages: [{ role: "user", content: "hi" }] },
      ],
      trials: [
        {
          taskId: "hooked",
          question: "q",
          expected: "a",
          recallSessionIds: ["s"],
          postAnswerHook: async () => {
            order.push("hook");
            const results = await system.search("q", 10);
            return { extraScores: { search_hits: results.length } };
          },
        },
      ],
    },
  ];

  const originalJudge = system.judge.scoreWithMetrics.bind(system.judge);
  system.judge.scoreWithMetrics = async (...args) => {
    order.push("judge");
    return originalJudge(...args);
  };
  const originalRespond = system.responder.respond.bind(system.responder);
  system.responder.respond = async (...args) => {
    order.push("respond");
    return originalRespond(...args);
  };

  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1", "llm_judge"] },
    plans,
  });

  assert.deepEqual(order, ["respond", "hook", "judge"]);
  assert.equal(result.results.tasks[0]?.scores.search_hits, 4);
  // Search call happened on the live system during the hook.
  assert.ok(calls.some((call) => call.kind === "search"));
});

test("runPublishedHarness llm_judge metric suppressed when judge score negative", async () => {
  const { system } = makeFakeSystem({ judgeScore: -1 });
  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1", "llm_judge"] },
    plans: [
      {
        ingestSessions: [
          { sessionId: "s", messages: [{ role: "user", content: "h" }] },
        ],
        trials: [
          {
            taskId: "no-judge",
            question: "q",
            expected: "a",
            recallSessionIds: ["s"],
          },
        ],
      },
    ],
  });
  const task = result.results.tasks[0]!;
  assert.ok("f1" in task.scores, "f1 should be present");
  assert.ok(
    !("llm_judge" in task.scores),
    "llm_judge should be omitted when judge returns negative",
  );
});

test("runPublishedHarness is deterministic across repeated runs with same seed", async () => {
  async function run(): Promise<BenchmarkResult> {
    const { system } = makeFakeSystem();
    return await runPublishedHarness({
      options: makeOptions(system, { seed: 7 }),
      metricsSpec: { metrics: ["f1", "contains_answer", "rouge_l"] },
      plans: [
        {
          ingestSessions: [
            {
              sessionId: "s",
              messages: [{ role: "user", content: "hello world" }],
            },
          ],
          trials: [
            {
              taskId: "det-1",
              question: "say hello",
              expected: "hello",
              recallSessionIds: ["s"],
            },
          ],
        },
      ],
    });
  }

  const a = await run();
  const b = await run();

  // `id` and `timestamp` are non-deterministic by design (UUID +
  // wall-clock). Every other field must be identical.
  assert.equal(a.meta.seeds[0], b.meta.seeds[0]);
  assert.equal(a.meta.mode, b.meta.mode);
  assert.equal(a.meta.benchmark, b.meta.benchmark);
  assert.equal(a.results.tasks.length, b.results.tasks.length);
  for (let i = 0; i < a.results.tasks.length; i += 1) {
    const taskA = a.results.tasks[i]!;
    const taskB = b.results.tasks[i]!;
    assert.equal(taskA.taskId, taskB.taskId);
    assert.equal(taskA.actual, taskB.actual);
    assert.deepEqual(taskA.scores, taskB.scores);
  }
});

test("runPublishedHarness rejects unknown metric id", async () => {
  const { system } = makeFakeSystem();
  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system),
        // @ts-expect-error intentional invalid metric
        metricsSpec: { metrics: ["not-a-metric"] },
        plans: [],
      }),
    /unknown metric/,
  );
});

test("runPublishedHarness rejects negative or non-integer seed", async () => {
  const { system } = makeFakeSystem();
  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, { seed: -1 }),
        metricsSpec: { metrics: ["f1"] },
        plans: [],
      }),
    /seed must be a non-negative integer/,
  );
  await assert.rejects(
    () =>
      runPublishedHarness({
        options: makeOptions(system, { seed: 1.5 }),
        metricsSpec: { metrics: ["f1"] },
        plans: [],
      }),
    /seed must be a non-negative integer/,
  );
});

test("runPublishedHarness produces empty result for empty plans", async () => {
  const { system } = makeFakeSystem();
  const result = await runPublishedHarness({
    options: makeOptions(system),
    metricsSpec: { metrics: ["f1"] },
    plans: [],
  });
  assert.equal(result.results.tasks.length, 0);
  assert.equal(result.cost.meanQueryLatencyMs, 0);
});
