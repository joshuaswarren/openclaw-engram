import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("StorageManager.readMemoryByPath returns synthetic MemoryFile for entity files (no frontmatter)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-storage-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    // Write a real entity file (no YAML frontmatter — uses # Name + **Type:** format)
    await storage.writeEntity("Jane Doe", "person", ["Works at Acme", "Likes TypeScript"]);

    // writeEntity uses normalizeEntityName which prefixes the type: "jane doe" → "person-jane-doe"
    const entityPath = path.join(dir, "entities", "person-jane-doe.md");
    const result = await storage.readMemoryByPath(entityPath);

    // Must return a MemoryFile (not null) so boostSearchResults and access-service
    // can process entity files surfaced by the direct retrieval agent.
    assert.ok(result !== null, "readMemoryByPath should return MemoryFile for entity files");
    assert.equal(result!.frontmatter.category, "entity");
    assert.equal(result!.frontmatter.id, "person-jane-doe");
    assert.ok(result!.frontmatter.tags.includes("person"), "tags should include entity type");
    assert.ok(result!.content.includes("Jane Doe"), "content should include entity name");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager.writeEntity tolerates malformed entity payloads (no throw)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-storage-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    let threw = false;
    try {
      const id = await storage.writeEntity(undefined as any, undefined as any, ["a", 1] as any);
      assert.equal(typeof id, "string");
    } catch {
      threw = true;
    }

    assert.equal(threw, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

