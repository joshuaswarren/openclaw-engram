import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../packages/remnic-core/src/config.ts";

test("parseConfig defaults the new OpenClaw runtime-surface settings", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });

  assert.deepEqual(cfg.slotBehavior, {
    requireExclusiveMemorySlot: true,
    onSlotMismatch: "error",
  });
  assert.equal(cfg.beforeResetTimeoutMs, 2000);
  assert.equal(cfg.flushOnResetEnabled, true);
  assert.equal(cfg.commandsListEnabled, true);
  assert.deepEqual(cfg.dreaming, {
    enabled: false,
    journalPath: "DREAMS.md",
    maxEntries: 500,
    injectRecentCount: 3,
  });
  assert.deepEqual(cfg.codexCompat, {
    enabled: true,
    threadIdBufferKeying: true,
    compactionFlushMode: "auto",
    fingerprintDedup: true,
  });
});

test("parseConfig preserves explicit disables and clamps timeout and dreaming bounds", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    slotBehavior: {
      requireExclusiveMemorySlot: false,
      onSlotMismatch: "silent",
    },
    beforeResetTimeoutMs: 25,
    flushOnResetEnabled: false,
    commandsListEnabled: false,
    dreaming: {
      enabled: true,
      journalPath: "notes/DREAMS.md",
      maxEntries: 5,
      injectRecentCount: 99,
    },
    codexCompat: {
      enabled: false,
      threadIdBufferKeying: false,
      compactionFlushMode: "heuristic",
      fingerprintDedup: false,
    },
  });

  assert.deepEqual(cfg.slotBehavior, {
    requireExclusiveMemorySlot: false,
    onSlotMismatch: "silent",
  });
  assert.equal(cfg.beforeResetTimeoutMs, 100);
  assert.equal(cfg.flushOnResetEnabled, false);
  assert.equal(cfg.commandsListEnabled, false);
  assert.deepEqual(cfg.dreaming, {
    enabled: true,
    journalPath: "notes/DREAMS.md",
    maxEntries: 10,
    injectRecentCount: 20,
  });
  assert.deepEqual(cfg.codexCompat, {
    enabled: false,
    threadIdBufferKeying: false,
    compactionFlushMode: "heuristic",
    fingerprintDedup: false,
  });
});
