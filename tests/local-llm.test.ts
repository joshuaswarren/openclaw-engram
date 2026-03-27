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

test("LocalLlmClient checkAvailability sends auth headers to health probes", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlmApiKey: "top-secret" }));
  const originalFetch = globalThis.fetch;
  const authHeaders: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    authHeaders.push(headers.get("authorization") ?? "");
    return new Response("Ollama", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, true);
    assert.deepEqual(authHeaders, ["Bearer top-secret"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient trips plain-text backend failures using configured cooldown", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlm400CooldownMs: 25 }));
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("Failed to load model", {
      status: 503,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

  try {
    const out = await client.chatCompletion([{ role: "user", content: "hello" }], {
      operation: "entity_summary",
    });
    assert.equal(out, null);
    const state = (client as any).getGlobalBackendState().get((client as any).getBackendKey());
    assert.ok(state);
    assert.match(state.reason, /Failed to load model/i);
    assert.ok(state.untilMs > Date.now());
  } finally {
    (client as any).getGlobalBackendState().delete((client as any).getBackendKey());
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient warns when authenticated availability probes are unauthorized", async () => {
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

  const client = new LocalLlmClient(buildConfig({ localLlmApiKey: "wrong-key" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("Unauthorized", {
      status: 401,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, false);
    assert.ok(
      warns.some((msg) => msg.includes("availability probe was unauthorized")),
      "expected unauthorized health probe warning",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient does not retry non-recoverable 5xx backend failures", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlm400CooldownMs: 25, localLlmRetry5xxCount: 3 }));
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("Failed to load model", {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;

  try {
    const out = await client.chatCompletion([{ role: "user", content: "hello" }], {
      operation: "entity_summary",
    });
    assert.equal(out, null);
    assert.equal(calls, 1);
    const state = (client as any).getGlobalBackendState().get((client as any).getBackendKey());
    assert.ok(state);
    assert.match(state.reason, /Failed to load model/i);
    assert.ok(state.untilMs > Date.now());
  } finally {
    (client as any).getGlobalBackendState().delete((client as any).getBackendKey());
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient probes immediately after zero-duration backend trip", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlm400CooldownMs: 0 }));
  (client as any).isAvailable = false;
  (client as any).lastHealthCheck = Date.now();
  (client as any).markBackendUnavailable("Failed to load model", 0);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        data: [{ id: "local-test-model" }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const available = await client.checkAvailability();
    assert.equal(available, true);
    assert.ok(fetchCalls > 0, "expected an immediate availability probe after circuit expiry");
  } finally {
    (client as any).getGlobalBackendState().delete((client as any).getBackendKey());
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient shares backend circuit state across models on equivalent endpoint URLs", () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const primary = new LocalLlmClient(
    buildConfig({ localLlmModel: "primary-model", localLlmUrl: "http://127.0.0.1:1234/v1" }),
  );
  const fast = new LocalLlmClient(
    buildConfig({ localLlmModel: "fast-model", localLlmUrl: "http://127.0.0.1:1234" }),
  );

  (primary as any).markBackendUnavailable("Failed to load model", 25);

  try {
    assert.equal((primary as any).getBackendKey(), (fast as any).getBackendKey());
    const sharedState = (fast as any).getTrippedBackendState(Date.now());
    assert.ok(sharedState);
    assert.equal(sharedState.reason, "Failed to load model");
  } finally {
    (primary as any).getGlobalBackendState().delete((primary as any).getBackendKey());
  }
});

test("LocalLlmClient stores a matched backend failure reason instead of raw error text", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlm400CooldownMs: 25 }));
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("Internal error while loading backend. Failed to load model due to Team IDs mismatch.", {
      status: 503,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;

  try {
    const out = await client.chatCompletion([{ role: "user", content: "hello" }], {
      operation: "entity_summary",
    });
    assert.equal(out, null);
    const state = (client as any).getGlobalBackendState().get((client as any).getBackendKey());
    assert.ok(state);
    assert.equal(state.reason, "Failed to load model");
  } finally {
    (client as any).getGlobalBackendState().delete((client as any).getBackendKey());
    globalThis.fetch = originalFetch;
  }
});

test("LocalLlmClient clears peer health cache while a shared backend circuit is open", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const primary = new LocalLlmClient(buildConfig({ localLlmModel: "primary-model" }));
  const peer = new LocalLlmClient(buildConfig({ localLlmModel: "peer-model" }));
  (peer as any).isAvailable = false;
  (peer as any).lastHealthCheck = Date.now();
  (primary as any).markBackendUnavailable("Failed to load model", 25);

  try {
    const available = await peer.checkAvailability();
    assert.equal(available, false);
    assert.equal((peer as any).lastHealthCheck, 0);
  } finally {
    (primary as any).getGlobalBackendState().delete((primary as any).getBackendKey());
  }
});

test("LocalLlmClient getLoadedModelInfo sends auth headers to models probe", async () => {
  initLogger(
    {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    true,
  );

  const client = new LocalLlmClient(buildConfig({ localLlmApiKey: "top-secret" }));
  const originalFetch = globalThis.fetch;
  let authHeader = "";
  globalThis.fetch = (async (_input, init) => {
    authHeader = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(
      JSON.stringify({
        data: [{ id: "local-test-model", max_context_length: 32768 }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const modelInfo = await client.getLoadedModelInfo();
    assert.ok(modelInfo);
    assert.equal(modelInfo.id, "local-test-model");
    assert.equal(authHeader, "Bearer top-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
