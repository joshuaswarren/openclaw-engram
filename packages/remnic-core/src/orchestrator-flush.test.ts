import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "./orchestrator.js";
import { parseConfig } from "./config.js";
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
  assert.equal(queuedCall.options?.skipDedupeCheck, true);
  assert.equal(queuedCall.options?.abortSignal, undefined);
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

test("flushSession forwards abort signals into the queued extraction", async () => {
  const orchestrator = Object.create(Orchestrator.prototype) as any;
  const abortController = new AbortController();
  let queuedOptions: Record<string, unknown> | undefined;

  orchestrator.buffer = {
    getTurns() {
      return [makeTurn("thread-a", "remember alpha")];
    },
  };
  orchestrator.queueBufferedExtraction = async (
    _queuedTurns: BufferTurn[],
    _reason: string,
    options?: Record<string, unknown>,
  ) => {
    queuedOptions = options;
  };

  await orchestrator.flushSession("thread-a", {
    reason: "before_reset",
    abortSignal: abortController.signal,
  });

  assert.equal(queuedOptions?.abortSignal, abortController.signal);
});

test("runExtraction aborts before late buffer clearing when the caller cancels", async () => {
  const config = parseConfig({});
  config.extractionMinChars = 0;
  config.extractionMinUserTurns = 1;

  let clearCalls = 0;
  let persistCalls = 0;
  let resolveExtract!: (value: {
    facts: [];
    entities: [];
    questions: [];
    profileUpdates: [];
  }) => void;
  const extractPromise = new Promise<{
    facts: [];
    entities: [];
    questions: [];
    profileUpdates: [];
  }>((resolve) => {
    resolveExtract = resolve;
  });

  const orchestrator = Object.create(Orchestrator.prototype) as any;
  orchestrator.config = config;
  orchestrator.buffer = {
    clearAfterExtraction: async () => {
      clearCalls += 1;
    },
  };
  orchestrator.storageRouter = {
    storageFor: async () => ({
      listEntityNames: async () => [],
    }),
  };
  orchestrator.extraction = {
    extract: async () => extractPromise,
  };
  orchestrator.persistExtraction = async () => {
    persistCalls += 1;
    return [];
  };

  const abortController = new AbortController();
  const runPromise = orchestrator.runExtraction(
    [makeTurn("thread-a", "remember alpha")],
    {
      bufferKey: "thread-a",
      abortSignal: abortController.signal,
    },
  );

  abortController.abort();
  resolveExtract({
    facts: [],
    entities: [],
    questions: [],
    profileUpdates: [],
  });

  await assert.rejects(runPromise, /extraction aborted/i);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(clearCalls, 0);
  assert.equal(persistCalls, 0);
});
