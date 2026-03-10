import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { AccessIdempotencyStore } from "../src/access-idempotency.js";

test("access idempotency store reloads cross-process writes on get", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-get-"));
  try {
    const writer = new AccessIdempotencyStore(memoryDir);
    const reader = new AccessIdempotencyStore(memoryDir);

    assert.deepEqual(await reader.get("shared-key", "hash-a"), { conflict: false });

    await writer.put("shared-key", "hash-a", { status: "stored", memoryId: "fact-1" });

    assert.deepEqual(await reader.get("shared-key", "hash-a"), {
      conflict: false,
      response: { status: "stored", memoryId: "fact-1" },
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency store reloads before put so it preserves other process keys", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-put-"));
  try {
    const first = new AccessIdempotencyStore(memoryDir);
    const second = new AccessIdempotencyStore(memoryDir);

    await first.put("key-a", "hash-a", { status: "stored", memoryId: "fact-a" });
    await second.put("key-b", "hash-b", { status: "stored", memoryId: "fact-b" });

    assert.deepEqual(await first.get("key-a", "hash-a"), {
      conflict: false,
      response: { status: "stored", memoryId: "fact-a" },
    });
    assert.deepEqual(await first.get("key-b", "hash-b"), {
      conflict: false,
      response: { status: "stored", memoryId: "fact-b" },
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
