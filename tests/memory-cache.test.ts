import test from "node:test";
import assert from "node:assert/strict";
import {
  getCachedMemories,
  setCachedMemories,
  getCachedArchivedMemories,
  setCachedArchivedMemories,
  getCachedEntities,
  setCachedEntities,
  updateCacheOnWrite,
  updateCacheOnDelete,
  clearMemoryCache,
  getMemoryCacheStats,
} from "../src/memory-cache.ts";
import type { EntityFile, MemoryFile } from "../src/types.ts";

function makeMemory(id: string, filePath: string): MemoryFile {
  return {
    path: filePath,
    frontmatter: {
      id,
      category: "fact",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
    content: `Memory content for ${id}`,
  };
}

test("getCachedMemories returns null on cold cache", () => {
  clearMemoryCache();
  const result = getCachedMemories("/some/dir", 0);
  assert.equal(result, null);
});

test("after setCachedMemories, getCachedMemories returns the memories", () => {
  clearMemoryCache();
  const dir = "/test/set-get";
  const m1 = makeMemory("m1", `${dir}/facts/m1.md`);
  const m2 = makeMemory("m2", `${dir}/facts/m2.md`);
  setCachedMemories(dir, [m1, m2], 5);
  const result = getCachedMemories(dir, 5);
  assert.ok(result);
  assert.equal(result.length, 2);
  const ids = result.map((m) => m.frontmatter.id).sort();
  assert.deepEqual(ids, ["m1", "m2"]);
});

test("getCachedMemories returns null when version does not match", () => {
  clearMemoryCache();
  const dir = "/test/version-mismatch";
  const m1 = makeMemory("m1", `${dir}/facts/m1.md`);
  setCachedMemories(dir, [m1], 3);
  const result = getCachedMemories(dir, 4);
  assert.equal(result, null);
});

test("updateCacheOnWrite adds to existing cache", () => {
  clearMemoryCache();
  const dir = "/test/update-write";
  const m1 = makeMemory("m1", `${dir}/facts/m1.md`);
  setCachedMemories(dir, [m1], 1);

  const m2 = makeMemory("m2", `${dir}/facts/m2.md`);
  updateCacheOnWrite(dir, m2);

  const result = getCachedMemories(dir, 1);
  assert.ok(result);
  assert.equal(result.length, 2);
});

test("updateCacheOnDelete removes from cache", () => {
  clearMemoryCache();
  const dir = "/test/update-delete";
  const m1 = makeMemory("m1", `${dir}/facts/m1.md`);
  const m2 = makeMemory("m2", `${dir}/facts/m2.md`);
  setCachedMemories(dir, [m1, m2], 1);

  updateCacheOnDelete(dir, m1.path);

  const result = getCachedMemories(dir, 1);
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].frontmatter.id, "m2");
});

test("clearMemoryCache clears everything", () => {
  clearMemoryCache();
  const dir1 = "/test/clear-1";
  const dir2 = "/test/clear-2";
  setCachedMemories(dir1, [makeMemory("a", `${dir1}/a.md`)], 1);
  setCachedMemories(dir2, [makeMemory("b", `${dir2}/b.md`)], 1);
  setCachedArchivedMemories(dir1, [makeMemory("c", `${dir1}/c.md`)], 1);

  clearMemoryCache();

  assert.equal(getCachedMemories(dir1, 1), null);
  assert.equal(getCachedMemories(dir2, 1), null);
  assert.equal(getCachedArchivedMemories(dir1, 1), null);
});

test("clearMemoryCache with specific dir clears only that dir", () => {
  clearMemoryCache();
  const dir1 = "/test/selective-1";
  const dir2 = "/test/selective-2";
  setCachedMemories(dir1, [makeMemory("a", `${dir1}/a.md`)], 1);
  setCachedMemories(dir2, [makeMemory("b", `${dir2}/b.md`)], 1);

  clearMemoryCache(dir1);

  assert.equal(getCachedMemories(dir1, 1), null);
  assert.ok(getCachedMemories(dir2, 1));
});

