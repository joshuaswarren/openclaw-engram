import assert from "node:assert/strict";
import test from "node:test";

import { FallbackLlmClient } from "./fallback-llm.js";
import { clearModelsJsonCache, __setModelsJsonForTest } from "./models-json.js";
import { clearSecretCache } from "./resolve-provider-secret.js";

test("fallback llm prefers the active gateway provider config over models.json", { concurrency: false }, async () => {
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
    assert.equal(capturedUrl, "https://raw.example/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm falls back to models.json for built-in providers missing from the active config", { concurrency: false }, async () => {
  __setModelsJsonForTest({
    "built-in-provider": {
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
          primary: "built-in-provider/demo-model",
        },
      },
    },
    models: {
      providers: {},
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url) => {
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

test("fallback llm ignores echoed input_text blocks in responses output extraction", { concurrency: false }, async () => {
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
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [
              { type: "input_text", text: "repeat the prompt" },
              { type: "output_text", text: "real answer" },
            ],
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )) as typeof fetch;

  try {
    const response = await llm.chatCompletion(
      [{ role: "user", content: "Say OK" }],
      { temperature: 0, maxTokens: 16 },
    );

    assert.equal(response?.content, "real answer");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("fallback llm normalizes anthropic-compatible base URLs that omit /v1", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();

  const llm = new FallbackLlmClient({
    agents: {
      defaults: {
        model: {
          primary: "anthropic-provider/demo-model",
        },
      },
    },
    models: {
      providers: {
        "anthropic-provider": {
          baseUrl: "https://anthropic.example/api",
          api: "anthropic-messages",
          apiKey: "anthropic-key",
          models: [],
        },
      },
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = (async (url) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "ok from anthropic" }],
        usage: { input_tokens: 2, output_tokens: 3 },
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

    assert.equal(response?.content, "ok from anthropic");
    assert.equal(capturedUrl, "https://anthropic.example/api/v1/messages");
  } finally {
    globalThis.fetch = originalFetch;
    clearModelsJsonCache();
    clearSecretCache();
  }
});
