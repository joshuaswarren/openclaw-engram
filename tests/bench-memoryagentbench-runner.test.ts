import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  BenchJudge,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();
  readonly judge?: BenchJudge;

  constructor(judge?: BenchJudge) {
    this.judge = judge;
  }

  async store(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...existing, ...messages]);
  }

  async recall(sessionId: string, _query: string): Promise<string> {
    return (this.sessions.get(sessionId) ?? [])
      .map((message) => message.content)
      .join("\n");
  }

  async search(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<SearchResult[]> {
    const haystack = sessionId
      ? [[sessionId, this.sessions.get(sessionId) ?? []] as const]
      : [...this.sessions.entries()];

    const results: SearchResult[] = [];
    for (const [currentSessionId, messages] of haystack) {
      messages.forEach((message, index) => {
        if (message.content.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            turnIndex: index,
            role: message.role,
            snippet: message.content,
            sessionId: currentSessionId,
            score: 1,
          });
        }
      });
    }

    return results.slice(0, limit);
  }

  async reset(sessionId?: string): Promise<void> {
    if (sessionId) {
      this.sessions.delete(sessionId);
      return;
    }
    this.sessions.clear();
  }

  async getStats(): Promise<{
    totalMessages: number;
    totalSummaryNodes: number;
    maxDepth: number;
  }> {
    const totalMessages = [...this.sessions.values()].reduce(
      (sum, messages) => sum + messages.length,
      0,
    );

    return {
      totalMessages,
      totalSummaryNodes: 0,
      maxDepth: 1,
    };
  }

  async destroy(): Promise<void> {}
}

test("runBenchmark executes memoryagentbench in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("memoryagentbench", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "memoryagentbench");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 4);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(typeof result.results.aggregates.rouge_l?.mean, "number");
  assert.equal(result.results.tasks[0]?.details.competency, "accurate_retrieval");
  assert.equal(result.results.tasks[2]?.details.competency, "long_range_understanding");
  assert.equal(
    result.results.tasks[3]?.actual.includes("The current project codename is Zephyr."),
    true,
  );
  assert.deepEqual(result.results.tasks[0]?.details.answerVariants, [
    "the riverside market",
    "riverside market",
  ]);
});

test("runBenchmark executes memoryagentbench in full mode from split dataset files", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memoryagentbench-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "Accurate_Retrieval.json"),
    JSON.stringify([
      {
        context: "Event log:\\n1. Priya checked in at the library.\\n2. Priya headed to the cafe.",
        questions: ["Where did Priya go after the library?"],
        answers: [["the cafe", "cafe"]],
        metadata: {
          source: "eventqa_full",
          qa_pair_ids: ["mab-full-ar-q1"],
        },
      },
    ]),
    "utf8",
  );

  await writeFile(
    path.join(datasetDir, "Conflict_Resolution.json"),
    JSON.stringify([
      {
        context: "0. The active theme is Ember.\\n1. The active theme is Aurora.",
        questions: ["What is the active theme?"],
        answers: [["Aurora"]],
        metadata: {
          source: "factconsolidation_sh_6k",
          qa_pair_ids: ["mab-full-cr-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.tasks[0]?.expected, "the cafe");
  assert.equal(result.results.tasks[0]?.details.competency, "accurate_retrieval");
  assert.equal(result.results.tasks[1]?.expected, "Aurora");
  assert.equal(result.results.tasks[1]?.details.competency, "conflict_resolution");
});

test("runBenchmark uses the best-matching MemoryAgentBench answer variant for judge scoring", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-judge-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const judgeCalls: Array<{
    expected: string;
    predicted: string;
    question: string;
  }> = [];
  const adapter = new FakeMemoryAdapter({
    async score(question, predicted, expected) {
      judgeCalls.push({ question, predicted, expected });
      return expected === "quarterly roadmap review" ? 0.91 : 0.13;
    },
  });
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context:
          "Notes:\\nThe team met for the quarterly roadmap review and wrote action items.",
        questions: ["Which meeting generated the action items?"],
        answers: [["roadmap meeting", "quarterly roadmap review"]],
        metadata: {
          source: "eventqa_judge_variant",
          qa_pair_ids: ["mab-judge-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(judgeCalls.length, 1);
  assert.deepEqual(judgeCalls[0], {
    question: "Which meeting generated the action items?",
    predicted:
      "Notes:\\nThe team met for the quarterly roadmap review and wrote action items.",
    expected: "quarterly roadmap review",
  });
  assert.equal(result.results.tasks[0]?.details.bestExpectedAnswer, "quarterly roadmap review");
  assert.equal(result.results.tasks[0]?.expected, "roadmap meeting");
  assert.equal(result.results.tasks[0]?.scores.llm_judge, 0.91);
  assert.equal(result.results.tasks[0]?.scores.f1 > 0, true);
});

test("runBenchmark keeps sentence-ending punctuation on the preceding MemoryAgentBench chunk", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memoryagentbench-chunking-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  const longSentence = `${"A".repeat(1_190)}. ${"B".repeat(40)}`;
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: longSentence,
        questions: ["What token fills the second sentence?"],
        answers: [["B"]],
        metadata: {
          source: "eventqa_sentence_chunking",
          qa_pair_ids: ["mab-chunk-q1"],
        },
      },
    ]),
    "utf8",
  );

  const result = await runBenchmark("memoryagentbench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });
  const storedMessages = [...adapter.sessions.values()][0];

  assert.equal(storedMessages?.length, 2);
  assert.equal(storedMessages?.[0]?.content.endsWith("."), true);
  assert.equal(storedMessages?.[1]?.content.startsWith("."), false);
  assert.equal(
    result.results.tasks[0]?.actual.includes(`${"A".repeat(1_190)}.\n${"B".repeat(40)}`),
    true,
  );
});

test("runBenchmark rejects memoryagentbench full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memoryagentbench", {
        mode: "full",
        system: adapter,
      }),
    /MemoryAgentBench full mode requires datasetDir/,
  );
});

test("runBenchmark fails fast when memoryagentbench full mode is given an explicit missing datasetDir", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memoryagentbench-missing-"));
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memoryagentbench", {
        mode: "full",
        datasetDir: path.join(tmpDir, "does-not-exist"),
        system: adapter,
      }),
    /MemoryAgentBench dataset not found under/,
  );
});

test("runBenchmark rejects empty memoryagentbench datasets after applying limit", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memoryagentbench", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /MemoryAgentBench dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark rejects unsupported memoryagentbench metadata sources with a benchmark-specific error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memoryagentbench-bad-source-"));
  const datasetDir = path.join(tmpDir, "datasets", "memoryagentbench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "memoryagentbench.json"),
    JSON.stringify([
      {
        context: "Bad sample.",
        questions: ["What happened?"],
        answers: [["Nothing"]],
        metadata: {
          source: "unknown_split",
        },
      },
    ]),
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memoryagentbench", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /does not map to a supported competency/,
  );
});
