import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test factory routing and adapter construction — no live services needed.

describe("search backend factory", () => {
  it("routes 'noop' to NoopSearchBackend", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ searchBackend: "noop" });
    const backend = createSearchBackend(config);
    assert.equal(backend.debugStatus(), "backend=noop");
    assert.equal(backend.isAvailable(), false);
  });

  it("routes 'remote' to RemoteSearchBackend", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ searchBackend: "remote", remoteSearchBaseUrl: "http://localhost:9999" });
    const backend = createSearchBackend(config);
    assert.ok(backend.debugStatus().startsWith("backend=remote"));
  });

  it("routes 'orama' to OramaBackend", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ searchBackend: "orama" });
    const backend = createSearchBackend(config);
    assert.ok(backend.debugStatus().startsWith("backend=orama"));
  });

  it("routes 'meilisearch' to MeilisearchBackend", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ searchBackend: "meilisearch" });
    const backend = createSearchBackend(config);
    assert.ok(backend.debugStatus().startsWith("backend=meilisearch"));
  });

  it("routes 'lancedb' to LanceDbBackend", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ searchBackend: "lancedb" });
    const backend = createSearchBackend(config);
    assert.ok(backend.debugStatus().startsWith("backend=lancedb"));
  });

  it("defaults to QMD when searchBackend is unset", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ qmdEnabled: true });
    const backend = createSearchBackend(config);
    // QmdClient debug status contains "cli=" — that's its signature
    assert.ok(backend.debugStatus().includes("cli="));
  });

  it("falls back to noop when qmd is default but disabled", async () => {
    const { createSearchBackend } = await import("../src/search/factory.js");
    const config = fakeConfig({ qmdEnabled: false });
    const backend = createSearchBackend(config);
    assert.equal(backend.debugStatus(), "backend=noop");
  });
});

describe("document scanner", () => {
  it("returns empty array for non-existent directory", async () => {
    const { scanMemoryDir } = await import("../src/search/document-scanner.js");
    const docs = await scanMemoryDir("/tmp/nonexistent-engram-test-dir-" + Date.now());
    assert.deepEqual(docs, []);
  });
});

describe("embed helper", () => {
  it("returns not available when embedding is disabled", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const helper = new EmbedHelper(fakeConfig({ embeddingFallbackEnabled: false }) as any);
    assert.equal(helper.isAvailable(), false);
  });

  it("returns null vectors when not available", async () => {
    const { EmbedHelper } = await import("../src/search/embed-helper.js");
    const helper = new EmbedHelper(fakeConfig({ embeddingFallbackEnabled: false }) as any);
    const result = await helper.embed("test");
    assert.equal(result, null);
  });
});

/** Minimal fake PluginConfig for factory routing tests. */
function fakeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    searchBackend: "qmd",
    qmdEnabled: false,
    qmdCollection: "test-collection",
    qmdMaxResults: 10,
    qmdPath: undefined,
    qmdDaemonEnabled: false,
    qmdDaemonUrl: "",
    qmdDaemonRecheckIntervalMs: 60_000,
    qmdIntentHintsEnabled: false,
    qmdExplainEnabled: false,
    slowLogEnabled: false,
    slowLogThresholdMs: 5000,
    qmdUpdateTimeoutMs: 30_000,
    qmdUpdateMinIntervalMs: 0,
    remoteSearchBaseUrl: undefined,
    remoteSearchApiKey: undefined,
    remoteSearchTimeoutMs: 30_000,
    memoryDir: "/tmp/engram-test",
    lanceDbPath: "/tmp/engram-test/lancedb",
    lanceEmbeddingDimension: 1536,
    meilisearchHost: "http://localhost:7700",
    meilisearchApiKey: undefined,
    meilisearchTimeoutMs: 30_000,
    meilisearchAutoIndex: false,
    oramaDbPath: "/tmp/engram-test/orama",
    oramaEmbeddingDimension: 1536,
    embeddingFallbackEnabled: false,
    embeddingFallbackProvider: "auto",
    openaiApiKey: undefined,
    localLlmEnabled: false,
    localLlmUrl: "",
    localLlmModel: "",
    localLlmApiKey: undefined,
    localLlmHeaders: undefined,
    localLlmAuthHeader: true,
    ...overrides,
  };
}
