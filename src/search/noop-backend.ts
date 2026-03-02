import type { SearchBackend, SearchResult } from "./port.js";

/**
 * No-op search backend for graceful degradation.
 * All searches return empty results; all maintenance is a no-op.
 */
export class NoopSearchBackend implements SearchBackend {
  async probe(): Promise<boolean> {
    return false;
  }

  isAvailable(): boolean {
    return false;
  }

  isDaemonMode(): boolean {
    return false;
  }

  debugStatus(): string {
    return "backend=noop";
  }

  async search(): Promise<SearchResult[]> {
    return [];
  }

  async searchGlobal(): Promise<SearchResult[]> {
    return [];
  }

  async bm25Search(): Promise<SearchResult[]> {
    return [];
  }

  async vectorSearch(): Promise<SearchResult[]> {
    return [];
  }

  async hybridSearch(): Promise<SearchResult[]> {
    return [];
  }

  async update(): Promise<void> {}
  async updateCollection(): Promise<void> {}
  async embed(): Promise<void> {}
  async embedCollection(): Promise<void> {}

  async ensureCollection(): Promise<"skipped"> {
    return "skipped";
  }
}
