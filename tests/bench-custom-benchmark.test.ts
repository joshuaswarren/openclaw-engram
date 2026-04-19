import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import {
  parseCustomBenchmark,
} from "../packages/bench/src/benchmarks/custom/loader.js";
import { runCustomBenchmarkFile } from "../packages/bench/src/benchmarks/custom/runner.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();

  async store(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...existing, ...messages]);
  }

  async recall(
    sessionId: string,
    _query: string,
    _budgetChars?: number,
  ): Promise<string> {
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
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2);

    const results: SearchResult[] = [];
    for (const [currentSessionId, messages] of haystack) {
      messages.forEach((message, index) => {
        const content = message.content.toLowerCase();
        if (tokens.some((token) => content.includes(token))) {
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

  async getStats(_sessionId?: string): Promise<{
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

test("parseCustomBenchmark normalizes a valid YAML benchmark definition", () => {
  const benchmark = parseCustomBenchmark(`
name: Sky Check
description: Custom benchmark for a single memory fact
version: 2.0.0
category: retrieval
scoring: exact_match
tasks:
  - question: What color is the sky?
    expected: The sky is blue.
    tags: [nature, weather]
`);

  assert.equal(benchmark.name, "Sky Check");
  assert.equal(benchmark.description, "Custom benchmark for a single memory fact");
  assert.equal(benchmark.version, "2.0.0");
  assert.equal(benchmark.category, "retrieval");
  assert.equal(benchmark.scoring, "exact_match");
  assert.equal(benchmark.tasks.length, 1);
  assert.deepEqual(benchmark.tasks[0]?.tags, ["nature", "weather"]);
});

test("parseCustomBenchmark rejects custom benchmarks without tasks", () => {
  assert.throws(
    () =>
      parseCustomBenchmark(`
name: Empty
scoring: f1
tasks: []
`),
    /must include at least one task/,
  );
});

test("parseCustomBenchmark accepts ingestion as a category", () => {
  const benchmark = parseCustomBenchmark(`
name: Ingestion Check
scoring: exact_match
category: ingestion
tasks:
  - question: Was the document indexed?
    expected: Yes
`);

  assert.equal(benchmark.category, "ingestion");
});

test("parseCustomBenchmark rejects unsupported scoring values", () => {
  assert.throws(
    () =>
      parseCustomBenchmark(`
name: Invalid
scoring: made_up
tasks:
  - question: What is stored here?
    expected: A fact
`),
    /must be one of exact_match, f1, rouge_l, llm_judge/,
  );
});

test("runCustomBenchmarkFile executes a custom YAML benchmark against the adapter", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-custom-bench-"));
  const filePath = path.join(tmpDir, "sky-check.yaml");
  await writeFile(
    filePath,
    `
name: Sky Check
description: Custom benchmark for a single memory fact
scoring: exact_match
tasks:
  - question: What color is the sky?
    expected: The sky is blue.
    tags: [nature, weather]
`,
  );

  const adapter = new FakeMemoryAdapter();
  await adapter.store("memory", [
    { role: "assistant", content: "The sky is blue." },
  ]);

  const result = await runCustomBenchmarkFile(filePath, {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "custom:sky-check");
  assert.equal(result.meta.benchmarkTier, "custom");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.runCount, 1);
  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.actual, "The sky is blue.");
  assert.equal(result.results.tasks[0]?.scores.exact_match, 1);
  assert.equal(result.results.aggregates.exact_match?.mean, 1);
});
