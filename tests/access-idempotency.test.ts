import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { AccessIdempotencyStore, setAccessIdempotencyTestHooks } from "../src/access-idempotency.js";

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

test("access idempotency store serializes concurrent flushes so neither key is dropped", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-lock-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);
    const verifier = new AccessIdempotencyStore(memoryDir);
    let releaseFirstWrite: (() => void) | null = null;
    const firstWritePaused = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteEnteredResolve: (() => void) | null = null;
    const firstWriteEntered = new Promise<void>((resolve) => {
      firstWriteEnteredResolve = resolve;
    });
    let flushWriteCalls = 0;

    setAccessIdempotencyTestHooks({
      beforeFlushWrite: async () => {
        flushWriteCalls += 1;
        if (flushWriteCalls === 1) {
          firstWriteEnteredResolve?.();
          await firstWritePaused;
        }
      },
    });

    try {
      const putA = storeA.put("key-a", "hash-a", { accepted: true });
      await firstWriteEntered;

      let putBResolved = false;
      const putB = storeB.put("key-b", "hash-b", { queued: true }).then(() => {
        putBResolved = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        putBResolved,
        false,
        "second writer should stay blocked until the first flush releases the shared lock",
      );

      releaseFirstWrite?.();
      await Promise.all([putA, putB]);
    } finally {
      setAccessIdempotencyTestHooks(null);
    }

    const readA = await verifier.get("key-a", "hash-a");
    const readB = await verifier.get("key-b", "hash-b");

    assert.deepEqual(readA.response, { accepted: true });
    assert.deepEqual(readB.response, { queued: true });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency store serializes concurrent writes on the same store instance", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-instance-"));
  try {
    const store = new AccessIdempotencyStore(memoryDir);
    const verifier = new AccessIdempotencyStore(memoryDir);
    let releaseFirstWrite: (() => void) | null = null;
    const firstWritePaused = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteEnteredResolve: (() => void) | null = null;
    const firstWriteEntered = new Promise<void>((resolve) => {
      firstWriteEnteredResolve = resolve;
    });
    let flushWriteCalls = 0;

    setAccessIdempotencyTestHooks({
      beforeFlushWrite: async () => {
        flushWriteCalls += 1;
        if (flushWriteCalls === 1) {
          firstWriteEnteredResolve?.();
          await firstWritePaused;
        }
      },
    });

    try {
      const putA = store.put("key-a", "hash-a", { accepted: true });
      await firstWriteEntered;

      let putBResolved = false;
      const putB = store.put("key-b", "hash-b", { queued: true }).then(() => {
        putBResolved = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        putBResolved,
        false,
        "second write on the same store should wait until the first write has finished mutating local state",
      );

      releaseFirstWrite?.();
      await Promise.all([putA, putB]);
    } finally {
      setAccessIdempotencyTestHooks(null);
    }

    const readA = await verifier.get("key-a", "hash-a");
    const readB = await verifier.get("key-b", "hash-b");

    assert.deepEqual(readA.response, { accepted: true });
    assert.deepEqual(readB.response, { queued: true });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("access idempotency key locks stay live while the guarded callback is still running", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-idempotency-key-heartbeat-"));
  try {
    const storeA = new AccessIdempotencyStore(memoryDir);
    const storeB = new AccessIdempotencyStore(memoryDir);
    let releaseFirstCallback: (() => void) | null = null;
    const firstCallbackPaused = new Promise<void>((resolve) => {
      releaseFirstCallback = resolve;
    });
    let firstCallbackEnteredResolve: (() => void) | null = null;
    const firstCallbackEntered = new Promise<void>((resolve) => {
      firstCallbackEnteredResolve = resolve;
    });

    setAccessIdempotencyTestHooks({
      lockTimeoutMs: 500,
      staleLockMs: 40,
      lockHeartbeatMs: 10,
    });

    try {
      const firstLock = storeA.withKeyLock("shared-key", async () => {
        firstCallbackEnteredResolve?.();
        await firstCallbackPaused;
      });
      await firstCallbackEntered;

      let secondLockResolved = false;
      const secondLock = storeB.withKeyLock("shared-key", async () => {
        secondLockResolved = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(
        secondLockResolved,
        false,
        "a live key lock should not be reclaimed as stale while its callback is still running",
      );

      releaseFirstCallback?.();
      await Promise.all([firstLock, secondLock]);
    } finally {
      setAccessIdempotencyTestHooks(null);
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
