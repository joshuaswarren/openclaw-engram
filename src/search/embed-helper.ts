import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";

type ProviderConfig = {
  type: "openai" | "local";
  model: string;
  endpoint: string;
  headers: Record<string, string>;
};

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";

/**
 * Thin embedding helper that reuses EmbeddingFallback's provider resolution logic.
 * Provides single and batch embedding for search backends that need vector support.
 */
export class EmbedHelper {
  private provider: ProviderConfig | null | undefined; // undefined = not yet resolved

  constructor(private readonly config: PluginConfig) {}

  /**
   * Whether an embedding provider is available.
   * Resolves the provider on first call.
   */
  isAvailable(): boolean {
    if (this.provider === undefined) {
      this.provider = this.resolveProvider();
    }
    return this.provider !== null;
  }

  /**
   * Embed a single text string. Returns null if no provider is available.
   */
  async embed(text: string): Promise<number[] | null> {
    const provider = this.getProvider();
    if (!provider) return null;
    return this.callEmbed(text, provider);
  }

  /**
   * Embed a batch of texts. Returns an array parallel to input; entries are null on failure.
   */
  async embedBatch(texts: string[], batchSize = 32): Promise<(number[] | null)[]> {
    const provider = this.getProvider();
    if (!provider) return texts.map(() => null);

    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map((t) => this.callEmbed(t, provider)));
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }
    return results;
  }

  private getProvider(): ProviderConfig | null {
    if (this.provider === undefined) {
      this.provider = this.resolveProvider();
    }
    return this.provider;
  }

  private resolveProvider(): ProviderConfig | null {
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

  private async callEmbed(input: string, provider: ProviderConfig): Promise<number[] | null> {
    try {
      const res = await fetch(provider.endpoint, {
        method: "POST",
        headers: provider.headers,
        body: JSON.stringify({
          model: provider.model,
          input: input.slice(0, 8000),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        log.debug(`EmbedHelper request failed: ${provider.type} ${res.status}`);
        return null;
      }
      const payload = (await res.json()) as any;
      const vector = payload?.data?.[0]?.embedding;
      if (!Array.isArray(vector)) return null;
      return vector.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n));
    } catch (err) {
      log.debug(`EmbedHelper error: ${err}`);
      return null;
    }
  }
}
