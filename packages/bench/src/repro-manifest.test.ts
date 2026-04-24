import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import {
  BENCHMARK_REPRO_MANIFEST_FILENAME,
  buildBenchmarkReproManifest,
  writeBenchmarkReproManifest,
} from "./repro-manifest.ts";
import type { BenchmarkResult } from "./types.js";

function buildResult(): BenchmarkResult {
  return {
    meta: {
      id: "run-1",
      benchmark: "longmemeval",
      benchmarkTier: "published",
      version: "1.0.0",
      remnicVersion: "9.3.167",
      gitSha: "abc1234",
      timestamp: "2026-04-24T20:00:00.000Z",
      mode: "full",
      runCount: 5,
      seeds: [42, 43, 44, 45, 46],
    },
    config: {
      runtimeProfile: "real",
      systemProvider: {
        provider: "openai",
        model: "gemma4:31b",
        baseUrl: "https://ollama.com/v1",
      },
      judgeProvider: null,
      adapterMode: "direct",
      remnicConfig: {
        qmdCollection: "bench-hot",
        qmdColdCollection: "bench-cold",
        conversationIndexQmdCollection: "bench-conversations",
      },
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
      hardware: process.arch,
    },
  };
}

test("buildBenchmarkReproManifest hashes datasets/results and redacts secret argv values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-repro-manifest-"));
  const resultsDir = path.join(root, "results");
  const datasetDir = path.join(root, "dataset");
  await mkdir(resultsDir, { recursive: true });
  await mkdir(path.join(datasetDir, "nested"), { recursive: true });
  await writeFile(path.join(datasetDir, "answers.json"), JSON.stringify({ answer: 42 }), "utf8");
  await writeFile(path.join(datasetDir, "nested", "notes.txt"), "dataset note\n", "utf8");
  await symlink("answers.json", path.join(datasetDir, "answers-link.json"));

  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifest = await buildBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
    runtimeProfiles: ["real"],
    mode: "full",
    seed: 42,
    datasetDirs: { longmemeval: datasetDir },
    command: {
      cwd: root,
      argv: [
        "bench",
        "run",
        "fixtures/token-benchmark.json",
        "--system-api-key",
        "secret-value",
        "--judge-api-key=other-secret",
        "next-positional",
      ],
      env: { OLLAMA_API_KEY: "secret-value", QMD_CONFIG_DIR: "/tmp/qmd" },
      envKeys: ["OLLAMA_API_KEY", "QMD_CONFIG_DIR"],
    },
    qmd: { configDir: "/tmp/qmd" },
  });

  assert.equal(manifest.run.mode, "full");
  assert.deepEqual(manifest.run.runtimeProfiles, ["real"]);
  assert.equal(manifest.run.seed, 42);
  assert.deepEqual(manifest.command.argv, [
    "bench",
    "run",
    "fixtures/token-benchmark.json",
    "--system-api-key",
    "[redacted]",
    "--judge-api-key=[redacted]",
    "next-positional",
  ]);
  assert.deepEqual(manifest.command.envKeys, ["OLLAMA_API_KEY", "QMD_CONFIG_DIR"]);
  assert.equal(manifest.datasets[0]?.status, "hashed");
  assert.equal(manifest.datasets[0]?.fileCount, 3);
  assert.ok(manifest.datasets[0]?.sha256);
  assert.equal(manifest.results[0]?.benchmark, "longmemeval");
  assert.equal(manifest.results[0]?.seeds.length, 5);
  assert.deepEqual(manifest.qmd?.collections, [
    "bench-cold",
    "bench-conversations",
    "bench-hot",
  ]);
  assert.ok(/^[0-9a-f]{64}$/.test(manifest.artifactHash));
  assert.doesNotMatch(JSON.stringify(manifest), /secret-value|other-secret/);
});

test("writeBenchmarkReproManifest writes MANIFEST.json beside results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-repro-manifest-write-"));
  const resultsDir = path.join(root, "results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, "longmemeval.json");
  await writeFile(resultPath, `${JSON.stringify(buildResult(), null, 2)}\n`, "utf8");

  const manifestPath = await writeBenchmarkReproManifest(resultsDir, {
    resultPaths: [resultPath],
    selectedBenchmarks: ["longmemeval"],
  });
  assert.equal(manifestPath, path.join(resultsDir, BENCHMARK_REPRO_MANIFEST_FILENAME));

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    results: Array<{ benchmark: string }>;
  };
  assert.equal(manifest.results[0]?.benchmark, "longmemeval");
});
