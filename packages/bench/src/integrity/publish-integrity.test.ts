import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  assertPublishableIntegrity,
  buildBenchmarkPublishFeed,
} from "../results-store.ts";
import type { BenchmarkResult } from "../types.ts";
import { hashString } from "./hash-verification.ts";
import type { ContaminationManifest } from "./contamination.ts";

function buildResult(
  id: string,
  overrides: Partial<BenchmarkResult["meta"]> = {},
): BenchmarkResult {
  return {
    meta: {
      id,
      benchmark: "longmemeval",
      benchmarkTier: "published",
      version: "1.0.0",
      remnicVersion: "9.3.56",
      gitSha: "abc1234",
      timestamp: "2026-04-18T00:00:00.000Z",
      mode: "full",
      runCount: 5,
      seeds: [0, 1, 2, 3, 4],
      splitType: "holdout",
      qrelsSealedHash: hashString("qrels"),
      judgePromptHash: hashString("judge"),
      datasetHash: hashString("dataset"),
      canaryScore: 0.02,
      ...overrides,
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
    environment: { os: "linux", nodeVersion: process.version },
  };
}

test("assertPublishableIntegrity throws when qrelsSealedHash is missing", () => {
  const result = buildResult("missing-qrels", {
    qrelsSealedHash: undefined,
  });
  assert.throws(() => assertPublishableIntegrity(result, "remnic-ai"), /qrelsSealedHash/);
});

test("assertPublishableIntegrity rejects public split for the leaderboard", () => {
  const result = buildResult("public-split", { splitType: "public" });
  assert.throws(
    () => assertPublishableIntegrity(result, "remnic-ai"),
    /only accepts holdout-split/,
  );
});

test("buildBenchmarkPublishFeed omits results with missing integrity by throwing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-integrity-publish-"));
  const incomplete = buildResult("incomplete", { datasetHash: undefined });
  await writeFile(path.join(dir, "incomplete.json"), JSON.stringify(incomplete));

  await assert.rejects(
    () => buildBenchmarkPublishFeed(dir, "remnic-ai"),
    /integrity metadata is incomplete/,
  );
});

test("buildBenchmarkPublishFeed emits integrity block for holdout results", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-integrity-holdout-"));
  const ok = buildResult("holdout-run");
  await writeFile(path.join(dir, "holdout.json"), JSON.stringify(ok));

  const feed = await buildBenchmarkPublishFeed(dir, "remnic-ai");
  assert.equal(feed.benchmarks.length, 1);
  const entry = feed.benchmarks[0]!;
  assert.equal(entry.integrity.splitType, "holdout");
  assert.equal(entry.integrity.qrelsSealedHash, hashString("qrels"));
  assert.equal(entry.integrity.canaryScore, 0.02);
});

test("buildBenchmarkPublishFeed refuses contaminated datasets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-integrity-contam-"));
  const contaminatedHash = hashString("dataset");
  const result = buildResult("contaminated", { datasetHash: contaminatedHash });
  await writeFile(path.join(dir, "contaminated.json"), JSON.stringify(result));

  const manifest: ContaminationManifest = {
    version: 1,
    entries: [
      {
        datasetHash: contaminatedHash,
        reason: "Included in public training corpus",
        addedAt: "2026-04-17T00:00:00.000Z",
      },
    ],
  };

  await assert.rejects(
    () => buildBenchmarkPublishFeed(dir, "remnic-ai", { contaminationManifest: manifest }),
    /contamination manifest/,
  );
});
