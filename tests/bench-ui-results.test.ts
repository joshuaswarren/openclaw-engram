import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildProviderRows,
  getBenchmarkCards,
  type BenchResultSummaryPayload,
} from "../packages/bench-ui/src/bench-data.js";
import { loadBenchResultSummaries } from "../packages/bench-ui/src/results.js";

test("bench UI loader summarizes valid benchmark JSON files and ignores invalid entries", async () => {
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-"));

  await writeFile(
    path.join(resultsDir, "latest.json"),
    JSON.stringify({
      meta: {
        id: "latest-run",
        benchmark: "longmemeval",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
      },
      cost: {
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
      },
      results: {
        tasks: [{ taskId: "task-1" }, { taskId: "task-2" }],
        aggregates: {
          accuracy: { mean: 0.75 },
          f1: { mean: 0.63 },
          llm_judge: { mean: 0.9 },
          ignored: { mean: "bad" },
        },
      },
    }, null, 2),
  );

  await writeFile(
    path.join(resultsDir, "older.json"),
    JSON.stringify({
      meta: {
        id: "older-run",
        benchmark: "ama-bench",
        timestamp: "2026-04-17T10:00:00.000Z",
        mode: "full",
      },
      cost: {
        totalLatencyMs: 99,
        meanQueryLatencyMs: 33,
      },
      results: {
        tasks: [],
        aggregates: {},
      },
    }, null, 2),
  );

  await writeFile(path.join(resultsDir, "broken.json"), "{oops");
  await mkdir(path.join(resultsDir, "nested"));

  const payload = await loadBenchResultSummaries(resultsDir);

  assert.equal(payload.resultsDir, resultsDir);
  assert.equal(payload.summaries.length, 2);
  assert.deepEqual(payload.summaries.map((summary) => summary.id), [
    "latest-run",
    "older-run",
  ]);
  assert.equal(payload.summaries[0]?.taskCount, 2);
  assert.deepEqual(payload.summaries[0]?.metricHighlights, [
    { name: "accuracy", mean: 0.75 },
    { name: "f1", mean: 0.63 },
    { name: "llm_judge", mean: 0.9 },
  ]);
});

test("bench UI loader returns an empty payload when the results directory is missing", async () => {
  const resultsDir = path.join(os.tmpdir(), "remnic-bench-ui-missing");
  const payload = await loadBenchResultSummaries(resultsDir);

  assert.equal(payload.resultsDir, resultsDir);
  assert.deepEqual(payload.summaries, []);
});

test("getBenchmarkCards keeps delta null when a benchmark has only one run", () => {
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [
      {
        id: "latest-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.75 }],
        primaryMetric: "accuracy",
        primaryScore: 0.75,
        runCount: 1,
        estimatedCostUsd: 0.12,
        totalTokens: 100,
        inputTokens: 60,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        filePath: "/tmp/results/latest-run.json",
      },
    ],
  };

  const cards = getBenchmarkCards(payload);

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.previous, null);
  assert.equal(cards[0]?.delta, null);
});

test("benchmark detail renders single-run task deltas as null", async () => {
  const source = await readFile("packages/bench-ui/src/pages/BenchmarkDetail.tsx", "utf8");

  assert.match(source, /delta:\s*null,/);
});

test("compare view guards against cross-benchmark run pairs", async () => {
  const source = await readFile("packages/bench-ui/src/pages/Compare.tsx", "utf8");

  assert.match(source, /summary\.benchmark === baselineSummary\.benchmark/);
  assert.match(source, /baselineSummary\.benchmark === candidateSummary\.benchmark/);
  assert.match(source, /setCandidateId\(""\)/);
});

test("buildProviderRows keeps the newest benchmark score for each provider", () => {
  const payload: BenchResultSummaryPayload = {
    resultsDir: "/tmp/results",
    summaries: [
      {
        id: "latest-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-18T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1234,
        meanQueryLatencyMs: 617,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.91 }],
        primaryMetric: "accuracy",
        primaryScore: 0.91,
        runCount: 1,
        estimatedCostUsd: 0.14,
        totalTokens: 110,
        inputTokens: 70,
        outputTokens: 40,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        filePath: "/tmp/results/latest-run.json",
      },
      {
        id: "older-run",
        benchmark: "longmemeval",
        benchmarkTier: "published",
        timestamp: "2026-04-17T10:00:00.000Z",
        mode: "quick",
        totalLatencyMs: 1400,
        meanQueryLatencyMs: 700,
        taskCount: 2,
        metricHighlights: [{ name: "accuracy", mean: 0.42 }],
        primaryMetric: "accuracy",
        primaryScore: 0.42,
        runCount: 1,
        estimatedCostUsd: 0.18,
        totalTokens: 120,
        inputTokens: 75,
        outputTokens: 45,
        systemProvider: "openai/gpt-5.4",
        judgeProvider: "openai/gpt-5.4-mini",
        providerKey: "openai/gpt-5.4__openai/gpt-5.4-mini",
        adapterMode: "standalone",
        aggregateMetrics: [],
        taskSummaries: [],
        filePath: "/tmp/results/older-run.json",
      },
    ],
  };

  const rows = buildProviderRows(payload);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.benchmarkScores.longmemeval, 0.91);
  assert.equal(rows[0]?.runCount, 2);
  assert.equal(rows[0]?.averageScore, (0.91 + 0.42) / 2);
  assert.equal(rows[0]?.averageCostUsd, (0.14 + 0.18) / 2);
});
