/**
 * Tests for the surprise-gated flush trigger wired into SmartBuffer
 * (issue #563 PR 2).
 *
 * The surprise probe is injected — these tests use a deterministic fake so
 * the buffer's decision logic is exercised without touching embeddings,
 * storage, or QMD.  Two invariants drive the suite:
 *
 *  1. When `bufferSurpriseTriggerEnabled` is `false`, the probe must not be
 *     consulted at all and the buffer must behave exactly like pre-#563
 *     code.
 *  2. When enabled, a score strictly greater than the threshold upgrades
 *     `keep_buffering` → `extract_now`.  A score at or below threshold, a
 *     `null` score, or a thrown error must fall through unchanged.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SmartBuffer, type BufferSurpriseProbe } from "./buffer.js";
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
    timestamp: "2026-04-20T12:00:00.000Z",
    sessionKey,
  };
}

function emptyBuffer(): BufferState {
  return { turns: [], lastExtractionAt: null, extractionCount: 0 };
}

interface RecordingProbe extends BufferSurpriseProbe {
  calls: number;
  lastPriorLength: number | null;
}

function fixedScoreProbe(score: number | null): RecordingProbe {
  const probe: RecordingProbe = {
    calls: 0,
    lastPriorLength: null,
    async scoreTurn(_key, _turn, prior) {
      this.calls += 1;
      this.lastPriorLength = prior.length;
      return score;
    },
  };
  return probe;
}

function throwingProbe(message = "embedder offline"): RecordingProbe {
  const probe: RecordingProbe = {
    calls: 0,
    lastPriorLength: null,
    async scoreTurn(_key, _turn, prior) {
      this.calls += 1;
      this.lastPriorLength = prior.length;
      throw new Error(message);
    },
  };
  return probe;
}

// ---------------------------------------------------------------------------
// Flag gating
// ---------------------------------------------------------------------------

test("flag off: probe is not consulted, behavior matches pre-#563 baseline", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(0.99); // would flush if consulted
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: false,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "some ordinary content"),
  );

  assert.equal(decision, "keep_buffering");
  assert.equal(probe.calls, 0, "probe must not be called when flag is off");
});

test("flag off: high signal still flushes immediately", async () => {
  // Guards against a refactor that accidentally routes high-signal decisions
  // through the surprise branch.
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(0);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: false,
    bufferMaxTurns: 5,
    triggerMode: "smart",
    highSignalPatterns: ["\\bURGENT\\b"],
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "URGENT please remember this"),
  );
  assert.equal(decision, "extract_now");
  assert.equal(probe.calls, 0);
});

// ---------------------------------------------------------------------------
// Threshold behavior
// ---------------------------------------------------------------------------

test("flag on: surprise above threshold upgrades to extract_now", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(0.9);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "a novel topic shift"),
  );
  assert.equal(decision, "extract_now");
  assert.equal(probe.calls, 1);
});

test("flag on: surprise at or below threshold keeps buffering", async () => {
  const storage = new FakeStorage(emptyBuffer());
  // Exactly the threshold must NOT flush — decision is strictly greater-than.
  const probe = fixedScoreProbe(0.35);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "another routine turn"),
  );
  assert.equal(decision, "keep_buffering");
  assert.equal(probe.calls, 1);
});

test("flag on: low-surprise turn does not flush", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(0.1);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "redundant with existing memory"),
  );
  assert.equal(decision, "keep_buffering");
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

test("flag on: probe rejection is swallowed and existing decision stands", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const probe = throwingProbe();
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "turn content"),
  );
  assert.equal(decision, "keep_buffering");
  assert.equal(probe.calls, 1);
});

test("flag on: probe returning null is treated as 'no score, use existing triggers'", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(null);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "turn content"),
  );
  assert.equal(decision, "keep_buffering");
});

test("flag on: surprise does not suppress existing extract_batch flushes", async () => {
  // If the turn-count rule already says flush, surprise must not demote to
  // keep_buffering. Documented as additive-only in buffer.ts.
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(0); // would "not flush" if consulted
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 2,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  await buffer.addTurn("sess-1", makeTurn("sess-1", "first"));
  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "second"),
  );
  assert.equal(decision, "extract_batch");
  assert.equal(
    probe.calls,
    1,
    "probe only consulted on the first (keep_buffering) turn",
  );
});

// ---------------------------------------------------------------------------
// Trigger mode isolation
// ---------------------------------------------------------------------------

test("flag on: non-smart modes ignore surprise", async () => {
  // D-MEM-style novelty only makes sense inside the smart decision tree.
  // `every_n` / `time_based` are explicit operator choices — do not override.
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(0.99);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 10,
    triggerMode: "every_n",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "novel but every_n mode"),
  );
  assert.equal(decision, "keep_buffering");
  assert.equal(probe.calls, 0);
});

// ---------------------------------------------------------------------------
// Corpus exclusion
// ---------------------------------------------------------------------------

test("flag on: probe never sees the turn being scored in the corpus", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(0.1);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferMaxTurns: 10,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  await buffer.addTurn("sess-1", makeTurn("sess-1", "first"));
  await buffer.addTurn("sess-1", makeTurn("sess-1", "second"));
  await buffer.addTurn("sess-1", makeTurn("sess-1", "third"));
  // prior length at third call must be 2 (first + second), not 3.
  assert.equal(probe.lastPriorLength, 2);
});

// ---------------------------------------------------------------------------
// Probe-returned garbage handling
// ---------------------------------------------------------------------------

test("flag on: non-finite probe scores are ignored, not treated as 'always flush'", async () => {
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(Number.NaN);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "turn"),
  );
  assert.equal(decision, "keep_buffering");
});

test("flag on: probe score >1 is clamped, >threshold still flushes", async () => {
  const storage = new FakeStorage(emptyBuffer());
  // A misbehaving probe returning 1.5 should still flush (surprise > 0.35),
  // not crash, and not silently turn into "never flush".
  const probe = fixedScoreProbe(1.5);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "turn"),
  );
  assert.equal(decision, "extract_now");
});

// ---------------------------------------------------------------------------
// Defensive: non-Error throw values in the probe
// ---------------------------------------------------------------------------

async function assertProbeRejectionHandled(
  rejection: unknown,
): Promise<void> {
  const storage = new FakeStorage(emptyBuffer());
  const probe: BufferSurpriseProbe = {
    async scoreTurn() {
      throw rejection;
    },
  };
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: true,
    bufferSurpriseThreshold: 0.35,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  const buffer = new SmartBuffer(config, storage as any, probe);

  // Must NOT itself throw when logging the failure. The decision falls
  // through to the existing triggers and the turn is still saved. The
  // "sess-1" buffer key lives under `entries`, not the default bucket.
  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "turn content"),
  );
  assert.equal(decision, "keep_buffering");
  const entry = storage.saved?.entries?.["sess-1"];
  assert.ok(
    entry && entry.turns.length === 1,
    "turn must still be persisted despite probe failure",
  );
}

test("flag on: non-Error probe rejections do not crash addTurn (null)", async () => {
  await assertProbeRejectionHandled(null);
});

test("flag on: non-Error probe rejections do not crash addTurn (undefined)", async () => {
  await assertProbeRejectionHandled(undefined);
});

test("flag on: non-Error probe rejections do not crash addTurn (string)", async () => {
  await assertProbeRejectionHandled("embedder offline");
});

test("flag on: non-Error probe rejections do not crash addTurn (plain object)", async () => {
  await assertProbeRejectionHandled({ reason: "timeout", code: 504 });
});

// ---------------------------------------------------------------------------
// Boolean config coercion
// ---------------------------------------------------------------------------

test("config: string 'true' for bufferSurpriseTriggerEnabled enables the flag", async () => {
  // `--config bufferSurpriseTriggerEnabled=true` passes the literal
  // string "true" through parseConfig. The strict `=== true` form would
  // leave the flag off and silently drop the operator's intent.
  const storage = new FakeStorage(emptyBuffer());
  const probe = fixedScoreProbe(0.9);
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: "true" as unknown as boolean,
    bufferMaxTurns: 5,
    triggerMode: "smart",
  });
  assert.equal(config.bufferSurpriseTriggerEnabled, true);

  const buffer = new SmartBuffer(config, storage as any, probe);
  const decision = await buffer.addTurn(
    "sess-1",
    makeTurn("sess-1", "novel"),
  );
  assert.equal(decision, "extract_now");
});

test("config: string 'false' for bufferSurpriseTriggerEnabled disables the flag", async () => {
  const config = parseConfig({
    bufferSurpriseTriggerEnabled: "false" as unknown as boolean,
  });
  assert.equal(config.bufferSurpriseTriggerEnabled, false);
});
