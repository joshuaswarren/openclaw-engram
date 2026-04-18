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

function createDatasetCases() {
  return [
    {
      id: "membench-dataset-1",
      memoryType: "factual",
      scenario: "participant",
      level: "surface",
      turns: [
        {
          role: "user",
          content: "I moved to Lisbon last spring to work from the waterfront.",
        },
        {
          role: "assistant",
          content: "Lisbon by the waterfront, noted.",
        },
      ],
      question: "Which city did I move to last spring?",
      answer: "Lisbon",
    },
  ];
}

test("runBenchmark executes membench in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("membench", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "membench");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(result.results.tasks[0]?.expected, "Lisbon");
  assert.equal(result.results.tasks[0]?.actual.includes("Lisbon"), true);
  assert.equal(result.results.tasks[0]?.details.memoryType, "factual");
  assert.equal(result.results.tasks[1]?.details.memoryType, "reflective");
});

test("runBenchmark executes membench in full mode from an explicit dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-membench-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "membench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "membench.json"),
    JSON.stringify(createDatasetCases()),
    "utf8",
  );

  const result = await runBenchmark("membench", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Lisbon");
  assert.equal(result.results.tasks[0]?.details.scenario, "participant");
});

test("runBenchmark rejects membench full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("membench", {
        mode: "full",
        system: adapter,
      }),
    /MemBench full mode requires datasetDir/,
  );
});

test("runBenchmark treats membench limit zero as an empty run instead of falling back to all cases", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("membench", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /MemBench dataset is empty after applying the requested limit/,
  );
});
