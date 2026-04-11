import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EmbeddingFallback } from "./embedding-fallback.js";
import type { PluginConfig } from "./types.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function createConfig(memoryDir: string): PluginConfig {
  return {
    memoryDir,
    embeddingFallbackEnabled: true,
    embeddingFallbackProvider: "openai",
    openaiApiKey: "sk-test-placeholder",
    openaiBaseUrl: "https://example.invalid/v1",
  } as unknown as PluginConfig;
}

/**
 * Replace globalThis.fetch for the duration of a callback. Restores the
 * original implementation even if the callback throws.
 */
async function withFetch(
  impl: typeof fetch,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test(
  "EmbeddingFallback.search aborts and fails open when fetch hangs past the timeout",
  async () => {
    // Shrink the timeout so the test runs fast. The fix under test reads this
    // env var at call time via resolveEmbeddingFetchTimeoutMs().
    const previousTimeout = process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS;
    process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS = "75";

    const tmp = await mkdtemp(join(tmpdir(), "remnic-embed-fallback-"));
    try {
      const fallback = new EmbeddingFallback(createConfig(tmp));

      // Seed the on-disk index directly so the search() path has at least one
      // entry and actually reaches embed() for the query vector. We bypass
      // indexFile() to avoid a live fetch during setup.
      await mkdir(join(tmp, "state"), { recursive: true });
      await writeFile(
        join(tmp, "state", "embeddings.json"),
        JSON.stringify({
          version: 1,
          provider: "openai",
          model: "text-embedding-3-small",
          entries: {
            "existing-1": {
              vector: [1, 0, 0],
              path: "seed.md",
            },
          },
        }),
        "utf-8",
      );

      const fetchCalls: number[] = [];
      const hangingFetch: typeof fetch = (_input, init) => {
        fetchCalls.push(Date.now());
        const signal = init?.signal as AbortSignal | undefined;
        // Honor the AbortSignal from AbortSignal.timeout(): the production
        // code passes one through, so a well-behaved test double must too.
        return new Promise((_resolve, reject) => {
          if (!signal) return; // hang forever (shouldn't happen in prod path)
          if (signal.aborted) {
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          });
        });
      };

      await withFetch(hangingFetch, async () => {
        const start = Date.now();
        const results = await fallback.search("novel query", 5);
        const elapsed = Date.now() - start;

        // Fails open: empty result set, bounded latency.
        assert.deepEqual(results, []);
        assert.ok(
          elapsed < 2_000,
          `search should return within timeout window, took ${elapsed}ms`,
        );
        assert.ok(fetchCalls.length >= 1, "expected hanging fetch to be invoked");
      });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS;
      } else {
        process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS = previousTimeout;
      }
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test(
  "EmbeddingFallback.search returns successful vectors when fetch resolves in time",
  async () => {
    const tmp = await mkdtemp(join(tmpdir(), "remnic-embed-fallback-"));
    try {
      const fallback = new EmbeddingFallback(createConfig(tmp));

      let vectorMode: "query" | "doc" = "doc";
      const okFetch: typeof fetch = async () => {
        // First call is indexFile -> doc vector; second call is search -> query vector.
        const vector = vectorMode === "doc" ? [1, 0, 0] : [1, 0, 0];
        vectorMode = "query";
        return new Response(
          JSON.stringify({ data: [{ embedding: vector }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      await withFetch(okFetch, async () => {
        await fallback.indexFile("doc-1", "hello world", join(tmp, "doc1.md"));
        const hits = await fallback.search("hello world", 5);
        assert.equal(hits.length, 1);
        assert.equal(hits[0]?.id, "doc-1");
        // Cosine of identical vectors is 1.
        assert.ok(hits[0]!.score > 0.999);
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);
