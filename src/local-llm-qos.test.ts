import assert from "node:assert/strict";
import test from "node:test";

import { LocalLlmClient, type LocalLlmRequestPriority } from "./local-llm.js";
import { initLogger } from "./logger.js";
import type { PluginConfig } from "./types.js";

function createConfig(): PluginConfig {
  return {
    localLlmEnabled: true,
    localLlmModel: "test-local-model",
    localLlmUrl: "http://127.0.0.1:1234",
    localLlmTimeoutMs: 1_000,
    localLlmRetry5xxCount: 0,
    localLlmRetryBackoffMs: 1,
    localLlmHeaders: {},
    localLlmApiKey: undefined,
    localLlmAuthHeader: false,
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 60_000,
    debug: false,
    slowLogEnabled: false,
    slowLogThresholdMs: 1_000,
  } as unknown as PluginConfig;
}

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("LocalLlmClient prioritizes recall-critical requests ahead of background queue work", async () => {
  const client = new LocalLlmClient(createConfig());
  const executionOrder: Array<{ operation?: string; priority?: LocalLlmRequestPriority }> = [];

  (client as any).runChatCompletionRequest = async (
    messages: Array<{ role: string; content: string }>,
    options: { operation?: string; priority?: LocalLlmRequestPriority },
  ) => {
    executionOrder.push({ operation: options.operation, priority: options.priority });
    return {
      content: messages[0]?.content ?? "",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  };

  const backgroundPromise = client.chatCompletion(
    [{ role: "user", content: "background" }],
    { operation: "background-op", priority: "background" },
  );
  const criticalPromise = client.chatCompletion(
    [{ role: "user", content: "critical" }],
    { operation: "critical-op", priority: "recall-critical" },
  );

  const [backgroundResult, criticalResult] = await Promise.all([backgroundPromise, criticalPromise]);

  assert.equal(backgroundResult?.content, "background");
  assert.equal(criticalResult?.content, "critical");
  assert.deepEqual(executionOrder, [
    { operation: "critical-op", priority: "recall-critical" },
    { operation: "background-op", priority: "background" },
  ]);
});

test("LocalLlmClient keeps default chatCompletion behavior for untagged requests", async () => {
  const client = new LocalLlmClient(createConfig());
  const executionOrder: string[] = [];

  (client as any).runChatCompletionRequest = async (
    messages: Array<{ role: string; content: string }>,
    options: { operation?: string },
  ) => {
    executionOrder.push(options.operation ?? "unspecified");
    return {
      content: messages[0]?.content ?? "",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  };

  const result = await client.chatCompletion(
    [{ role: "user", content: "untagged" }],
    { operation: "untagged-op" },
  );

  assert.equal(result?.content, "untagged");
  assert.deepEqual(executionOrder, ["untagged-op"]);
});

test("LocalLlmClient logs queue wait time by priority", async () => {
  const logs: string[] = [];
  initLogger(
    {
      info(msg: string) {
        logs.push(`info:${msg}`);
      },
      warn(msg: string) {
        logs.push(`warn:${msg}`);
      },
      error(msg: string) {
        logs.push(`error:${msg}`);
      },
      debug(msg: string) {
        logs.push(`debug:${msg}`);
      },
    },
    true,
  );

  const client = new LocalLlmClient(createConfig());
  (client as any).isAvailable = true;
  (client as any).lastHealthCheck = Date.now();

  const fetchOrder: string[] = [];
  const pendingResolvers: Array<(response: Response) => void> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? "{}")) as {
      messages?: Array<{ content?: string }>;
    };
    const label = body.messages?.[0]?.content ?? "unknown";
    fetchOrder.push(label);
    return await new Promise<Response>((resolve) => {
      pendingResolvers.push((response) => resolve(response));
    });
  }) as typeof fetch;

  try {
    const backgroundPromise = client.chatCompletion(
      [{ role: "user", content: "background" }],
      { operation: "background-op", priority: "background" },
    );
    const criticalPromise = client.chatCompletion(
      [{ role: "user", content: "critical" }],
      { operation: "critical-op", priority: "recall-critical" },
    );

    await tick();
    assert.deepEqual(fetchOrder, ["critical"]);
    assert.match(
      logs.join("\n"),
      /local LLM queue start: priority=recall-critical waitMs=\d+ op=critical-op/,
    );

    const firstResolve = pendingResolvers.shift();
    assert.ok(firstResolve);
    firstResolve!(okResponse("critical"));

    await tick();
    assert.deepEqual(fetchOrder, ["critical", "background"]);
    assert.match(
      logs.join("\n"),
      /local LLM queue start: priority=background waitMs=\d+ op=background-op/,
    );

    const secondResolve = pendingResolvers.shift();
    assert.ok(secondResolve);
    secondResolve!(okResponse("background"));

    const [backgroundResult, criticalResult] = await Promise.all([
      backgroundPromise,
      criticalPromise,
    ]);
    assert.equal(backgroundResult?.content, "background");
    assert.equal(criticalResult?.content, "critical");
    assert.match(
      logs.join("\n"),
      /local LLM queue finish: priority=background waitMs=\d+ runMs=\d+ totalMs=\d+ op=background-op/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
