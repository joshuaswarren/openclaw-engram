import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import {
  listBenchmarkResults,
  loadBenchmarkResult,
  resolveBenchmarkResultReference,
} from "../packages/bench/src/results-store.ts";
import type { BenchmarkResult } from "../packages/bench/src/types.ts";

function buildResult(
  id: string,
  timestamp: string,
  benchmark = "longmemeval",
): BenchmarkResult {
  return {
    meta: {
      id,
      benchmark,
      benchmarkTier: "published",
      version: "1.0.0",
      remnicVersion: "9.3.35",
      gitSha: "abc1234",
      timestamp,
      mode: "full",
      runCount: 5,
      seeds: [0, 1, 2, 3, 4],
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "lightweight",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: {
      tasks: [],
      aggregates: {},
    },
    environment: {
      os: "darwin",
      nodeVersion: process.version,
    },
  };
}

test("listBenchmarkResults sorts valid result files newest first and skips invalid JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-results-"));
  await mkdir(root, { recursive: true });

  const olderPath = path.join(root, "older.json");
  const newerPath = path.join(root, "newer.json");
  await writeFile(
    olderPath,
    `${JSON.stringify(buildResult("run-older", "2026-04-18T00:00:00.000Z"))}\n`,
  );
  await writeFile(
    newerPath,
    `${JSON.stringify(buildResult("run-newer", "2026-04-18T01:00:00.000Z"))}\n`,
  );
  await writeFile(path.join(root, "broken.json"), "{not json\n");

  const listed = await listBenchmarkResults(root);
  assert.deepEqual(
    listed.map((entry) => entry.id),
    ["run-newer", "run-older"],
  );
});

test("loadBenchmarkResult rejects invalid benchmark result files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-load-"));
  const invalidPath = path.join(root, "invalid.json");
  await writeFile(invalidPath, JSON.stringify({ hello: "world" }));

  await assert.rejects(
    () => loadBenchmarkResult(invalidPath),
    /Invalid benchmark result file/,
  );
});

test("resolveBenchmarkResultReference matches by id, basename, or direct path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-resolve-"));
  const filePath = path.join(root, "candidate.json");
  await writeFile(
    filePath,
    `${JSON.stringify(buildResult("candidate-run", "2026-04-18T02:00:00.000Z"))}\n`,
  );

  const byId = await resolveBenchmarkResultReference(root, "candidate-run");
  const byBasename = await resolveBenchmarkResultReference(root, "candidate.json");
  const byPath = await resolveBenchmarkResultReference(root, filePath);

  assert.equal(byId?.id, "candidate-run");
  assert.equal(byBasename?.id, "candidate-run");
  assert.equal(byPath?.path, filePath);
});
