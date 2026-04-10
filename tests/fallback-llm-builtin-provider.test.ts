import test from "node:test";
import assert from "node:assert/strict";
import { FallbackLlmClient } from "../src/fallback-llm.ts";
import type { GatewayConfig } from "../src/types.ts";

/**
 * Helper: create a gateway config with explicit providers and a model chain.
 */
function makeConfig(
  providers: GatewayConfig["models"],
  primary: string,
  fallbacks: string[] = [],
): GatewayConfig {
  return {
    models: providers,
    agents: {
      defaults: {
        model: { primary, fallbacks },
      },
    },
  };
}

test("FallbackLlmClient resolves built-in openai-codex provider not in explicit providers", () => {
  // Config has no "openai-codex" in providers, but the model chain references it
  const config = makeConfig(
    { providers: {} },
    "openai-codex/gpt-5.4",
  );

  const client = new FallbackLlmClient(config);
  assert.ok(client.isAvailable(), "client should report available for built-in provider");
});

test("FallbackLlmClient resolves built-in anthropic-prefixed provider", () => {
  const config = makeConfig(
    { providers: {} },
    "anthropic-enterprise/claude-opus-4-6",
  );

  const client = new FallbackLlmClient(config);
  assert.ok(client.isAvailable(), "client should report available for anthropic-prefixed provider");
});

test("FallbackLlmClient resolves unknown provider via fallback synthesis", () => {
  const config = makeConfig(
    { providers: {} },
    "custom-provider/some-model",
  );

  const client = new FallbackLlmClient(config);
  assert.ok(client.isAvailable(), "client should report available for unknown provider (gateway resolver handles auth)");
});

test("FallbackLlmClient prefers explicit provider config over synthesized", () => {
  const config = makeConfig(
    {
      providers: {
        "openai-codex": {
          baseUrl: "https://custom.endpoint.example.com/v1",
          apiKey: "sk-test-key",
          api: "openai-completions",
          models: [],
        },
      },
    },
    "openai-codex/gpt-5.4",
  );

  const client = new FallbackLlmClient(config);
  assert.ok(client.isAvailable());

  // Access the internal model chain to verify the explicit config is used
  const chain = (client as any).getModelChain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0].providerConfig.baseUrl, "https://custom.endpoint.example.com/v1");
  assert.equal(chain[0].providerConfig.apiKey, "sk-test-key");
});

test("FallbackLlmClient synthesizes correct API format for anthropic prefix", () => {
  const config = makeConfig(
    { providers: {} },
    "anthropic-oauth/claude-opus-4-6",
  );

  const client = new FallbackLlmClient(config);
  const chain = (client as any).getModelChain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0].providerConfig.api, "anthropic-messages");
  assert.equal(chain[0].providerConfig.apiKey, "secretref-managed");
});

test("FallbackLlmClient synthesizes correct API format for google prefix", () => {
  const config = makeConfig(
    { providers: {} },
    "google-vertex/gemini-pro",
  );

  const client = new FallbackLlmClient(config);
  const chain = (client as any).getModelChain();
  assert.equal(chain.length, 1);
  assert.equal(chain[0].providerConfig.api, "google-generative");
});

test("FallbackLlmClient builds mixed chain with explicit and synthesized providers", () => {
  const config = makeConfig(
    {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-real",
          api: "openai-completions",
          models: [],
        },
      },
    },
    "openai/gpt-5.2",
    ["openai-codex/gpt-5.4", "anthropic-oauth/claude-opus-4-6"],
  );

  const client = new FallbackLlmClient(config);
  const chain = (client as any).getModelChain();
  assert.equal(chain.length, 3);

  // First: explicit provider
  assert.equal(chain[0].providerId, "openai");
  assert.equal(chain[0].providerConfig.apiKey, "sk-real");

  // Second: synthesized openai-codex
  assert.equal(chain[1].providerId, "openai-codex");
  assert.equal(chain[1].providerConfig.apiKey, "secretref-managed");
  assert.equal(chain[1].providerConfig.api, "openai-completions");

  // Third: synthesized anthropic-oauth
  assert.equal(chain[2].providerId, "anthropic-oauth");
  assert.equal(chain[2].providerConfig.apiKey, "secretref-managed");
  assert.equal(chain[2].providerConfig.api, "anthropic-messages");
});
