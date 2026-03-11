import type { PluginConfig, QmdSearchResult } from "../types.js";
import type { SearchBackend, SearchQueryOptions } from "../search/port.js";
import { createSearchBackend } from "../search/factory.js";

export function namespaceCollectionName(
  baseCollection: string,
  namespace: string,
  options?: {
    defaultNamespace?: string;
    useLegacyDefaultCollection?: boolean;
  },
): string {
  const trimmed = namespace.trim();
  const defaultNamespace = options?.defaultNamespace?.trim() || "default";
  if (
    options?.useLegacyDefaultCollection === true &&
    trimmed === defaultNamespace
  ) {
    return baseCollection;
  }

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "-") start += 1;
  while (end > start && normalized[end - 1] === "-") end -= 1;
  const token = normalized.slice(start, end) || defaultNamespace;
  return `${baseCollection}--ns--${token}`;
}

type StorageRouterLike = {
  storageFor(namespace: string): Promise<{ dir: string }>;
};

type NamespaceBackendRecord = {
  backend: SearchBackend;
  collection: string;
  memoryDir: string;
  available: boolean;
  collectionState: "present" | "missing" | "unknown" | "skipped";
};

export class NamespaceSearchRouter {
  private readonly cache = new Map<string, Promise<NamespaceBackendRecord>>();

  constructor(
    private readonly config: PluginConfig,
    private readonly storageRouter: StorageRouterLike,
    private readonly createBackend: (config: PluginConfig) => SearchBackend = createSearchBackend,
  ) {}

  async collectionForNamespace(namespace: string): Promise<string> {
    return (await this.backendRecordFor(namespace)).collection;
  }

  async searchAcrossNamespaces(options: {
    query: string;
    namespaces: string[];
    maxResults?: number;
    mode?: "search" | "hybrid" | "bm25" | "vector";
    searchOptions?: SearchQueryOptions;
  }): Promise<QmdSearchResult[]> {
    const query = options.query.trim();
    if (!query) return [];
    const maxResults = Math.max(0, Math.floor(options.maxResults ?? this.config.qmdMaxResults));
    if (maxResults === 0) return [];

    const method = options.mode ?? "search";
    const namespaces = Array.from(new Set(options.namespaces.map((value) => value.trim()).filter(Boolean)));
    if (namespaces.length === 0) return [];

    const resultsByNamespace = await Promise.all(
      namespaces.map(async (namespace) => {
        const record = await this.backendRecordFor(namespace);
        if (!record.available || record.collectionState === "missing") return [] as QmdSearchResult[];
        switch (method) {
          case "hybrid":
            return await record.backend.hybridSearch(query, undefined, maxResults);
          case "bm25":
            return await record.backend.bm25Search(query, undefined, maxResults);
          case "vector":
            return await record.backend.vectorSearch(query, undefined, maxResults);
          default:
            return await record.backend.search(
              query,
              undefined,
              maxResults,
              options.searchOptions,
            );
        }
      }),
    );

    return mergeNamespaceSearchResults(resultsByNamespace, maxResults);
  }

  async updateNamespaces(namespaces: string[]): Promise<void> {
    const unique = Array.from(new Set(namespaces.map((value) => value.trim()).filter(Boolean)));
    await Promise.all(
      unique.map(async (namespace) => {
        const record = await this.backendRecordFor(namespace);
        if (!record.available || record.collectionState === "missing") return;
        await record.backend.update();
      }),
    );
  }

  async embedNamespaces(namespaces: string[]): Promise<void> {
    const unique = Array.from(new Set(namespaces.map((value) => value.trim()).filter(Boolean)));
    await Promise.all(
      unique.map(async (namespace) => {
        const record = await this.backendRecordFor(namespace);
        if (!record.available || record.collectionState === "missing") return;
        await record.backend.embed();
      }),
    );
  }

  async ensureNamespaceCollection(namespace: string): Promise<"present" | "missing" | "unknown" | "skipped"> {
    const record = await this.backendRecordFor(namespace);
    return record.collectionState;
  }

  private async backendRecordFor(namespace: string): Promise<NamespaceBackendRecord> {
    const key = namespace.trim() || this.config.defaultNamespace;
    const existing = this.cache.get(key);
    if (existing) return await existing;

    const pending = (async (): Promise<NamespaceBackendRecord> => {
      const storage = await this.storageRouter.storageFor(key);
      const useLegacyDefaultCollection =
        key === this.config.defaultNamespace && storage.dir === this.config.memoryDir;
      const scopedConfig: PluginConfig = {
        ...this.config,
        memoryDir: storage.dir,
        qmdCollection: namespaceCollectionName(this.config.qmdCollection, key, {
          defaultNamespace: this.config.defaultNamespace,
          useLegacyDefaultCollection,
        }),
      };

      const backend = this.createBackend(scopedConfig);
      const available = await backend.probe().catch(() => false);
      const collectionState = available
        ? await backend.ensureCollection(storage.dir).catch(() => "unknown" as const)
        : "unknown";
      return {
        backend,
        collection: scopedConfig.qmdCollection,
        memoryDir: storage.dir,
        available,
        collectionState,
      };
    })();

    this.cache.set(key, pending);
    return await pending;
  }
}

function mergeNamespaceSearchResults(
  lists: QmdSearchResult[][],
  maxResults: number,
): QmdSearchResult[] {
  const merged = new Map<string, QmdSearchResult>();

  for (const list of lists) {
    for (const result of list) {
      const key = result.path || result.docid;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, result);
        continue;
      }
      if (result.score > existing.score) {
        merged.set(key, {
          ...result,
          snippet: existing.snippet || result.snippet || "",
        });
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