test("cache is shared across callers (set from one context, read from another)", () => {
  clearMemoryCache();
  const dir = "/test/shared";
  const m1 = makeMemory("shared-1", `${dir}/facts/shared-1.md`);

  // Simulate one StorageManager setting the cache
  setCachedMemories(dir, [m1], 10);

  // Simulate another StorageManager reading it
  const result = getCachedMemories(dir, 10);
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].frontmatter.id, "shared-1");
});

test("archive cache works independently of hot cache", () => {
  clearMemoryCache();
  const dir = "/test/archive-separate";
  const hotMem = makeMemory("hot-1", `${dir}/facts/hot-1.md`);
  const archiveMem = makeMemory("arch-1", `${dir}/archive/arch-1.md`);

  setCachedMemories(dir, [hotMem], 1);
  setCachedArchivedMemories(dir, [archiveMem], 1);

  const hotResult = getCachedMemories(dir, 1);
  const archiveResult = getCachedArchivedMemories(dir, 1);

  assert.ok(hotResult);
  assert.equal(hotResult.length, 1);
  assert.equal(hotResult[0].frontmatter.id, "hot-1");

  assert.ok(archiveResult);
  assert.equal(archiveResult.length, 1);
  assert.equal(archiveResult[0].frontmatter.id, "arch-1");
});

test("getMemoryCacheStats returns correct sizes and versions", () => {
  clearMemoryCache();
  const dir = "/test/stats";

  let stats = getMemoryCacheStats(dir);
  assert.equal(stats.hotSize, 0);
  assert.equal(stats.archiveSize, 0);
  assert.equal(stats.hotVersion, null);
  assert.equal(stats.archiveVersion, null);

  setCachedMemories(dir, [makeMemory("a", `${dir}/a.md`), makeMemory("b", `${dir}/b.md`)], 7);
  setCachedArchivedMemories(dir, [makeMemory("c", `${dir}/c.md`)], 3);

  stats = getMemoryCacheStats(dir);
  assert.equal(stats.hotSize, 2);
  assert.equal(stats.archiveSize, 1);
  assert.equal(stats.hotVersion, 7);
  assert.equal(stats.archiveVersion, 3);
});

// --- Entity cache tests ---

function makeEntity(name: string): EntityFile {
  return {
    name,
    type: "person",
    updated: new Date().toISOString(),
    facts: [`${name} is a test entity`],
    timeline: [],
    relationships: [],
    activity: [],
    aliases: [],
  };
}

test("getCachedEntities returns null on cold cache", () => {
  clearMemoryCache();
  const result = getCachedEntities("/some/dir", 0);
  assert.equal(result, null);
});

test("after setCachedEntities, getCachedEntities returns the entities", () => {
  clearMemoryCache();
  const dir = "/test/entity-set-get";
  const e1 = makeEntity("Alice");
  const e2 = makeEntity("Bob");
  setCachedEntities(dir, [e1, e2], 5);
  const result = getCachedEntities(dir, 5);
  assert.ok(result);
  assert.equal(result.length, 2);
  const names = result.map((e) => e.name).sort();
  assert.deepEqual(names, ["Alice", "Bob"]);
});

test("getCachedEntities returns null when version does not match", () => {
  clearMemoryCache();
  const dir = "/test/entity-version-mismatch";
  const e1 = makeEntity("Alice");
  setCachedEntities(dir, [e1], 3);
  const result = getCachedEntities(dir, 4);
  assert.equal(result, null);
});

test("clearMemoryCache also clears entity cache", () => {
  clearMemoryCache();
  const dir = "/test/entity-clear";
  setCachedEntities(dir, [makeEntity("Alice")], 1);
  assert.ok(getCachedEntities(dir, 1));

  clearMemoryCache();

  assert.equal(getCachedEntities(dir, 1), null);
});
