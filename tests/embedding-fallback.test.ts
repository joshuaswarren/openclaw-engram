import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingFallback } from "../src/embedding-fallback.js";
import type { PluginConfig } from "../src/types.js";

function stubConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    openaiApiKey: "test-key",
    openaiBaseUrl: undefined,
    memoryDir: "/tmp/engram-embedding-test",
    embeddingFallbackEnabled: true,
    embeddingFallbackProvider: "openai",
    localLlmEnabled: false,
    localLlmUrl: undefined,
    localLlmModel: undefined,
    localLlmApiKey: undefined,
    localLlmHeaders: undefined,
    localLlmAuthHeader: true,
    ...overrides,
  } as PluginConfig;
}

test("EmbeddingFallback uses default OpenAI endpoint when openaiBaseUrl is unset", async () => {
  const fallback = new EmbeddingFallback(stubConfig());
  // Access the private resolveProvider via prototype to inspect the endpoint
  const provider = await (fallback as any).resolveProvider();
  assert.ok(provider);
  assert.equal(provider.endpoint, "https://api.openai.com/v1/embeddings");
  assert.equal(provider.type, "openai");
});

test("EmbeddingFallback respects custom openaiBaseUrl", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    openaiBaseUrl: "http://localhost:8005/v1",
  }));
  const provider = await (fallback as any).resolveProvider();
  assert.ok(provider);
  assert.equal(provider.endpoint, "http://localhost:8005/v1/embeddings");
  assert.equal(provider.type, "openai");
});

test("EmbeddingFallback strips trailing slash from custom openaiBaseUrl", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    openaiBaseUrl: "http://localhost:8005/v1/",
  }));
  const provider = await (fallback as any).resolveProvider();
  assert.ok(provider);
  assert.equal(provider.endpoint, "http://localhost:8005/v1/embeddings");
});

test("EmbeddingFallback uses local provider when embeddingFallbackProvider is local", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    embeddingFallbackProvider: "local",
    localLlmEnabled: true,
    localLlmUrl: "http://host.docker.internal:8006/v1",
    localLlmModel: "bge-m3",
    localLlmApiKey: "dummy",
  }));
  const provider = await (fallback as any).resolveProvider();
  assert.ok(provider);
  assert.equal(provider.type, "local");
  assert.equal(provider.model, "bge-m3");
  assert.equal(provider.endpoint, "http://host.docker.internal:8006/v1/embeddings");
});

test("EmbeddingFallback returns null when disabled", async () => {
  const fallback = new EmbeddingFallback(stubConfig({
    embeddingFallbackEnabled: false,
  }));
  const provider = await (fallback as any).resolveProvider();
  assert.equal(provider, null);
});
