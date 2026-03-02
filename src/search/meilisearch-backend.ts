import { log } from "../logger.js";
import type { SearchBackend, SearchResult } from "./port.js";
import { scanMemoryDir } from "./document-scanner.js";

export interface MeilisearchBackendOptions {
  host: string;
  apiKey?: string;
  collection: string;
  timeoutMs?: number;
  autoIndex?: boolean;
  memoryDir?: string;
}

/**
 * Meilisearch search backend — server-based SDK client.
 *
 * Requires a running Meilisearch instance. Uses the official `meilisearch` SDK.
 * When `autoIndex` is true, update() pushes docs from the local memory directory.
 */
export class MeilisearchBackend implements SearchBackend {
  private readonly host: string;
  private readonly apiKey?: string;
  private readonly collection: string;
  private readonly timeoutMs: number;
  private readonly autoIndex: boolean;
  private readonly memoryDir?: string;
  private available = false;
  private client: any = null;
  private meiliModule: any = null;

  constructor(opts: MeilisearchBackendOptions) {
    this.host = opts.host;
    this.apiKey = opts.apiKey;
    this.collection = opts.collection;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.autoIndex = opts.autoIndex ?? false;
    this.memoryDir = opts.memoryDir;
  }

  async probe(): Promise<boolean> {
    try {
      const client = await this.ensureClient();
      await client.health();
      this.available = true;
      return true;
    } catch (err) {
      log.debug(`MeilisearchBackend probe failed: ${err}`);
      this.available = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  debugStatus(): string {
    return `backend=meilisearch available=${this.available} host=${this.host}`;
  }

  async search(query: string, _collection?: string, maxResults?: number): Promise<SearchResult[]> {
    return this.hybridSearch(query, _collection, maxResults);
  }

  async searchGlobal(query: string, maxResults?: number): Promise<SearchResult[]> {
    const limit = maxResults ?? 10;
    if (!this.available) return [];

    try {
      const client = await this.ensureClient();
      const indexes = await client.getIndexes();
      const queries = (indexes.results ?? []).map((idx: any) => ({
        indexUid: idx.uid,
        q: query,
        limit,
      }));
      if (queries.length === 0) return [];

      const multiResult = await client.multiSearch({ queries });
      const allResults: SearchResult[] = [];
      for (const result of multiResult.results ?? []) {
        allResults.push(...this.mapHits(result.hits ?? []));
      }
      allResults.sort((a, b) => b.score - a.score);
      return allResults.slice(0, limit);
    } catch (err) {
      log.debug(`MeilisearchBackend searchGlobal failed: ${err}`);
      return [];
    }
  }

  async bm25Search(query: string, _collection?: string, maxResults?: number): Promise<SearchResult[]> {
    return this.doSearch(query, maxResults ?? 10);
  }

  async vectorSearch(query: string, _collection?: string, maxResults?: number): Promise<SearchResult[]> {
    return this.doSearch(query, maxResults ?? 10, { hybrid: { semanticRatio: 1.0, embedder: "default" } });
  }

  async hybridSearch(query: string, _collection?: string, maxResults?: number): Promise<SearchResult[]> {
    return this.doSearch(query, maxResults ?? 10, { hybrid: { semanticRatio: 0.5, embedder: "default" } });
  }

  async update(): Promise<void> {
    await this.updateCollection(this.collection);
  }

  async updateCollection(_collection: string): Promise<void> {
    if (!this.autoIndex || !this.memoryDir) return;
    if (!this.available) return;

    try {
      const client = await this.ensureClient();
      const docs = await scanMemoryDir(this.memoryDir);
      const index = client.index(this.collection);

      const meilDocs = docs.map((d) => ({
        id: d.docid,
        path: d.path,
        content: d.content,
        snippet: d.snippet,
      }));

      await index.addDocuments(meilDocs, { primaryKey: "id" });
    } catch (err) {
      log.debug(`MeilisearchBackend update failed: ${err}`);
    }
  }

  async embed(): Promise<void> {
    // Meilisearch handles its own embedding when configured with an embedder
  }

  async embedCollection(_collection: string): Promise<void> {
    // Meilisearch handles its own embedding when configured with an embedder
  }

  async ensureCollection(_memoryDir: string): Promise<"present" | "missing" | "unknown" | "skipped"> {
    if (!this.available) return "skipped";
    try {
      const client = await this.ensureClient();
      try {
        await client.getIndex(this.collection);
        return "present";
      } catch {
        // Index doesn't exist — create it
        await client.createIndex(this.collection, { primaryKey: "id" });
        return "present";
      }
    } catch {
      return "skipped";
    }
  }

  private async ensureClient(): Promise<any> {
    if (this.client) return this.client;
    if (!this.meiliModule) {
      this.meiliModule = await import("meilisearch");
    }
    const MeiliSearch = this.meiliModule.MeiliSearch ?? this.meiliModule.default?.MeiliSearch;
    this.client = new MeiliSearch({
      host: this.host,
      apiKey: this.apiKey,
      timeout: this.timeoutMs,
    });
    return this.client;
  }

  private async doSearch(query: string, limit: number, extra?: Record<string, unknown>): Promise<SearchResult[]> {
    if (!this.available) return [];
    try {
      const client = await this.ensureClient();
      const index = client.index(this.collection);
      const result = await index.search(query, { limit, ...extra });
      return this.mapHits(result.hits ?? []);
    } catch (err) {
      log.debug(`MeilisearchBackend search failed: ${err}`);
      return [];
    }
  }

  private mapHits(hits: any[]): SearchResult[] {
    return hits.map((hit) => ({
      docid: hit.id ?? "",
      path: hit.path ?? "",
      snippet: hit._formatted?.content ?? hit.snippet ?? hit.content?.slice(0, 200) ?? "",
      score: hit._rankingScore ?? 0.5,
    }));
  }
}
