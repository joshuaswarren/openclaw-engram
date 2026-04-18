import test from "node:test";
import assert from "node:assert/strict";
import type { BenchMemoryAdapter, SearchResult, Message } from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class NoopMemoryAdapter implements BenchMemoryAdapter {
  async store(_sessionId: string, _messages: Message[]): Promise<void> {}

  async recall(_sessionId: string, _query: string): Promise<string> {
    return "";
  }

  async search(
    _query: string,
    _limit: number,
    _sessionId?: string,
  ): Promise<SearchResult[]> {
    return [];
  }

  async reset(_sessionId?: string): Promise<void> {}

  async getStats() {
    return {
      totalMessages: 0,
      totalSummaryNodes: 0,
      maxDepth: 0,
    };
  }

  async destroy(): Promise<void> {}
}

const adapter = new NoopMemoryAdapter();

test("runBenchmark executes taxonomy-accuracy in quick mode", async () => {
  const result = await runBenchmark("taxonomy-accuracy", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "taxonomy-accuracy");
  assert.equal(result.meta.benchmarkTier, "remnic");
  assert.equal(result.results.tasks.length, 5);
  assert.equal(result.results.aggregates.exact_match.mean, 1);
});

test("runBenchmark executes extraction-judge-calibration in quick mode", async () => {
  const result = await runBenchmark("extraction-judge-calibration", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "extraction-judge-calibration");
  assert.equal(result.meta.benchmarkTier, "remnic");
  assert.equal(result.results.tasks.length, 5);
  assert.ok(result.results.aggregates.exact_match.mean >= 0.8);
  assert.equal(typeof result.results.aggregates.sensitivity.mean, "number");
  assert.equal(typeof result.results.aggregates.specificity.mean, "number");
});

test("runBenchmark executes enrichment-fidelity in quick mode", async () => {
  const result = await runBenchmark("enrichment-fidelity", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "enrichment-fidelity");
  assert.equal(result.meta.benchmarkTier, "remnic");
  assert.equal(result.results.tasks.length, 3);
  assert.ok(result.results.aggregates.accepted_precision.mean >= 0.66);
  assert.equal(result.results.aggregates.exact_count_match.mean, 1);
});
