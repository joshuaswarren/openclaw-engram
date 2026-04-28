import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
          bearerToken: "bearer-token",
          privateKey: "private-key",
          sessionToken: "session-token",
          authorization: "Bearer auth-header",
          token: "plain-token",
          secretary: "office-role",
          passwordless: true,
          credentialingOrg: "board",
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
  assert.equal(
    (redacted.config.remnicConfig.nested as { bearerToken?: string }).bearerToken,
    "[REDACTED]",
  );
  assert.equal(
    (redacted.config.remnicConfig.nested as { privateKey?: string }).privateKey,
    "[REDACTED]",
  );
  assert.equal(
    (redacted.config.remnicConfig.nested as { sessionToken?: string }).sessionToken,
    "[REDACTED]",
  );
  assert.equal(
    (redacted.config.remnicConfig.nested as { authorization?: string }).authorization,
    "[REDACTED]",
  );
  assert.equal(
    (redacted.config.remnicConfig.nested as { token?: string }).token,
    "[REDACTED]",
  );
  assert.equal(
    (redacted.config.remnicConfig.nested as { secretary?: string }).secretary,
    "office-role",
  );
  assert.equal(
    (redacted.config.remnicConfig.nested as { passwordless?: boolean }).passwordless,
    true,
  );
  assert.equal(
    (redacted.config.remnicConfig.nested as { credentialingOrg?: string })
      .credentialingOrg,
    "board",
  );
  assert.equal(redacted.config.systemProvider?.provider, "ollama");
  assert.equal(redacted.config.systemProvider?.model, "gemma4:31b-cloud");
});

test("writeBenchmarkResult does not persist secret values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-reporter-"));
  try {
    const filePath = await writeBenchmarkResult(buildResult(), dir);
    const raw = await readFile(filePath, "utf8");

    assert.doesNotMatch(
      raw,
      /system-secret-key|judge-secret-key|nested-token|bearer-token|private-key|session-token|auth-header|plain-token/,
    );
    assert.match(raw, /"apiKey": "\[REDACTED\]"/);
    assert.match(raw, /"provider": "ollama"/);
    assert.match(raw, /"secretary": "office-role"/);
    assert.match(raw, /"credentialingOrg": "board"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeBenchmarkResult preserves main result when leaderboard sidecar write fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-reporter-"));
  try {
    await writeFile(path.join(dir, "leaderboard"), "not a directory", "utf8");
    const result = buildResult();
    result.results.tasks = [
      {
        taskId: "ama-q1",
        question: "What happened?",
        expected: "opened the app",
        actual: "opened the app",
        scores: { llm_judge: 1 },
        latencyMs: 1,
        tokens: { input: 0, output: 0 },
        details: { episodeId: 1 },
      },
    ];

    const filePath = await writeBenchmarkResult(result, dir);
    const raw = await readFile(filePath, "utf8");

    assert.match(raw, /"benchmark": "ama-bench"/);
    assert.match(raw, /"format": "leaderboard-artifact-error"/);
    assert.match(raw, /"records": 0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
