import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  BenchResponder,
  BenchResponse,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();
  responder?: BenchResponder;

  constructor(responder?: BenchResponder) {
    this.responder = responder;
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

  async search(query: string, limit: number, sessionId?: string): Promise<SearchResult[]> {
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

class FixedResponder implements BenchResponder {
  constructor(private readonly text: string) {}

  async respond(): Promise<BenchResponse> {
    return {
      text: this.text,
      tokens: { input: 0, output: 0 },
      latencyMs: 0,
      model: "fixed",
    };
  }
}

function createDatasetProfile() {
  return [
    {
      id: "dataset-profile-1",
      start_time: "2025-02-01T00:00:00Z",
      user_profile: {
        uuid: "dataset-user-1",
        name: "Jordan",
        age: 34,
        gender: "nonbinary",
      },
      state_schema: {
        city: { type: "string" },
      },
      periods: [
        {
          period_start: "2025-02-01T00:00:00Z",
          period_end: "2025-02-28T23:59:59Z",
          period_summary: "Jordan moved cities.",
          sessions: [
            {
              event: "Jordan moved to Seattle.",
              exposed_states: { city: "Seattle" },
              query: "I live in Seattle now after the move.",
              messages: [],
              session_time: "2025-02-12T08:00:00Z",
            },
          ],
          state: { city: "Seattle" },
          updates: { city: "Seattle" },
          update_cnts: { city: 1 },
        },
      ],
      qas: [
        {
          query: "Where does Jordan live now?",
          required_info: ["city"],
          answer_choices: [
            { state: ["Seattle"], answer: "Seattle" },
            { state: ["Denver"], answer: "Denver" },
          ],
        },
      ],
    },
  ];
}

test("runBenchmark executes amemgym in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("amemgym", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "amemgym");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(result.results.tasks[0]?.expected, "Chicago");
  assert.equal(result.results.tasks[1]?.expected, "trail mix");
  assert.equal(result.results.tasks[1]?.actual.includes("trail mix"), true);
});

test("runBenchmark executes amemgym in full mode from an explicit dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Seattle");
});

test("runBenchmark scores amemgym using the benchmark multiple-choice protocol", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-choice-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter(new FixedResponder("1"));
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    JSON.stringify(createDatasetProfile()),
    "utf8",
  );

  const result = await runBenchmark("amemgym", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  const task = result.results.tasks[0]!;
  assert.match(task.question, /Answer choices:/);
  assert.equal(task.scores.qa_accuracy, 1);
  assert.equal(task.scores.contains_answer, 1);
  assert.equal(task.details?.expectedChoiceIndex, 1);
  assert.equal(task.details?.selectedChoiceIndex, 1);
  assert.equal(task.details?.selectedAnswer, "Seattle");
  assert.equal(typeof result.results.aggregates.qa_accuracy?.mean, "number");
});

test("runBenchmark rejects amemgym full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("amemgym", {
        mode: "full",
        system: adapter,
      }),
    /AMemGym full mode requires datasetDir/,
  );
});

test("runBenchmark fails fast when amemgym full mode is given an explicit missing datasetDir", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-missing-"));
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("amemgym", {
        mode: "full",
        datasetDir: path.join(tmpDir, "does-not-exist"),
        system: adapter,
      }),
    /AMemGym dataset not found under/,
  );
});

test("runBenchmark fails fast when amemgym full mode is given an explicit unreadable dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-bad-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "data.json"), "{not json");

  await assert.rejects(
    () =>
      runBenchmark("amemgym", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /AMemGym dataset not found under/,
  );
});

test("runBenchmark rejects empty amemgym datasets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-amemgym-empty-"));
  const datasetDir = path.join(tmpDir, "datasets", "amemgym");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "data.json"),
    "[]",
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("amemgym", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /AMemGym dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark treats amemgym limit zero as an empty run instead of falling back to all profiles", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("amemgym", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /AMemGym dataset is empty after applying the requested limit/,
  );
});
