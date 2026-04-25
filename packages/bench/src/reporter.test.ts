import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { redactBenchmarkResultSecrets, writeBenchmarkResult } from "./reporter.ts";
import type { BenchmarkResult } from "./types.js";

function buildResult(): BenchmarkResult {
  return {
    meta: {
      id: "result-1",
      benchmark: "ama-bench",
      benchmarkTier: "published",
      version: "1.0.0",
      remnicVersion: "9.3.169",
      gitSha: "deadbeef",
      timestamp: "2026-04-25T02:52:05.982Z",
      mode: "full",
      runCount: 1,
      seeds: [0],
    },
    config: {
      runtimeProfile: "real",
      systemProvider: {
        provider: "ollama",
        model: "gemma4:31b-cloud",
        baseUrl: "https://ollama.com/api",
        apiKey: "system-secret-key",
      },
      judgeProvider: {
        provider: "ollama",
        model: "gemma4:31b-cloud",
        baseUrl: "https://ollama.com/api",
        apiKey: "judge-secret-key",
      },
      adapterMode: "direct",
      remnicConfig: {
        nested: {
          authToken: "nested-token",
        },
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
      os: process.platform,
      nodeVersion: process.version,
    },
  };
}

test("redactBenchmarkResultSecrets redacts provider and nested secret fields", () => {
  const redacted = redactBenchmarkResultSecrets(buildResult());

  assert.equal(redacted.config.systemProvider?.apiKey, "[REDACTED]");
  assert.equal(redacted.config.judgeProvider?.apiKey, "[REDACTED]");
  assert.equal(
    (redacted.config.remnicConfig.nested as { authToken?: string }).authToken,
    "[REDACTED]",
  );
  assert.equal(redacted.config.systemProvider?.provider, "ollama");
  assert.equal(redacted.config.systemProvider?.model, "gemma4:31b-cloud");
});

test("writeBenchmarkResult does not persist secret values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-reporter-"));
  try {
    const filePath = await writeBenchmarkResult(buildResult(), dir);
    const raw = await readFile(filePath, "utf8");

    assert.doesNotMatch(raw, /system-secret-key|judge-secret-key|nested-token/);
    assert.match(raw, /"apiKey": "\[REDACTED\]"/);
    assert.match(raw, /"provider": "ollama"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
