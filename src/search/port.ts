import type { QmdSearchResult } from "../types.js";

/** Alias so consumers don't need to reference "Qmd" in a backend-agnostic context. */
export type SearchResult = QmdSearchResult;

/**
 * Abstract search backend interface.
 *
 * Implementations:
 * - QmdClient (default, local hybrid search)
 * - NoopSearchBackend (graceful degradation)
 * - RemoteSearchBackend (HTTP REST adapter)
 */
export interface SearchBackend {
  // ── Lifecycle ──
  probe(): Promise<boolean>;
  isAvailable(): boolean;
  isDaemonMode(): boolean;
  debugStatus(): string;

  // ── Search ──
  search(query: string, collection?: string, maxResults?: number): Promise<SearchResult[]>;
  searchGlobal(query: string, maxResults?: number): Promise<SearchResult[]>;
  bm25Search(query: string, collection?: string, maxResults?: number): Promise<SearchResult[]>;
  vectorSearch(query: string, collection?: string, maxResults?: number): Promise<SearchResult[]>;
  hybridSearch(query: string, collection?: string, maxResults?: number): Promise<SearchResult[]>;

  // ── Maintenance ──
  update(): Promise<void>;
  updateCollection(collection: string): Promise<void>;
  embed(): Promise<void>;
  embedCollection(collection: string): Promise<void>;

  // ── Collection management ──
  ensureCollection(memoryDir: string): Promise<"present" | "missing" | "unknown" | "skipped">;
}
