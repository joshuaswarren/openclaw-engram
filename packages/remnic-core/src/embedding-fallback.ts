import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { log } from "./logger.js";
import type { PluginConfig } from "./types.js";

type EmbeddingProviderType = "openai" | "local";

type ProviderConfig = {
  type: EmbeddingProviderType;
  model: string;
  endpoint: string;
  headers: Record<string, string>;
};

type EmbeddingIndexEntry = {
  vector: number[];
  path: string;
};

type EmbeddingIndexFile = {
  version: 1;
  provider: EmbeddingProviderType;
  model: string;
  entries: Record<string, EmbeddingIndexEntry>;
};

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";

/**
 * Thrown by `EmbeddingFallback.search()` (via `embed()`) when an HTTP fetch
 * on the lookup path exceeds its deadline. Callers that need to distinguish a
 * timeout from a generic network error can `instanceof`-check against this
 * class; callers that just need fail-open semantics can catch any error.
 *
 * Round 9 fix (Finding UZqB): previously a timeout returned null from embed(),
 * which caused search() to return [] silently. decideSemanticDedup then
 * classified the result as no_candidates instead of backend_unavailable, so
 * the per-batch batchBackendUnavailable short-circuit never activated and
 * batches of N facts each paid a full timeout roundtrip.
 */
export class EmbeddingTimeoutError extends Error {
  override readonly name = "EmbeddingTimeoutError" as const;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Maximum time to wait for an embedding HTTP request on the LOOKUP/query
 * path before giving up.
 *
 * The write-time semantic dedup guard in orchestrator.persistExtraction()
 * blocks each candidate fact on an embedding lookup. If the embedding
 * endpoint hangs (degraded OpenAI, stalled local gateway, DNS timeout),
 * extraction would otherwise stall indefinitely — a single bad backend
 * could freeze the entire persist loop. Bounding the fetch here ensures
 * the decision path fails open (returns null) within a predictable window
 * and writes proceed as non-duplicates.
 *
 * Tests can override via REMNIC_EMBEDDING_FETCH_TIMEOUT_MS so they don't
 * have to wait the full default on hung-fetch assertions.
 *
 * Related: joshuaswarren/remnic#373, PR #399 P1/P2 review.
 */
const DEFAULT_EMBEDDING_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Maximum time to wait for an embedding HTTP request on the INDEX path.
 *
 * Indexing runs asynchronously after a memory has already been persisted
 * to disk. It does not block extraction or writes — it only updates the
 * embedding index used by later semantic dedup lookups. A slow local
 * CPU-backed embedding model can legitimately take tens of seconds per
 * call, so applying the short lookup timeout here silently dropped index
 * updates and caused later dedup lookups to miss recently persisted
 * memories. Use a much larger budget on this path.
 *
 * Tests can override via REMNIC_EMBEDDING_INDEX_TIMEOUT_MS.
 */
const DEFAULT_EMBEDDING_INDEX_TIMEOUT_MS = 120_000;

function resolveEmbeddingLookupTimeoutMs(): number {
  const raw = process.env.REMNIC_EMBEDDING_FETCH_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_EMBEDDING_LOOKUP_TIMEOUT_MS;
}

function resolveEmbeddingIndexTimeoutMs(): number {
  const raw = process.env.REMNIC_EMBEDDING_INDEX_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_EMBEDDING_INDEX_TIMEOUT_MS;
}

/**
 * Options for the low-level embed() call.
 *
 * `mode` selects the timeout profile:
 *   - "lookup" (default): bounded by the short lookup budget; fails open fast.
 *   - "index": bounded by a much longer budget so slow backends can still
 *     index newly persisted memories.
 */
export type EmbedMode = "lookup" | "index";

export class EmbeddingFallback {
  private readonly indexPath: string;
  private loaded: EmbeddingIndexFile | null = null;

  constructor(private readonly config: PluginConfig) {
    this.indexPath = path.join(config.memoryDir, "state", "embeddings.json");
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolveProvider()) !== null;
  }

