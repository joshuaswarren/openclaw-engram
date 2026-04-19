import assert from "node:assert/strict";
import test from "node:test";

import { LocalLlmClient, type LocalLlmType } from "./local-llm.js";
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
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * Make `checkAvailability()` short-circuit on its cached hit instead
 * of probing the mock server (which could re-detect the backend type
 * as something other than what the test wants to exercise), and pin
 * both `_disableThinking` and `detectedType` to the requested values.
 */
function primeClient(
  client: LocalLlmClient,
  opts: { thinking: boolean; detected: LocalLlmType | null },
): void {
  const internals = client as unknown as {
    _disableThinking: boolean;
    detectedType: LocalLlmType | null;
    isAvailable: boolean;
    lastHealthCheck: number;
  };
  internals._disableThinking = opts.thinking;
  internals.detectedType = opts.detected;
  internals.isAvailable = true;
  internals.lastHealthCheck = Date.now();
}

function captureFetchBodies(): {
  restore: () => void;
  bodies: Array<Record<string, unknown>>;
} {
  const original = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    if (init?.body) {
      try {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      } catch {
        // ignore non-JSON bodies
      }
    }
    return okResponse("ok");
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    bodies,
  };
}

async function runOneChatCompletion(client: LocalLlmClient): Promise<void> {
  await client.chatCompletion(
    [{ role: "user", content: "hello" }],
    { maxTokens: 16 },
  );
}

test("disableThinking injects chat_template_kwargs for lmstudio backend (#548)", async () => {
  const client = new LocalLlmClient(createConfig());
  primeClient(client, { thinking: true, detected: "lmstudio" });
  const { restore, bodies } = captureFetchBodies();
  try {
    await runOneChatCompletion(client);
  } finally {
    restore();
  }
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]?.chat_template_kwargs, { enable_thinking: false });
});

test("disableThinking injects chat_template_kwargs for vllm backend (#548)", async () => {
  const client = new LocalLlmClient(createConfig());
  primeClient(client, { thinking: true, detected: "vllm" });
  const { restore, bodies } = captureFetchBodies();
  try {
    await runOneChatCompletion(client);
  } finally {
    restore();
  }
  assert.deepEqual(bodies[0]?.chat_template_kwargs, { enable_thinking: false });
});

test("disableThinking fails open for generic backend — no kwarg sent (#548 Codex P1)", async () => {
  // Regression for Codex P1 on PR #550: `chat_template_kwargs` is a
  // llama.cpp / LM-Studio / vLLM extension.  Strict OpenAI-compat
  // backends reject unknown fields with 400, which trips the
  // localLlm400Trip cooldown.  `generic` means "backend didn't
  // positively identify as thinking-capable" — do not send.
  const client = new LocalLlmClient(createConfig());
  primeClient(client, { thinking: true, detected: "generic" });
  const { restore, bodies } = captureFetchBodies();
  try {
    await runOneChatCompletion(client);
  } finally {
    restore();
  }
  assert.equal(bodies.length, 1);
  assert.equal(
    "chat_template_kwargs" in (bodies[0] ?? {}),
    false,
    "generic backend must not receive chat_template_kwargs",
  );
});

test("disableThinking fails open for ollama backend — no kwarg sent", async () => {
  const client = new LocalLlmClient(createConfig());
  primeClient(client, { thinking: true, detected: "ollama" });
  const { restore, bodies } = captureFetchBodies();
  try {
    await runOneChatCompletion(client);
  } finally {
    restore();
  }
  assert.equal("chat_template_kwargs" in (bodies[0] ?? {}), false);
});

test("disableThinking fails open when backend is undetected (null)", async () => {
  const client = new LocalLlmClient(createConfig());
  primeClient(client, { thinking: true, detected: null });
  const { restore, bodies } = captureFetchBodies();
  try {
    await runOneChatCompletion(client);
  } finally {
    restore();
  }
  assert.equal("chat_template_kwargs" in (bodies[0] ?? {}), false);
});

test("disableThinking=false never injects chat_template_kwargs, regardless of backend", async () => {
  const client = new LocalLlmClient(createConfig());
  primeClient(client, { thinking: false, detected: "lmstudio" });
  const { restore, bodies } = captureFetchBodies();
  try {
    await runOneChatCompletion(client);
  } finally {
    restore();
  }
  assert.equal("chat_template_kwargs" in (bodies[0] ?? {}), false);
});
