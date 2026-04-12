import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "./orchestrator.js";
import type { BufferTurn } from "./types.js";

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-04-12T12:00:00.000Z",
    sessionKey,
  };
}

test("flushSession queues extraction for the targeted buffered session", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const turns = [makeTurn("thread-a", "remember alpha")];
  let queued: {
    turns: BufferTurn[];
    reason: string;
    options: Record<string, unknown> | undefined;
  } | null = null;

  orchestrator.buffer = {
    getTurns(bufferKey: string) {
      return bufferKey === "thread-a" ? turns : [];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    queuedTurns: BufferTurn[],
    reason: string,
    options?: Record<string, unknown>,
  ) => {
    queued = { turns: queuedTurns, reason, options };
  };

  await orchestrator.flushSession("thread-a", { reason: "before_reset" });

  assert.ok(queued);
  const queuedCall = queued as {
    turns: BufferTurn[];
    reason: string;
    options: Record<string, unknown> | undefined;
  };
  assert.equal(queuedCall.turns.length, 1);
  assert.equal(queuedCall.reason, "trigger_mode");
  assert.equal(queuedCall.options?.clearBufferAfterExtraction, true);
});

test("flushSession is a no-op when the targeted buffer is empty", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  let queued = false;

  orchestrator.buffer = {
    getTurns() {
      return [];
    },
  };
  orchestrator.queueBufferedExtraction = async () => {
    queued = true;
  };

  await orchestrator.flushSession("thread-a", { reason: "before_reset" });

  assert.equal(queued, false);
});
