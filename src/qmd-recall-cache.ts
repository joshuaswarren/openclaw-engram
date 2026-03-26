import type { RecallPlanMode } from "./types.js";
import type { SearchQueryOptions } from "./search/port.js";

type QmdRecallCacheEntry = {
  value: unknown;
  cachedAtMs: number;
};

export type QmdRecallCacheSource = "fresh" | "stale";

export interface QmdRecallCacheHit<T> {
  value: T;
  source: QmdRecallCacheSource;
  ageMs: number;
}

export interface QmdRecallCacheKeyOptions {
  query: string;
  namespaces: string[];
  recallMode: RecallPlanMode;
  maxResults: number;
  collection?: string;
  searchOptions?: SearchQueryOptions;
}

const qmdRecallCache = new Map<string, QmdRecallCacheEntry>();

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildQmdRecallCacheKey(options: QmdRecallCacheKeyOptions): string {
  return JSON.stringify({
    query: normalizeQuery(options.query),
    namespaces: [...options.namespaces].sort(),
    recallMode: options.recallMode,
    maxResults: options.maxResults,
    collection: options.collection ?? "",
    intent: options.searchOptions?.intent?.trim().toLowerCase() ?? "",
    explain: options.searchOptions?.explain === true,
  });
}

export function getCachedQmdRecall<T>(
  cacheKey: string,
  options: {
    freshTtlMs: number;
    staleTtlMs: number;
  },
): QmdRecallCacheHit<T> | null {
  const entry = qmdRecallCache.get(cacheKey);
  if (!entry) return null;

  const ageMs = Date.now() - entry.cachedAtMs;
  if (ageMs <= options.freshTtlMs) {
    return { value: entry.value as T, source: "fresh", ageMs };
  }
  if (ageMs <= options.staleTtlMs) {
    return { value: entry.value as T, source: "stale", ageMs };
  }

  qmdRecallCache.delete(cacheKey);
  return null;
}

export function setCachedQmdRecall<T>(
  cacheKey: string,
  value: T,
  options: { maxEntries: number },
): void {
  qmdRecallCache.delete(cacheKey);
  qmdRecallCache.set(cacheKey, {
    value,
    cachedAtMs: Date.now(),
  });

  while (qmdRecallCache.size > options.maxEntries) {
    const oldestKey = qmdRecallCache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    qmdRecallCache.delete(oldestKey);
  }
}

export function clearQmdRecallCache(): void {
  qmdRecallCache.clear();
}
