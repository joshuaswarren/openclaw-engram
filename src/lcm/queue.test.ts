import test from "node:test";
import assert from "node:assert/strict";
import { LcmWorkQueue } from "./queue.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("LcmWorkQueue coalesces duplicate pending jobs per session", async () => {
  const blocker = deferred();
  const executionOrder: string[] = [];

  const queue = new LcmWorkQueue({
    concurrency: 1,
    worker: async (sessionId) => {
      executionOrder.push(sessionId);
      if (sessionId === "blocked") {
        await blocker.promise;
      }
    },
  });

  queue.enqueue("blocked", [{ role: "user", content: "hold" }]);
  queue.enqueue("session-a", [{ role: "user", content: "one" }]);
  queue.enqueue("session-a", [{ role: "assistant", content: "two" }]);

  await Promise.resolve();

  assert.equal(queue.inFlightCount, 1);
  assert.equal(queue.depth, 1);

  blocker.resolve();
  await queue.whenIdle();

  assert.deepEqual(executionOrder, ["blocked", "session-a"]);
  assert.equal(queue.inFlightCount, 0);
  assert.equal(queue.depth, 0);
});

test("LcmWorkQueue continues after a worker failure", async () => {
  const seen: string[] = [];

  const queue = new LcmWorkQueue({
    concurrency: 1,
    worker: async (sessionId) => {
      seen.push(sessionId);
      if (sessionId === "session-a") {
        throw new Error("boom");
      }
    },
  });

  queue.enqueue("session-a", [{ role: "user", content: "one" }]);
  queue.enqueue("session-b", [{ role: "assistant", content: "two" }]);

  await queue.whenIdle();

  assert.deepEqual(seen, ["session-a", "session-b"]);
  assert.equal(queue.inFlightCount, 0);
  assert.equal(queue.depth, 0);
});
