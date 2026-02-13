import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

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

