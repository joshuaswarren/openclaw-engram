import test from "node:test";
import assert from "node:assert/strict";
import { SmartBuffer } from "./buffer.js";
import { parseConfig } from "./config.js";
import type { BufferState, BufferTurn } from "./types.js";

class FakeStorage {
  public saved: BufferState | null = null;

  constructor(private readonly initial: BufferState) {}

  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }

  async saveBuffer(state: BufferState): Promise<void> {
    this.saved = structuredClone(state);
  }
}

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-04-12T12:00:00.000Z",
    sessionKey,
  };
}

test("SmartBuffer keeps logical session buffers isolated", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha memory"));
  await buffer.addTurn("thread-b", makeTurn("thread-b", "beta memory"));

  assert.equal(buffer.getTurns("thread-a").length, 1);
  assert.equal(buffer.getTurns("thread-a")[0]?.content, "alpha memory");
  assert.equal(buffer.getTurns("thread-b").length, 1);
  assert.equal(buffer.getTurns("thread-b")[0]?.content, "beta memory");
});

test("SmartBuffer clearAfterExtraction only clears the targeted logical session", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha memory"));
  await buffer.addTurn("thread-b", makeTurn("thread-b", "beta memory"));
  await buffer.clearAfterExtraction("thread-a");

  assert.equal(buffer.getTurns("thread-a").length, 0);
  assert.equal(buffer.getTurns("thread-b").length, 1);
  assert.equal(buffer.getExtractionCount("thread-a"), 1);
  assert.equal(buffer.getExtractionCount("thread-b"), 0);
});

test("SmartBuffer read-only accessors do not persist phantom entries for unknown buffers", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  assert.deepEqual(buffer.getTurns("missing-thread"), []);
  assert.equal(buffer.getExtractionCount("missing-thread"), 0);

  await buffer.addTurn("thread-a", makeTurn("thread-a", "alpha memory"));

  assert.ok(storage.saved);
  assert.deepEqual(Object.keys(storage.saved?.entries ?? {}).sort(), ["default", "thread-a"]);
});

test("SmartBuffer can recover a logical buffer key from a raw session key", async () => {
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    entries: {
      default: {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      },
      "codex-thread:thread-22::principal:cli": {
        turns: [
          {
            ...makeTurn("session-z", "gamma memory"),
            logicalSessionKey: "codex-thread:thread-22",
          },
        ],
        lastExtractionAt: null,
        extractionCount: 0,
      },
    },
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  const resolved = await buffer.findBufferKeyForSession("session-z");

  assert.equal(resolved, "codex-thread:thread-22::principal:cli");
});

test("SmartBuffer prunes stale logical session buffers to a bounded entry set", async () => {
  const entries = Object.fromEntries(
    Array.from({ length: 205 }, (_, index) => [
      `thread-${index}`,
      {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      },
    ]),
  );
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    entries: {
      default: {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      },
      ...entries,
    },
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("active-thread", makeTurn("active-thread", "pending memory"));

  const persistedKeys = Object.keys(storage.saved?.entries ?? {});
  assert.equal(persistedKeys.length, 200);
  assert.ok(persistedKeys.includes("default"));
  assert.ok(persistedKeys.includes("active-thread"));
  assert.ok(persistedKeys.includes("thread-204"));
  assert.ok(!persistedKeys.includes("thread-0"));
});

test("SmartBuffer never prunes logical session buffers that still have pending turns", async () => {
  const entries = Object.fromEntries(
    Array.from({ length: 205 }, (_, index) => [
      `thread-${index}`,
      {
        turns: [makeTurn(`thread-${index}`, `memory ${index}`)],
        lastExtractionAt: null,
        extractionCount: 0,
      },
    ]),
  );
  const storage = new FakeStorage({
    turns: [],
    lastExtractionAt: null,
    extractionCount: 0,
    entries: {
      default: {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
      },
      ...entries,
    },
  });
  const buffer = new SmartBuffer(parseConfig({}), storage as any);

  await buffer.addTurn("active-thread", makeTurn("active-thread", "pending memory"));

  const persistedKeys = Object.keys(storage.saved?.entries ?? {});
  assert.equal(persistedKeys.length, 207);
  assert.ok(persistedKeys.includes("default"));
  assert.ok(persistedKeys.includes("active-thread"));
  assert.ok(persistedKeys.includes("thread-0"));
  assert.ok(persistedKeys.includes("thread-204"));
});
