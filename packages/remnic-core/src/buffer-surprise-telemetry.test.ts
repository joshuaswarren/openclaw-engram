/**
 * Tests for buffer-surprise telemetry (issue #563 PR 3).
 *
 * Covers two concerns:
 *
 *  1. SmartBuffer emits one `BUFFER_SURPRISE` row per scored turn and
 *     NEVER emits when the probe was not consulted (flag off, non-smart
 *     trigger mode, high signal, or decision was not `keep_buffering`).
 *     Probe returning `null`, throwing, or producing a non-finite score
 *     must NOT write a row.
 *
 *  2. `reportBufferSurpriseDistribution` produces stable summary stats
 *     over the recent window — mean, median, p90, triggered rate — and
 *     returns the empty-distribution shape when no rows are available.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SmartBuffer, type BufferSurpriseProbe } from "./buffer.js";
import { parseConfig } from "./config.js";
import { reportBufferSurpriseDistribution } from "./buffer-surprise-report.js";
import type {
  BufferState,
  BufferSurpriseEvent,
  BufferTurn,
} from "./types.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class RecordingStorage {
  public saved: BufferState | null = null;
  public events: BufferSurpriseEvent[] = [];

  constructor(private readonly initial: BufferState) {}

  async loadBuffer(): Promise<BufferState> {
    return structuredClone(this.initial);
  }

  async saveBuffer(state: BufferState): Promise<void> {
    this.saved = structuredClone(state);
  }

  async appendBufferSurpriseEvents(events: BufferSurpriseEvent[]): Promise<number> {
    this.events.push(...events);
    return events.length;
  }
}

function makeTurn(sessionKey: string, content: string): BufferTurn {
  return {
    role: "user",
    content,
    timestamp: "2026-04-20T12:00:00.000Z",
    sessionKey,
  };
}

function emptyBuffer(): BufferState {
  return { turns: [], lastExtractionAt: null, extractionCount: 0 };
}

function fixedScoreProbe(score: number | null): BufferSurpriseProbe {
  return {
    async scoreTurn() {
      return score;
    },
  };
}

// ---------------------------------------------------------------------------
// SmartBuffer emission
// ---------------------------------------------------------------------------

test("emits one BUFFER_SURPRISE row per scored turn (triggering)", async () => {
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.9));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "novel"));

  assert.equal(storage.events.length, 1);
  const row = storage.events[0]!;
  assert.equal(row.event, "BUFFER_SURPRISE");
  assert.equal(row.triggeredFlush, true);
  assert.equal(row.surpriseScore, 0.9);
  assert.equal(row.threshold, 0.35);
  assert.equal(row.turnRole, "user");
  assert.equal(row.bufferKey, "sess-1");
  assert.equal(row.sessionKey, "sess-1");
  assert.equal(row.turnCountInWindow, 1);
  assert.ok(
    typeof row.timestamp === "string" && row.timestamp.length > 0,
    "timestamp must be a non-empty ISO string",
  );
});

test("emits BUFFER_SURPRISE row for non-triggering turns too", async () => {
  // The whole point of telemetry is tuning the threshold from real
  // distributions, so below-threshold scores must also be recorded.
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.1));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "routine"));

  assert.equal(storage.events.length, 1);
  assert.equal(storage.events[0]!.triggeredFlush, false);
  assert.equal(storage.events[0]!.surpriseScore, 0.1);
});

test("does NOT emit when flag is off", async () => {
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: false,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.9));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "anything"));
  assert.equal(storage.events.length, 0);
});

test("does NOT emit when probe returns null", async () => {
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(null));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "anything"));
  assert.equal(storage.events.length, 0);
});

test("does NOT emit when probe throws", async () => {
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    triggerMode: "smart",
  });
  const probe: BufferSurpriseProbe = {
    async scoreTurn() {
      throw new Error("embedder down");
    },
  };
  const buffer = new SmartBuffer(config, storage as any, probe);

  await buffer.addTurn("sess-1", makeTurn("sess-1", "anything"));
  assert.equal(storage.events.length, 0);
});

test("does NOT emit when probe returns NaN", async () => {
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(
    config,
    storage as any,
    fixedScoreProbe(Number.NaN),
  );

  await buffer.addTurn("sess-1", makeTurn("sess-1", "anything"));
  assert.equal(storage.events.length, 0);
});

test("does NOT emit when high-signal path already flushes", async () => {
  // High-signal decisions short-circuit before the probe is consulted,
  // so no row must be recorded for them.
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    triggerMode: "smart",
    highSignalPatterns: ["\\bURGENT\\b"],
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.9));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "URGENT heads up"));
  assert.equal(storage.events.length, 0);
});

test("does NOT emit when turn-count path already flushes (extract_batch)", async () => {
  // Additive invariant: existing batch flush does not consult the probe.
  const storage = new RecordingStorage(emptyBuffer());
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferMaxTurns: 2,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.9));

  await buffer.addTurn("sess-1", makeTurn("sess-1", "first"));
  // first turn WAS scored (decision was keep_buffering)
  assert.equal(storage.events.length, 1);

  const before = storage.events.length;
  await buffer.addTurn("sess-1", makeTurn("sess-1", "second"));
  // second turn flushes via turn-count; probe is not consulted → no new row.
  assert.equal(storage.events.length, before);
});

test("works with legacy StorageManager lacking appendBufferSurpriseEvents", async () => {
  // The buffer must feature-detect the sink and silently skip when the
  // host's storage double is on the old surface.
  class LegacyStorage {
    public saved: BufferState | null = null;
    async loadBuffer(): Promise<BufferState> {
      return emptyBuffer();
    }
    async saveBuffer(state: BufferState) {
      this.saved = state;
    }
  }
  const storage = new LegacyStorage();
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, fixedScoreProbe(0.9));

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "anything"),
  );
  // Core decision still works — only the telemetry path no-ops.
  assert.equal(decision, "extract_now");
});

// ---------------------------------------------------------------------------
// reportBufferSurpriseDistribution
// ---------------------------------------------------------------------------

function syntheticRow(
  score: number,
  triggered: boolean,
  ts = "2026-04-20T12:00:00.000Z",
): BufferSurpriseEvent {
  return {
    event: "BUFFER_SURPRISE",
    timestamp: ts,
    bufferKey: "sess-x",
    sessionKey: "sess-x",
    turnRole: "user",
    surpriseScore: score,
    threshold: 0.35,
    triggeredFlush: triggered,
    turnCountInWindow: 1,
  };
}

test("report: empty ledger returns zeros, currentThreshold=null", async () => {
  const dist = await reportBufferSurpriseDistribution(async () => []);
  assert.equal(dist.count, 0);
  assert.equal(dist.triggeredCount, 0);
  assert.equal(dist.triggeredRate, 0);
  assert.equal(dist.mean, 0);
  assert.equal(dist.median, 0);
  assert.equal(dist.p90, 0);
  assert.equal(dist.currentThreshold, null);
});

test("report: computes mean, median, p90 over recent rows", async () => {
  const rows: BufferSurpriseEvent[] = [
    syntheticRow(0.1, false),
    syntheticRow(0.2, false),
    syntheticRow(0.3, false),
    syntheticRow(0.4, true),
    syntheticRow(0.5, true),
    syntheticRow(0.9, true),
  ];
  const dist = await reportBufferSurpriseDistribution(async () => rows);
  assert.equal(dist.count, 6);
  assert.equal(dist.triggeredCount, 3);
  assert.ok(Math.abs(dist.triggeredRate - 0.5) < 1e-9);
  assert.ok(Math.abs(dist.mean - (0.1 + 0.2 + 0.3 + 0.4 + 0.5 + 0.9) / 6) < 1e-9);
  // nearest-rank p50 over 6 → rank 3 → 0.3
  assert.equal(dist.median, 0.3);
  // nearest-rank p90 over 6 → ceil(5.4)=6 → 0.9
  assert.equal(dist.p90, 0.9);
  assert.equal(dist.min, 0.1);
  assert.equal(dist.max, 0.9);
  assert.equal(dist.currentThreshold, 0.35);
});

test("report: skips malformed rows (wrong event tag, non-finite score, out of range)", async () => {
  const rows: any[] = [
    syntheticRow(0.1, false),
    { event: "SOMETHING_ELSE", surpriseScore: 0.99 },
    { event: "BUFFER_SURPRISE", surpriseScore: Number.POSITIVE_INFINITY },
    { event: "BUFFER_SURPRISE", surpriseScore: -0.1 },
    { event: "BUFFER_SURPRISE", surpriseScore: 1.1 },
    syntheticRow(0.9, true),
  ];
  const dist = await reportBufferSurpriseDistribution(async () => rows);
  assert.equal(dist.count, 2);
  assert.equal(dist.min, 0.1);
  assert.equal(dist.max, 0.9);
});

test("report: `since` filter excludes rows at or before the boundary", async () => {
  const rows: BufferSurpriseEvent[] = [
    syntheticRow(0.1, false, "2026-04-19T00:00:00.000Z"),
    syntheticRow(0.5, true, "2026-04-20T00:00:00.000Z"),
    syntheticRow(0.9, true, "2026-04-20T12:00:00.000Z"),
  ];
  const dist = await reportBufferSurpriseDistribution(async () => rows, {
    since: "2026-04-20T00:00:00.000Z",
  });
  // Boundary is exclusive: the exactly-equal row at 00:00:00 is filtered.
  assert.equal(dist.count, 1);
  assert.equal(dist.min, 0.9);
  assert.equal(dist.max, 0.9);
});

test("report: limit is forwarded to the reader callback", async () => {
  let seen: number | undefined;
  const reader = async (options: { limit?: number }) => {
    seen = options.limit;
    return [] as BufferSurpriseEvent[];
  };
  await reportBufferSurpriseDistribution(reader, { limit: 42 });
  assert.equal(seen, 42);
});

test("report: defaults limit to 200 when omitted", async () => {
  let seen: number | undefined;
  await reportBufferSurpriseDistribution(
    async (options) => {
      seen = options.limit;
      return [];
    },
  );
  assert.equal(seen, 200);
});

test("report: single-row ledger reports that row in every percentile", async () => {
  const rows: BufferSurpriseEvent[] = [syntheticRow(0.42, true)];
  const dist = await reportBufferSurpriseDistribution(async () => rows);
  assert.equal(dist.count, 1);
  assert.equal(dist.min, 0.42);
  assert.equal(dist.max, 0.42);
  assert.equal(dist.median, 0.42);
  assert.equal(dist.p90, 0.42);
  assert.equal(dist.mean, 0.42);
  assert.equal(dist.triggeredRate, 1);
});