  /**
   * Nearest-neighbor search against the embedding index.
   *
   * @param query         The query string to embed and search for.
   * @param limit         Max number of hits to return.
   * @param options       Optional filters.
   *   - `pathPrefix`   Restrict candidates to entries whose indexed `path`
   *                    starts with this prefix (relative to `memoryDir`).
   *                    Used by the semantic dedup guard to scope lookups
   *                    to the target namespace so a high-similarity hit
   *                    from a different namespace can't suppress a write
   *                    in the target namespace. Default: no filter.
   *   - `pathExcludePrefixes`
   *                    Exclude any entry whose indexed `path` starts with
   *                    any of these prefixes. Used for the default
   *                    namespace case: when the default namespace lives at
   *                    `memoryDir` root (legacy layout) we still want to
   *                    exclude `namespaces/<other>/…` entries.
   */
  async search(
    query: string,
    limit: number,
    options: {
      pathPrefix?: string;
      pathExcludePrefixes?: readonly string[];
    } = {},
  ): Promise<Array<{ id: string; score: number; path: string }>> {
    const provider = await this.resolveProvider();
    if (!provider) return [];

    const index = await this.loadIndex(provider);
    const ids = Object.keys(index.entries);
    if (ids.length === 0) return [];

    const queryVector = await this.embed(query, provider, { mode: "lookup" });
    if (!queryVector) return [];

    const includePrefix = normalizePathPrefix(options.pathPrefix);
    const excludePrefixes = (options.pathExcludePrefixes ?? [])
      .map((p) => normalizePathPrefix(p))
      .filter((p): p is string => typeof p === "string");

    const scored = ids
      .map((id) => {
        const entry = index.entries[id];
        return {
          id,
          path: entry.path,
          score: cosineSimilarity(queryVector, entry.vector),
        };
      })
      .filter((r) => {
        if (!Number.isFinite(r.score)) return false;
        const normalized = normalizeEntryPath(r.path);
        if (includePrefix !== undefined && !normalized.startsWith(includePrefix)) {
          return false;
        }
        for (const excl of excludePrefixes) {
          if (normalized.startsWith(excl)) return false;
        }
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));

    return scored;
  }

  async indexFile(memoryId: string, content: string, filePath: string): Promise<void> {
    const provider = await this.resolveProvider();
    if (!provider) return;
    // Indexing is not on the write-critical path: a newly persisted memory
    // has already been written to disk by the time we reach this call. Use
    // the long "index" timeout so slow local embedding backends can still
    // add the entry to the index. Previously this used the short lookup
    // budget and silently dropped updates, leaving later dedup lookups
    // blind to the memory. Related: PR #399 P2.
    const vector = await this.embed(content, provider, { mode: "index" });
    if (!vector) return;

    const index = await this.loadIndex(provider);
    const relPath = toMemoryRelativePath(this.config.memoryDir, filePath);
    index.entries[memoryId] = {
      vector,
      path: relPath,
    };
    await this.saveIndex(index);
  }

  async removeFromIndex(memoryId: string): Promise<void> {
    const provider = await this.resolveProvider();
    if (!provider) return;

    const index = await this.loadIndex(provider);
    if (!index.entries[memoryId]) return;
    delete index.entries[memoryId];
    await this.saveIndex(index);
  }

