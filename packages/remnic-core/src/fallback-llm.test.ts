import assert from "node:assert/strict";
import test from "node:test";

import { FallbackLlmClient } from "./fallback-llm.ts";
import { clearModelsJsonCache, __setModelsJsonForTest } from "./models-json.ts";
import { clearSecretCache } from "./resolve-provider-secret.ts";

test("fallback llm prefers materialized models.json provider config over raw gateway stubs", { concurrency: false }, async () => {
  __setModelsJsonForTest({
    "custom-provider": {
      baseUrl: "https://materialized.example/v1",
      api: "openai-completions",
      apiKey: "materialized-key",
      models: [],
    },
  });
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "custom-provider/demo-model",
        },
      },
    },
    models: {
      providers: {
        "custom-provider": {
          baseUrl: "https://raw.example",
          api: "openai-completions",
          apiKey: "raw-key",
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok");
    assert.equal(capturedUrl, "https://materialized.example/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm uses the Responses API for openai-responses transports", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "responses-provider/demo-model",
        },
      },
    },
    models: {
      providers: {
        "responses-provider": {
          baseUrl: "https://responses.example/v1",
          api: "openai-responses",
          apiKey: "responses-key",
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody = "";
  globalThis.fetch = (async (url, init) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        output_text: "ok from responses",
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [
        { role: "system", content: "Reply with OK only." },
        { role: "user", content: "Say OK" },
      ],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "ok from responses");
    assert.equal(response?.usage?.inputTokens, 2);
    assert.equal(response?.usage?.outputTokens, 3);
    assert.equal(response?.usage?.totalTokens, 5);
    assert.equal(capturedUrl, "https://responses.example/v1/responses");

    const parsedBody = JSON.parse(capturedBody) as {
      instructions?: string;
      input?: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
      max_output_tokens?: number;
    };
    assert.equal(parsedBody.instructions, "Reply with OK only.");
    assert.equal(parsedBody.max_output_tokens, 16);
    assert.deepEqual(parsedBody.input, [
      {
        role: "user",
        content: [{ type: "input_text", text: "Say OK" }],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});
