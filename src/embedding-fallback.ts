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

export class EmbeddingFallback {
  private readonly indexPath: string;
  private loaded: EmbeddingIndexFile | null = null;

  constructor(private readonly config: PluginConfig) {
    this.indexPath = path.join(config.memoryDir, "state", "embeddings.json");
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolveProvider()) !== null;
  }

  async search(
    query: string,
    limit: number,
  ): Promise<Array<{ id: string; score: number; path: string }>> {
    const provider = await this.resolveProvider();
    if (!provider) return [];

    const index = await this.loadIndex(provider);
    const ids = Object.keys(index.entries);
    if (ids.length === 0) return [];

    const queryVector = await this.embed(query, provider);
    if (!queryVector) return [];

    const scored = ids
      .map((id) => {
        const entry = index.entries[id];
        return {
          id,
          path: entry.path,
          score: cosineSimilarity(queryVector, entry.vector),
        };
      })
      .filter((r) => Number.isFinite(r.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));

    return scored;
  }

  async indexFile(memoryId: string, content: string, filePath: string): Promise<void> {
    const provider = await this.resolveProvider();
    if (!provider) return;
    const vector = await this.embed(content, provider);
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
        return {
          type: "openai",
          model: DEFAULT_OPENAI_MODEL,
          endpoint: "https://api.openai.com/v1/embeddings",
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

  private async embed(input: string, provider: ProviderConfig): Promise<number[] | null> {
    try {
      const res = await fetch(provider.endpoint, {
        method: "POST",
        headers: provider.headers,
        body: JSON.stringify({
          model: provider.model,
          input: input.slice(0, 8000),
        }),
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
      log.debug(`embedding fallback error: ${err}`);
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

