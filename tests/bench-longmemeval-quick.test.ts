import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import {
  runBenchmark,
  writeBenchmarkResult,
  type BenchMemoryAdapter,
  type Message,
  type SearchResult,
} from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();

  async store(sessionId: string, messages: Message[]): Promise<void> {
    this.sessions.set(sessionId, messages);
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

  async getStats(): Promise<{ totalMessages: number; totalSummaryNodes: number; maxDepth: number }> {
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

test("runBenchmark executes longmemeval in quick mode and writes a result JSON file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-longmemeval-"));
  const outputDir = path.join(tmpDir, "results");

  const adapter = new FakeMemoryAdapter();
  const result = await runBenchmark("longmemeval", {
    mode: "quick",
    outputDir,
    limit: 1,
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "longmemeval");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.runCount, 1);
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.statistics, undefined);
  assert.equal(result.results.tasks[0]?.actual.includes("Paris"), true);
  assert.equal(result.results.tasks[0]?.expected, "Paris");
  assert.equal(result.results.tasks[0]?.scores.contains_answer, 1);

  const writtenPath = await writeBenchmarkResult(result, outputDir);
  const written = JSON.parse(await readFile(writtenPath, "utf8")) as typeof result;

  assert.equal(path.dirname(writtenPath), outputDir);
  assert.equal(written.meta.benchmark, "longmemeval");
  assert.equal(written.results.tasks.length, 1);
});
