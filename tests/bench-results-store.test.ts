import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import {
  defaultBenchmarkBaselineDir,
  listBenchmarkBaselines,
  listBenchmarkResults,
  loadBenchmarkBaseline,
  loadBenchmarkResult,
  renderBenchmarkResultExport,
  resolveBenchmarkResultReference,
  saveBenchmarkBaseline,
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

test("loadBenchmarkResult rejects incomplete benchmark result payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-incomplete-"));
  const invalidPath = path.join(root, "incomplete.json");
  await writeFile(
    invalidPath,
    JSON.stringify({
      meta: {
        id: "incomplete-run",
        benchmark: "longmemeval",
        timestamp: "2026-04-18T00:00:00.000Z",
        mode: "full",
      },
    }),
  );

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

test("resolveBenchmarkResultReference falls back to id matching when a same-named direct path is invalid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-fallback-"));
  const storedPath = path.join(root, "stored.json");
  await writeFile(
    storedPath,
    `${JSON.stringify(buildResult("candidate-run", "2026-04-18T03:00:00.000Z"))}\n`,
  );

  const cwd = process.cwd();
  const conflictingPath = path.join(root, "candidate-run");
  await writeFile(conflictingPath, "not benchmark json");

  try {
    process.chdir(root);
    const resolved = await resolveBenchmarkResultReference(root, "candidate-run");
    assert.equal(resolved?.id, "candidate-run");
    assert.equal(resolved?.path, storedPath);
  } finally {
    process.chdir(cwd);
  }
});

test("saveBenchmarkBaseline persists a named baseline and listBenchmarkBaselines returns newest first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-baselines-"));
  const firstPath = await saveBenchmarkBaseline(
    root,
    "main",
    buildResult("run-main", "2026-04-18T04:00:00.000Z"),
    { id: "run-main", path: "/tmp/run-main.json" },
  );

  await new Promise((resolve) => setTimeout(resolve, 5));

  const secondPath = await saveBenchmarkBaseline(
    root,
    "candidate",
    buildResult("run-candidate", "2026-04-18T05:00:00.000Z"),
    { id: "run-candidate", path: "/tmp/run-candidate.json" },
  );

  const stored = await loadBenchmarkBaseline(firstPath);
  const listed = await listBenchmarkBaselines(root);

  assert.equal(stored.name, "main");
  assert.equal(stored.source?.id, "run-main");
  assert.equal(listed[0]?.name, "candidate");
  assert.equal(listed[0]?.path, secondPath);
  assert.equal(listed[1]?.name, "main");
});

test("saveBenchmarkBaseline rejects invalid baseline names instead of sanitizing them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-baseline-invalid-"));

  await assert.rejects(
    () => saveBenchmarkBaseline(root, "main branch", buildResult("run-main", "2026-04-18T06:00:00.000Z")),
    /Invalid baseline name/,
  );
});

test("listBenchmarkBaselines rejects baseline paths that exist as files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-baseline-file-list-"));
  const baselinePath = path.join(root, "baselines.json");
  await writeFile(baselinePath, "not a directory");

  await assert.rejects(
    () => listBenchmarkBaselines(baselinePath),
    /Invalid benchmark baseline directory: .* is not a directory\./,
  );
});

test("saveBenchmarkBaseline rejects baseline paths that exist as files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-baseline-file-save-"));
  const baselinePath = path.join(root, "baselines.json");
  await writeFile(baselinePath, "not a directory");

  await assert.rejects(
    () => saveBenchmarkBaseline(
      baselinePath,
      "main",
      buildResult("run-main", "2026-04-18T06:30:00.000Z"),
    ),
    /Invalid benchmark baseline directory: .* is not a directory\./,
  );
});

test("defaultBenchmarkBaselineDir resolves under the Remnic home directory", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const customHomeDir = path.join(path.sep, "tmp", "remnic-home");

  process.env.HOME = customHomeDir;
  delete process.env.USERPROFILE;

  try {
    const baselineDir = defaultBenchmarkBaselineDir();
    assert.equal(
      baselineDir,
      path.join(customHomeDir, ".remnic", "bench", "baselines"),
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("renderBenchmarkResultExport returns JSON and aggregate-metric CSV representations", () => {
  const result = buildResult("candidate-run", "2026-04-18T07:00:00.000Z");
  result.results.aggregates = {
    answerAccuracy: {
      mean: 0.8,
      median: 0.8,
      stdDev: 0.1,
      min: 0.6,
      max: 0.9,
    },
  };

  const json = renderBenchmarkResultExport(result, "json");
  const csv = renderBenchmarkResultExport(result, "csv");
  const html = renderBenchmarkResultExport(result, "html");

  assert.match(json, /"candidate-run"/);
  assert.match(csv, /^result_id,benchmark,timestamp,mode,metric,mean,median,std_dev,min,max$/m);
  assert.match(csv, /candidate-run,longmemeval,2026-04-18T07:00:00.000Z,full,answerAccuracy,0.8,0.8,0.1,0.6,0.9/);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<title>Remnic Bench Report: longmemeval<\/title>/);
  assert.match(html, /candidate-run/);
  assert.match(html, /answerAccuracy/);
  assert.match(html, /Aggregate Metrics/);
  assert.match(html, /Task Count/);
});
