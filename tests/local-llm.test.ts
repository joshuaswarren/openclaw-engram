import test from "node:test";
import assert from "node:assert/strict";
import { LocalLlmClient } from "../src/local-llm.js";
import { initLogger } from "../src/logger.js";
import type { PluginConfig } from "../src/types.js";

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    localLlmEnabled: true,
    localLlmUrl: "http://127.0.0.1:1234/v1",
    localLlmModel: "local-test-model",
    localLlmFallback: true,
    localLlmTimeoutMs: 50,
    localLlmRetry5xxCount: 1,
    localLlmRetryBackoffMs: 0,
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 10_000,
    localLlmAuthHeader: true,
    debug: false,
    slowLogEnabled: false,
    slowLogThresholdMs: 30_000,
    ...overrides,
  } as PluginConfig;
}

function abortError(): Error {
  const err = new Error("This operation was aborted");
  Object.defineProperty(err, "name", { value: "AbortError" });
  return err;
}

test("LocalLlmClient retries abort errors and preserves availability", async () => {
  const warns: string[] = [];
  initLogger(
    {
      info() {},
      warn(msg: string) {
        warns.push(msg);
      },
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig());
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) throw abortError();
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const out = await client.chatCompletion(
      [{ role: "user", content: "hello" }],
      { operation: "entity_summary", maxTokens: 100 },
    );
    assert.ok(out);
    assert.equal(calls, 2);
    assert.equal((client as any).isAvailable, true);
    assert.ok(warns.some((w) => w.includes("op=entity_summary")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient abort exhaustion returns null without marking unavailable", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig());
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw abortError();
  }) as typeof fetch;

  try {
    const out = await client.chatCompletion(
      [{ role: "user", content: "hello" }],
      { operation: "extraction" },
    );
    assert.equal(out, null);
    assert.equal(calls, 2);
    assert.equal((client as any).isAvailable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
