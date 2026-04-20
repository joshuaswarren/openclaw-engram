import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.ts";

test("OpenAI-compatible provider adds an LM Studio context hint for context window errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error:
          "The number of tokens to keep from the initial prompt is greater than the context length (n_keep: 4249>= n_ctx: 4096).",
      }),
      {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      },
    );

  try {
    const provider = createOpenAiCompatibleProvider({
      provider: "openai",
      model: "google/gemma-4-26b-a4b",
      baseUrl: "http://127.0.0.1:1234/v1",
    });

    await assert.rejects(
      provider.complete("hello"),
      /LM Studio is running this model with a context window that is too small for this benchmark/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible provider leaves unrelated errors unchanged", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("unauthorized", {
      status: 401,
      statusText: "Unauthorized",
      headers: { "content-type": "text/plain" },
    });

  try {
    const provider = createOpenAiCompatibleProvider({
      provider: "openai",
      model: "gpt-4.1-mini",
      baseUrl: "http://127.0.0.1:1234/v1",
    });

    await assert.rejects(
      provider.complete("hello"),
      /OpenAI-compatible completion failed: 401 Unauthorized — unauthorized$/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
