import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.ts";
import type { BufferTurn } from "../src/types.js";

test("observeSessionHeartbeat queues buffered extraction when observer threshold triggers", async () => {
  const turns: BufferTurn[] = [
    {
      role: "user",
      content: "Need a continuity check on this thread state.",
      timestamp: "2026-02-25T00:00:00.000Z",
      sessionKey: "agent:generalist:main",
    },
  ];

  let queued = false;
  let queuedReason: string | null = null;

  const fake = {
    config: { sessionObserverEnabled: true },
    transcript: {
      estimateSessionFootprint: async () => ({ bytes: 25_000, tokens: 6_250 }),
    },
    sessionObserver: {
      observe: async () => ({
        triggered: true,
        deltaBytes: 6_500,
        deltaTokens: 1_500,
        band: { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
      }),
    },
    buffer: {
      getTurns: () => turns,
    },
    queueBufferedExtraction: async (_turns: BufferTurn[], reason: string) => {
      queued = true;
      queuedReason = reason;
    },
  };

  await (Orchestrator.prototype as any).observeSessionHeartbeat.call(
    fake,
    "agent:generalist:main",
  );

  assert.equal(queued, true);
  assert.equal(queuedReason, "heartbeat_observer");
});

test("observeSessionHeartbeat no-ops when observer is disabled", async () => {
  let invoked = false;
  const fake = {
    config: { sessionObserverEnabled: false },
    transcript: {
      estimateSessionFootprint: async () => {
        invoked = true;
        return { bytes: 0, tokens: 0 };
      },
    },
    sessionObserver: {
      observe: async () => {
        invoked = true;
        return { triggered: false, deltaBytes: 0, deltaTokens: 0, band: { maxBytes: 1, triggerDeltaBytes: 1, triggerDeltaTokens: 1 } };
      },
    },
    buffer: { getTurns: () => [] },
    queueBufferedExtraction: async () => {
      invoked = true;
    },
  };

  await (Orchestrator.prototype as any).observeSessionHeartbeat.call(
    fake,
    "agent:generalist:main",
  );

  assert.equal(invoked, false);
});

test("observeSessionHeartbeat skips when buffer contains mixed session turns", async () => {
  let queued = false;
  const fake = {
    config: { sessionObserverEnabled: true },
    transcript: {
      estimateSessionFootprint: async () => ({ bytes: 25_000, tokens: 6_250 }),
    },
    sessionObserver: {
      observe: async () => ({
        triggered: true,
        deltaBytes: 6_500,
        deltaTokens: 1_500,
        band: { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
      }),
    },
    buffer: {
      getTurns: () => [
        {
          role: "user",
          content: "session A",
          timestamp: "2026-02-25T00:00:00.000Z",
          sessionKey: "agent:generalist:main",
        },
        {
          role: "assistant",
          content: "session B",
          timestamp: "2026-02-25T00:00:01.000Z",
          sessionKey: "agent:research:main",
        },
      ],
    },
    queueBufferedExtraction: async () => {
      queued = true;
    },
  };

  await (Orchestrator.prototype as any).observeSessionHeartbeat.call(
    fake,
    "agent:generalist:main",
  );

  assert.equal(queued, false);
});

test("queueBufferedExtraction preserves buffered turns when dedupe skips enqueue", async () => {
  let cleared = false;
  let queued = false;
  const fake = {
    shouldQueueExtraction: () => false,
    buffer: {
      clearAfterExtraction: async () => {
        cleared = true;
      },
    },
    extractionQueue: {
      push: () => {
        queued = true;
      },
    },
  };

  await (Orchestrator.prototype as any).queueBufferedExtraction.call(
    fake,
    [{ role: "user", content: "dup", timestamp: "2026-02-25T00:00:00.000Z" }],
    "heartbeat_observer",
  );

  assert.equal(queued, false);
  assert.equal(cleared, false);
});