  private async resolveProvider(): Promise<ProviderConfig | null> {
    if (!this.config.embeddingFallbackEnabled) return null;

    const preferred = this.config.embeddingFallbackProvider;
    const providers = preferred === "auto" ? ["openai", "local"] : [preferred];

    for (const p of providers) {
      if (p === "openai" && this.config.openaiApiKey) {
        const baseUrl = this.config.openaiBaseUrl ?? "https://api.openai.com/v1";
        return {
          type: "openai",
          model: DEFAULT_OPENAI_MODEL,
          endpoint: `${baseUrl.replace(/\/$/, "")}/embeddings`,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.openaiApiKey}`,
          },
        };
      }

      if (p === "local" && this.config.localLlmEnabled && this.config.localLlmUrl) {
        const base = this.config.localLlmUrl.replace(/\/$/, "");
        const endpoint = /\/v1$/i.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...(this.config.localLlmHeaders ?? {}),
        };
        if (this.config.localLlmApiKey && this.config.localLlmAuthHeader !== false) {
          headers.Authorization = `Bearer ${this.config.localLlmApiKey}`;
        }
        return {
          type: "local",
          model: this.config.localLlmModel || DEFAULT_OPENAI_MODEL,
          endpoint,
          headers,
        };
      }
    }

    return null;
  }

  private async embed(
    input: string,
    provider: ProviderConfig,
    options: { mode?: EmbedMode } = {},
  ): Promise<number[] | null> {
    // Bound the fetch so a hung embedding endpoint cannot stall callers.
    // The lookup path uses a short budget (see DEFAULT_EMBEDDING_LOOKUP_TIMEOUT_MS
    // docblock) so semantic dedup fails open fast. The index path uses a
    // much longer budget because slow local backends (CPU embedding models)
    // otherwise drop index updates and blind later dedup lookups. See
    // DEFAULT_EMBEDDING_INDEX_TIMEOUT_MS docblock and PR #399 P2 review.
    const mode: EmbedMode = options.mode ?? "lookup";
    const timeoutMs =
      mode === "index"
        ? resolveEmbeddingIndexTimeoutMs()
        : resolveEmbeddingLookupTimeoutMs();
    try {
      const res = await fetch(provider.endpoint, {
        method: "POST",
        headers: provider.headers,
        body: JSON.stringify({
          model: provider.model,
          input: input.slice(0, 8000),
          encoding_format: "float",
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        log.debug(`embedding fallback request failed: ${provider.type} ${res.status}`);
        return null;
      }
      const payload = (await res.json()) as any;
      const vector = payload?.data?.[0]?.embedding;
      if (!Array.isArray(vector)) return null;
      return vector.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n));
    } catch (err) {
      // AbortSignal.timeout throws a DOMException with name "TimeoutError";
      // surface at warn level so operators can distinguish slow backends from
      // generic errors.
      const isTimeout =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      if (isTimeout) {
        log.warn(
          `embedding fallback fetch timed out after ${timeoutMs}ms (${provider.type}, mode=${mode})`,
        );
        // Round 9 fix (Finding UZqB): on the LOOKUP path a timeout means the
        // embedding backend is effectively unavailable — re-throw so that
        // search() propagates the error to semanticDedupLookup, which lets it
        // reach decideSemanticDedup's catch block and return
        // reason="backend_unavailable". Without this, search() would silently
        // return [] and the per-batch batchBackendUnavailable flag would never
        // flip, causing subsequent facts in the same batch to each pay a full
        // timeout roundtrip (N × timeout instead of 1 × timeout).
        //
        // On the INDEX path a timeout is not fatal (the memory is already
        // persisted; index update can be skipped) — return null there so
        // indexFile() stays non-blocking.
        if (mode === "lookup") {
          throw new EmbeddingTimeoutError(
            `embedding backend timed out after ${timeoutMs}ms (${provider.type})`,
          );
        }
      } else {
        log.debug(`embedding fallback error: ${err}`);
      }
      return null;
    }
  }

  private async loadIndex(provider: ProviderConfig): Promise<EmbeddingIndexFile> {
    if (this.loaded && this.loaded.provider === provider.type && this.loaded.model === provider.model) {
      return this.loaded;
    }

    try {
      const raw = await readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw) as EmbeddingIndexFile;
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        this.loaded = {
          version: 1,
          provider: provider.type,
          model: provider.model,
          entries: parsed.entries,
        };
        return this.loaded;
      }
    } catch {
      // ignore and create a new index
    }

    this.loaded = {
      version: 1,
      provider: provider.type,
      model: provider.model,
      entries: {},
    };
    return this.loaded;
  }

  private async saveIndex(index: EmbeddingIndexFile): Promise<void> {
    await mkdir(path.dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(index), "utf-8");
    this.loaded = index;
  }
}

function toMemoryRelativePath(memoryDir: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(memoryDir, filePath);
  return rel.startsWith("..") ? filePath : rel;
}

/**
 * Normalize an index entry path to forward-slashes for stable prefix
 * comparison. Entries are stored as `path.relative(memoryDir, …)` output,
 * which on Windows uses back-slashes. Normalize both sides so prefix
 * matching is OS-independent.
 *
 * Also strip a leading `./` so this helper's output is symmetric with
 * `normalizePathPrefix` below. `toMemoryRelativePath` is a pass-through for
 * non-absolute filePath inputs, so an index entry could legitimately carry a
 * stored path like `"./namespaces/alpha/facts/f.md"`. Without this strip, a
 * caller-supplied prefix `"./namespaces/alpha"` (which `normalizePathPrefix`
 * rewrites to `"namespaces/alpha/"`) would silently miss that entry and
 * namespace-scoped dedup would either let a near-duplicate through or fail
 * to exclude a cross-namespace hit.
 */
function normalizeEntryPath(p: string): string {
  let out = p.replace(/\\/g, "/");
  if (out.startsWith("./")) out = out.slice(2);
  return out;
}

/**
 * Normalize a caller-supplied path prefix:
 *   - Return `undefined` for nullish/empty input (no filter).
 *   - Replace back-slashes with forward-slashes.
 *   - Strip a leading `./`.
 *   - Ensure a trailing `/` so `"namespaces/a"` doesn't accidentally match
 *     `"namespaces/another/…"`.
 */
function normalizePathPrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined || prefix === null) return undefined;
  let p = String(prefix).replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (p.length === 0) return undefined;
  if (!p.endsWith("/")) p = `${p}/`;
  return p;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

