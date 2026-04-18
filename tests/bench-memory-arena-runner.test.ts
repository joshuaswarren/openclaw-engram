import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();

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

test("runBenchmark executes memory-arena in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("memory-arena", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "memory-arena");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(
    result.results.tasks[1]?.actual.includes("Answer for subtask 1: trail mix"),
    true,
  );
  assert.equal(result.results.tasks[1]?.expected, "trail mix");
});

test("runBenchmark preserves string-form memory-arena answers in full mode datasets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-string-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["Which snack did we agree to buy?"],
      answers: ["trail mix"],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.expected, "trail mix");
});

test("runBenchmark preserves array-form memory-arena answers in full mode datasets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-array-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "group_travel_planner.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "group_travel_planner",
      questions: ["Which museum stop should we keep in the itinerary?"],
      answers: [[{ name: "Art Institute" }, { day: "Saturday" }]],
    })}\n`,
    "utf8",
  );

  const result = await runBenchmark("memory-arena", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(
    result.results.tasks[0]?.expected,
    "name: Art Institute | day: Saturday",
  );
});

test("runBenchmark rejects memory-arena full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        system: adapter,
      }),
    /MemoryArena full mode requires datasetDir/,
  );
});

test("runBenchmark fails fast when memory-arena full mode is given an explicit missing datasetDir", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-missing-"));
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir: path.join(tmpDir, "does-not-exist"),
        system: adapter,
      }),
    /MemoryArena dataset not found under/,
  );
});

test("runBenchmark fails fast when memory-arena full mode is given an explicit unreadable dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-bad-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "bundled_shopping.jsonl"), "{not json");

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /MemoryArena dataset file bundled_shopping\.jsonl contains invalid JSON on line 1/,
  );
});

test("runBenchmark rejects empty memory-arena datasets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-empty-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    "",
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /MemoryArena dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark rejects malformed memory-arena questions arrays with a benchmark-specific error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-bad-questions-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: [42],
      answers: [{ attributes: ["trail mix"] }],
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must include a questions array of strings/,
  );
});

test("runBenchmark rejects malformed memory-arena answers arrays with a benchmark-specific error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-bad-answers-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["What snack should I pack?"],
      answers: [null],
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must include an answers array of strings, objects, or arrays of those values/,
  );
});

test("runBenchmark reports original JSONL line numbers when blank lines precede malformed memory-arena rows", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-memory-arena-lines-"));
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `\n${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["What snack should I pack?"],
      answers: [{ attributes: ["trail mix"] }],
    })}\n\n{not json}\n`,
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /contains invalid JSON on line 4/,
  );
});

test("runBenchmark fails fast when a memory-arena question is missing a matching answer entry", async () => {
  const tmpDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-bench-memory-arena-"),
  );
  const datasetDir = path.join(tmpDir, "datasets", "memory-arena");
  await mkdir(datasetDir, { recursive: true });

  await writeFile(
    path.join(datasetDir, "bundled_shopping.jsonl"),
    `${JSON.stringify({
      id: 1,
      category: "bundled_shopping",
      questions: ["What product should we buy?"],
      answers: [],
    })}\n`,
    "utf8",
  );

  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("memory-arena", {
        mode: "full",
        datasetDir,
        limit: 1,
        system: adapter,
      }),
    /MemoryArena task bundled_shopping:1 is missing answer index 0/,
  );

  assert.equal(
    [...adapter.sessions.values()].some((messages) =>
      messages.some((message) => /Answer for subtask/.test(message.content)),
    ),
    false,
  );
});
