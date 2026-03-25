import type { EntityFile, MemoryFile } from "./types.js";

interface CacheEntry {
  memories: Map<string, MemoryFile>; // keyed by file path
  version: number;
  loadedAt: number;
}

// Module-level singleton — shared across all StorageManager instances and sessions
const hotCacheByDir = new Map<string, CacheEntry>();
const archiveCacheByDir = new Map<string, CacheEntry>();

export function getCachedMemories(baseDir: string, currentVersion: number): MemoryFile[] | null {
  // Don't serve from cache when version tracking is unavailable (version=0).
  // This ensures tests and fresh installs without a version file always read disk.
  if (currentVersion === 0) return null;
  const entry = hotCacheByDir.get(baseDir);
  if (!entry || entry.version !== currentVersion) return null;
  return [...entry.memories.values()];
}

export function setCachedMemories(baseDir: string, memories: MemoryFile[], version: number): void {
  const map = new Map<string, MemoryFile>();
  for (const m of memories) map.set(m.path, m);
  hotCacheByDir.set(baseDir, { memories: map, version, loadedAt: Date.now() });
}

export function updateCacheOnWrite(baseDir: string, memory: MemoryFile): void {
  const entry = hotCacheByDir.get(baseDir);
  if (entry) entry.memories.set(memory.path, memory);
}

export function updateCacheOnDelete(baseDir: string, filePath: string): void {
  const entry = hotCacheByDir.get(baseDir);
  if (entry) entry.memories.delete(filePath);
}

// Archive cache — same pattern, separate store
export function getCachedArchivedMemories(baseDir: string, currentVersion: number): MemoryFile[] | null {
  if (currentVersion === 0) return null;
  const entry = archiveCacheByDir.get(baseDir);
  if (!entry || entry.version !== currentVersion) return null;
  return [...entry.memories.values()];
}

export function setCachedArchivedMemories(baseDir: string, memories: MemoryFile[], version: number): void {
  const map = new Map<string, MemoryFile>();
  for (const m of memories) map.set(m.path, m);
  archiveCacheByDir.set(baseDir, { memories: map, version, loadedAt: Date.now() });
}

// Entity cache — same pattern as memory cache
const entityCacheByDir = new Map<string, { entities: EntityFile[]; version: number; loadedAt: number }>();

export function getCachedEntities(baseDir: string, currentVersion: number): EntityFile[] | null {
  if (currentVersion === 0) return null;
  const entry = entityCacheByDir.get(baseDir);
  if (!entry || entry.version !== currentVersion) return null;
  return entry.entities;
}

export function setCachedEntities(baseDir: string, entities: EntityFile[], version: number): void {
  entityCacheByDir.set(baseDir, { entities, version, loadedAt: Date.now() });
}

export function clearMemoryCache(baseDir?: string): void {
  if (baseDir) {
    hotCacheByDir.delete(baseDir);
    archiveCacheByDir.delete(baseDir);
    entityCacheByDir.delete(baseDir);
  } else {
    hotCacheByDir.clear();
    archiveCacheByDir.clear();
    entityCacheByDir.clear();
  }
}

export function getMemoryCacheStats(baseDir: string): {
  hotSize: number;
  archiveSize: number;
  hotVersion: number | null;
  archiveVersion: number | null;
} {
  const hot = hotCacheByDir.get(baseDir);
  const archive = archiveCacheByDir.get(baseDir);
  return {
    hotSize: hot?.memories.size ?? 0,
    archiveSize: archive?.memories.size ?? 0,
    hotVersion: hot?.version ?? null,
    archiveVersion: archive?.version ?? null,
  };
}
