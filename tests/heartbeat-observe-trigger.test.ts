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
    heartbeatObserverChains: new Map<string, Promise<void>>(),
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
    shouldQueueExtraction: () => true,
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
    heartbeatObserverChains: new Map<string, Promise<void>>(),
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
    heartbeatObserverChains: new Map<string, Promise<void>>(),
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

test("observeSessionHeartbeat serializes per-session observer runs", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fake = {
    config: { sessionObserverEnabled: true },
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    transcript: {
      estimateSessionFootprint: async () => ({ bytes: 10_000, tokens: 2_000 }),
    },
    sessionObserver: {
      observe: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return {
          triggered: false,
          deltaBytes: 0,
          deltaTokens: 0,
          band: { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
        };
      },
    },
    buffer: {
      getTurns: () => [
        {
          role: "user",
          content: "serialized observer",
          timestamp: "2026-02-25T00:00:00.000Z",
          sessionKey: "agent:generalist:main",
        },
      ],
    },
    shouldQueueExtraction: () => true,
    queueBufferedExtraction: async () => {},
  };

  await Promise.all([
    (Orchestrator.prototype as any).observeSessionHeartbeat.call(
      fake,
      "agent:generalist:main",
    ),
    (Orchestrator.prototype as any).observeSessionHeartbeat.call(
      fake,
      "agent:generalist:main",
    ),
  ]);

  assert.equal(maxInFlight, 1);
});

test("observeSessionHeartbeat skips observer state update when extraction dedupe would reject", async () => {
  let observed = false;
  let queued = false;
  const fake = {
    config: { sessionObserverEnabled: true },
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    transcript: {
      estimateSessionFootprint: async () => ({ bytes: 25_000, tokens: 6_250 }),
    },
    sessionObserver: {
      observe: async () => {
        observed = true;
        return {
          triggered: true,
          deltaBytes: 6_500,
          deltaTokens: 1_500,
          band: { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
        };
      },
    },
    shouldQueueExtraction: () => false,
    buffer: {
      getTurns: () => [
        {
          role: "user",
          content: "dedupe candidate",
          timestamp: "2026-02-25T00:00:00.000Z",
          sessionKey: "agent:generalist:main",
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

  assert.equal(observed, false);
  assert.equal(queued, false);
});

test("shouldQueueExtraction supports non-committing dedupe prechecks", async () => {
  const turns: BufferTurn[] = [
    {
      role: "user",
      content: "same turn body",
      timestamp: "2026-02-25T00:00:00.000Z",
      sessionKey: "agent:generalist:main",
    },
  ];

  const fake = {
    config: {
      sessionObserverEnabled: true,
      extractionDedupeEnabled: true,
      extractionMaxTurnChars: 10_000,
      extractionDedupeWindowMs: 60_000,
    },
    recentExtractionFingerprints: new Map<string, number>(),
    shouldQueueExtraction: (Orchestrator.prototype as any).shouldQueueExtraction,
  };

  const precheck = fake.shouldQueueExtraction.call(fake, turns, { commit: false });
  assert.equal(precheck, true);
  assert.equal(fake.recentExtractionFingerprints.size, 0);

  const commit = fake.shouldQueueExtraction.call(fake, turns, { commit: true });
  assert.equal(commit, true);
  assert.equal(fake.recentExtractionFingerprints.size, 1);
});
