import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runCustomBenchmarkFile } from "./runner.ts";

test("custom benchmark latency includes reported judge latency outside the search timer", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-custom-bench-"));
  const benchmarkPath = path.join(tempDir, "latency.yaml");

  try {
    await writeFile(
      benchmarkPath,
      [
        "name: Custom Latency",
        "scoring: llm_judge",
        "tasks:",
        "  - question: What happened?",
        "    expected: It happened.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runCustomBenchmarkFile(benchmarkPath, {
      mode: "quick",
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search(query) {
          assert.equal(query, "What happened?");
          return [
            {
              turnIndex: 0,
              role: "assistant",
              snippet: "It happened.",
              sessionId: "session-1",
            },
          ];
        },
        async reset() {},
        async getStats() {
          return {
            totalMessages: 0,
            totalSummaryNodes: 0,
            maxDepth: 0,
          };
        },
        async destroy() {},
        judge: {
          async score() {
            return 0.75;
          },
          async scoreWithMetrics(question, predicted, expected) {
            assert.equal(question, "What happened?");
            assert.equal(predicted, "It happened.");
            assert.equal(expected, "It happened.");
            return {
              score: 0.75,
              tokens: { input: 12, output: 4 },
              latencyMs: 50,
              model: "judge-model",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(result.results.tasks[0]?.scores.llm_judge, 0.75);
    assert.equal(result.results.tasks[0]?.tokens.input, 12);
    assert.equal(result.results.tasks[0]?.tokens.output, 4);
    assert.equal(result.results.tasks[0]?.details?.judgeModel, "judge-model");
    assert.ok(
      (result.results.tasks[0]?.latencyMs ?? 0) >= 50,
      `expected task latency to include the reported judge latency, received ${result.results.tasks[0]?.latencyMs}`,
    );
    assert.equal(
      result.cost.totalLatencyMs,
      result.results.tasks[0]?.latencyMs,
    );
    assert.equal(
      result.cost.meanQueryLatencyMs,
      result.results.tasks[0]?.latencyMs,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("custom benchmark latency includes fallback judge wall time", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-custom-bench-"));
  const benchmarkPath = path.join(tempDir, "latency-fallback.yaml");

  try {
    await writeFile(
      benchmarkPath,
      [
        "name: Custom Latency Fallback",
        "scoring: llm_judge",
        "tasks:",
        "  - question: What happened?",
        "    expected: It happened.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runCustomBenchmarkFile(benchmarkPath, {
      mode: "quick",
      system: {
        async store() {},
        async recall() {
          return "";
        },
        async search(query) {
          assert.equal(query, "What happened?");
          return [
            {
              turnIndex: 0,
              role: "assistant",
              snippet: "It happened.",
              sessionId: "session-1",
            },
          ];
        },
        async reset() {},
        async getStats() {
          return {
            totalMessages: 0,
            totalSummaryNodes: 0,
            maxDepth: 0,
          };
        },
        async destroy() {},
        judge: {
          async score(question, predicted, expected) {
            assert.equal(question, "What happened?");
            assert.equal(predicted, "It happened.");
            assert.equal(expected, "It happened.");
            await delay(20);
            return 0.75;
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(result.results.tasks[0]?.scores.llm_judge, 0.75);
    assert.ok(
      (result.results.tasks[0]?.latencyMs ?? 0) >= 20,
      `expected task latency to include fallback judge wall time, received ${result.results.tasks[0]?.latencyMs}`,
    );
    assert.equal(
      result.cost.totalLatencyMs,
      result.results.tasks[0]?.latencyMs,
    );
    assert.equal(
      result.cost.meanQueryLatencyMs,
      result.results.tasks[0]?.latencyMs,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
