import assert from "node:assert/strict";
import test from "node:test";

import { Orchestrator } from "./orchestrator.js";
import { initLogger, type LoggerBackend } from "./logger.js";
import { abortError } from "./abort-error.js";

interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  err?: unknown;
}

function installCapturingLogger(): { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const backend: LoggerBackend = {
    info(message) {
      entries.push({ level: "info", message });
    },
    warn(message) {
      entries.push({ level: "warn", message });
    },
    error(message, err) {
      entries.push({ level: "error", message, err });
    },
    debug(message) {
      entries.push({ level: "debug", message });
    },
  };
  initLogger(backend, true);
  return { entries };
}

type QueueOrchestrator = {
  extractionQueue: Array<() => Promise<void>>;
  queueProcessing: boolean;
  processQueue: () => Promise<void>;
};

function createQueueOrchestrator(): QueueOrchestrator {
  const orch = Object.create(Orchestrator.prototype) as QueueOrchestrator;
  orch.extractionQueue = [];
  orch.queueProcessing = true;
  return orch;
}

// ── Issue #549 ─────────────────────────────────────────────────────────────

test("processQueue logs an AbortError task at debug, not error (#549)", async () => {
  // Regression for issue #549: session transitions fire the abort
  // signal, and queued extraction tasks that pick it up throw via
  // `throwIfRecallAborted` (an Error with `name === "AbortError"`).
  // That is intentional deduplication, not a failure.  The queue
  // processor must log it at debug.
  const { entries } = installCapturingLogger();
  const orch = createQueueOrchestrator();
  orch.extractionQueue.push(async () => {
    throw abortError("extraction aborted (before_extract)");
  });
  await orch.processQueue();

  const errorEntries = entries.filter((e) => e.level === "error");
  const debugEntries = entries.filter(
    (e) => e.level === "debug" && e.message.includes("aborted"),
  );
  assert.equal(
    errorEntries.length,
    0,
    `expected no error logs for abort; got ${errorEntries.map((e) => e.message).join(", ")}`,
  );
  assert.ok(
    debugEntries.some((e) =>
      e.message.includes("background extraction task aborted"),
    ),
    "expected a debug log describing the session-transition abort",
  );
});

test("processQueue still logs real task failures at error", async () => {
  // Guard the other half: non-abort errors (network, parse, I/O) must
  // continue to log at error level.
  const { entries } = installCapturingLogger();
  const orch = createQueueOrchestrator();
  orch.extractionQueue.push(async () => {
    throw new Error("upstream LLM 500");
  });
  await orch.processQueue();

  const errorEntries = entries.filter((e) => e.level === "error");
  assert.equal(errorEntries.length, 1);
  assert.ok(
    errorEntries[0]?.message.includes("background extraction task failed"),
    `expected failed-task message; got ${errorEntries[0]?.message}`,
  );
});

test("processQueue handles a mixed run — abort goes to debug, failure to error", async () => {
  const { entries } = installCapturingLogger();
  const orch = createQueueOrchestrator();
  orch.extractionQueue.push(async () => {
    throw abortError("extraction aborted (before_clear_buffer)");
  });
  orch.extractionQueue.push(async () => {
    throw new Error("I/O failure");
  });
  await orch.processQueue();

  const errorCount = entries.filter((e) => e.level === "error").length;
  const abortDebugCount = entries.filter(
    (e) =>
      e.level === "debug" &&
      e.message.includes("background extraction task aborted"),
  ).length;
  assert.equal(errorCount, 1, "one real failure should log at error");
  assert.equal(
    abortDebugCount,
    1,
    "one abort should log at debug",
  );
});

test("processQueue clears queueProcessing on exit regardless of task outcomes", async () => {
  installCapturingLogger();
  const orch = createQueueOrchestrator();
  orch.extractionQueue.push(async () => {
    throw abortError("extraction aborted");
  });
  await orch.processQueue();
  assert.equal(orch.queueProcessing, false);
});
