import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("StorageManager bumps memory status version on status-changing operations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-status-version-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const v0 = storage.getMemoryStatusVersion();
    assert.equal(v0, 0);

    const id1 = await storage.writeMemory("fact", "first memory", { source: "test" });
    const id2 = await storage.writeMemory("fact", "second memory", { source: "test" });

    const beforeSupersede = storage.getMemoryStatusVersion();
    const superseded = await storage.supersedeMemory(id1, id2, "newer replaces older");
    assert.equal(superseded, true);
    assert.equal(storage.getMemoryStatusVersion() > beforeSupersede, true);

    const memories = await storage.readAllMemories();
    const m2 = memories.find((m) => m.frontmatter.id === id2);
    assert.ok(m2);

    const beforeArchive = storage.getMemoryStatusVersion();
    const archivedPath = await storage.archiveMemory(m2);
    assert.equal(typeof archivedPath, "string");
    assert.equal(storage.getMemoryStatusVersion() > beforeArchive, true);

    const id3 = await storage.writeMemory("fact", "third memory", { source: "test" });
    const beforeInvalidate = storage.getMemoryStatusVersion();
    const invalidated = await storage.invalidateMemory(id3);
    assert.equal(invalidated, true);
    assert.equal(storage.getMemoryStatusVersion() > beforeInvalidate, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager status version is shared across instances for same memoryDir", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-status-version-shared-"));
  try {
    const writer = new StorageManager(dir);
    const reader = new StorageManager(dir);
    await writer.ensureDirectories();

    assert.equal(writer.getMemoryStatusVersion(), 0);
    assert.equal(reader.getMemoryStatusVersion(), 0);

    const id1 = await writer.writeMemory("fact", "shared one", { source: "test" });
    const id2 = await writer.writeMemory("fact", "shared two", { source: "test" });
    await writer.supersedeMemory(id1, id2, "shared status update");

    assert.equal(writer.getMemoryStatusVersion() > 0, true);
    assert.equal(reader.getMemoryStatusVersion(), writer.getMemoryStatusVersion());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
