import test from "node:test";
import assert from "node:assert/strict";
import { buildChatCompletionTokenLimit, usesMaxCompletionTokens } from "../src/openai-chat-compat.ts";
import { parseConfig } from "../src/config.ts";
import { ExtractionEngine } from "../src/extraction.ts";
import { FallbackLlmClient } from "../src/fallback-llm.ts";
import type { GatewayConfig } from "../src/types.ts";

test("usesMaxCompletionTokens detects newer OpenAI chat-completions models", () => {
  assert.equal(usesMaxCompletionTokens("gpt-5.2"), true);
  assert.equal(usesMaxCompletionTokens("gpt-5-mini"), true);
  assert.equal(usesMaxCompletionTokens("o3-mini"), true);
  assert.equal(usesMaxCompletionTokens("gpt-4.1"), false);
  assert.equal(usesMaxCompletionTokens("llama3.2"), false);
});

test("buildChatCompletionTokenLimit selects max_completion_tokens for gpt-5 models", () => {
  assert.deepEqual(buildChatCompletionTokenLimit("gpt-5.2", 4096), {
    max_completion_tokens: 4096,
  });
  assert.deepEqual(buildChatCompletionTokenLimit("gpt-4.1", 2048), {
    max_tokens: 2048,
  });
});

test("extractWithDirectClient uses max_completion_tokens for gpt-5 chat completions", async () => {
  const engine = new ExtractionEngine(
    parseConfig({
      memoryDir: ".tmp/memory",
      workspaceDir: ".tmp/workspace",
      openaiApiKey: "test-key",
      model: "gpt-5.2",
    }),
  ) as any;

  let capturedBody: Record<string, unknown> | null = null;
  engine.client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          capturedBody = body;
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    facts: [],
                    entities: [],
                    profileUpdates: [],
                    questions: [],
                    relationships: [],
                  }),
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await engine.extractWithDirectClient("hello world");
  assert.ok(result);
  assert.equal(capturedBody?.model, "gpt-5.2");
  assert.equal("max_completion_tokens" in (capturedBody ?? {}), true);
  assert.equal("max_tokens" in (capturedBody ?? {}), false);
});

test("fallback OpenAI client uses max_completion_tokens for gpt-5 providers", async () => {
  const gatewayConfig: GatewayConfig = {
    agents: {
      defaults: {
        model: {
          primary: "openai/gpt-5.2",
        },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-completions",
          baseUrl: "https://example.com/v1",
          apiKey: "test-key",
          models: [],
        },
      },
    },
  };

  const client = new FallbackLlmClient(gatewayConfig);
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await client.chatCompletion([{ role: "user", content: "hello" }], {
      maxTokens: 1234,
    });
    assert.ok(response);
    assert.equal(requestBody?.model, "gpt-5.2");
    assert.equal(requestBody?.max_completion_tokens, 1234);
    assert.equal("max_tokens" in (requestBody ?? {}), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
