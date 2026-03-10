import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { AccessIdempotencyStore } from "../src/access-idempotency.js";

test("access idempotency store refreshes when another process writes a key", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-refresh-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);

    await storeA.get("shared-key", "hash-a");
    await storeB.put("shared-key", "hash-a", { accepted: true, memoryId: "fact-1" });

    const cachedRead = await storeA.get("shared-key", "hash-a");
    assert.equal(cachedRead.conflict, false);
    assert.deepEqual(cachedRead.response, { accepted: true, memoryId: "fact-1" });

    const conflictRead = await storeA.get("shared-key", "hash-b");
    assert.equal(conflictRead.conflict, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency store merges shared state before flushing a local write", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-merge-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);
    const storeC = new AccessIdempotencyStore(memoryDir);

    await storeA.get("load-first", "hash-load");
    await storeB.put("key-b", "hash-b", { queued: true });
    await storeA.put("key-a", "hash-a", { queued: false });

    const readA = await storeC.get("key-a", "hash-a");
    const readB = await storeC.get("key-b", "hash-b");

    assert.deepEqual(readA.response, { queued: false });
    assert.deepEqual(readB.response, { queued: true });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
