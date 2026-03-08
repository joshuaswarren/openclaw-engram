import test from "node:test";
import assert from "node:assert/strict";
import { learnBehaviorPolicyAdjustments } from "../src/behavior-learner.ts";
import type { BehaviorSignalEvent } from "../src/types.ts";

function signal(overrides: Partial<BehaviorSignalEvent> = {}): BehaviorSignalEvent {
  return {
    timestamp: "2026-02-28T00:00:00.000Z",
    namespace: "default",
    memoryId: "mem-1",
    category: "preference",
    signalType: "preference_affinity",
    direction: "positive",
    confidence: 1,
    signalHash: "hash-1",
    source: "extraction",
    ...overrides,
  };
}

test("learner adjusts only allowed parameters under sufficient signal", () => {
  const signals = Array.from({ length: 12 }, (_, idx) =>
    signal({
      memoryId: `mem-${idx}`,
      signalHash: `hash-${idx}`,
      direction: "positive",
    }),
  );

  const state = learnBehaviorPolicyAdjustments({
    signals,
    learningWindowDays: 14,
    minSignalCount: 10,
    maxDeltaPerCycle: 0.1,
    protectedParams: [],
    currentPolicy: {
      recencyWeight: 0.2,
      lifecyclePromoteHeatThreshold: 0.55,
      lifecycleStaleDecayThreshold: 0.65,
      cronRecallInstructionHeavyTokenCap: 24,
    },
    now: new Date("2026-02-28T00:00:00.000Z"),
  });

  assert.ok(state.adjustments.length > 0);
  assert.equal(
    state.adjustments.every((adjustment) =>
      [
        "recencyWeight",
        "lifecyclePromoteHeatThreshold",
        "lifecycleStaleDecayThreshold",
        "cronRecallInstructionHeavyTokenCap",
      ].includes(adjustment.parameter),
    ),
    true,
  );
});

test("learner never mutates protected parameters", () => {
  const signals = Array.from({ length: 15 }, (_, idx) =>
    signal({
      memoryId: `mem-${idx}`,
      signalHash: `hash-${idx}`,
      direction: "positive",
    }),
  );

  const state = learnBehaviorPolicyAdjustments({
    signals,
    learningWindowDays: 14,
    minSignalCount: 10,
    maxDeltaPerCycle: 0.1,
    protectedParams: ["recencyWeight", "cronRecallInstructionHeavyTokenCap"],
    currentPolicy: {
      recencyWeight: 0.2,
      lifecyclePromoteHeatThreshold: 0.55,
      lifecycleStaleDecayThreshold: 0.65,
      cronRecallInstructionHeavyTokenCap: 24,
    },
    now: new Date("2026-02-28T00:00:00.000Z"),
  });

  assert.equal(state.adjustments.some((a) => a.parameter === "recencyWeight"), false);
  assert.equal(
    state.adjustments.some((a) => a.parameter === "cronRecallInstructionHeavyTokenCap"),
    false,
  );
});

test("learner enforces max delta per cycle", () => {
  const signals = Array.from({ length: 20 }, (_, idx) =>
    signal({
      memoryId: `mem-${idx}`,
      signalHash: `hash-${idx}`,
      direction: "negative",
      category: "correction",
      signalType: "correction_override",
    }),
  );

  const state = learnBehaviorPolicyAdjustments({
    signals,
    learningWindowDays: 14,
    minSignalCount: 10,
    maxDeltaPerCycle: 0.05,
    protectedParams: [],
    currentPolicy: {
      recencyWeight: 0.4,
      lifecyclePromoteHeatThreshold: 0.55,
      lifecycleStaleDecayThreshold: 0.65,
      cronRecallInstructionHeavyTokenCap: 24,
    },
    now: new Date("2026-02-28T00:00:00.000Z"),
  });

  const recency = state.adjustments.find((a) => a.parameter === "recencyWeight");
  assert.ok(recency);
  assert.ok(Math.abs(recency.delta) <= 0.05);
});

test("learner rejects updates below min signal count", () => {
  const state = learnBehaviorPolicyAdjustments({
    signals: [
      signal({ memoryId: "a", signalHash: "a" }),
      signal({ memoryId: "b", signalHash: "b" }),
      signal({ memoryId: "c", signalHash: "c" }),
    ],
    learningWindowDays: 14,
    minSignalCount: 10,
    maxDeltaPerCycle: 0.1,
    protectedParams: [],
    currentPolicy: {
      recencyWeight: 0.2,
      lifecyclePromoteHeatThreshold: 0.55,
      lifecycleStaleDecayThreshold: 0.65,
      cronRecallInstructionHeavyTokenCap: 24,
    },
    now: new Date("2026-02-28T00:00:00.000Z"),
  });

  assert.equal(state.adjustments.length, 0);
});

test("learner treats maxDeltaPerCycle=0 as hard no-op for all parameters", () => {
  const signals = Array.from({ length: 20 }, (_, idx) =>
    signal({
      memoryId: `mem-${idx}`,
      signalHash: `hash-${idx}`,
      direction: "negative",
      category: "correction",
      signalType: "correction_override",
    }),
  );

  const state = learnBehaviorPolicyAdjustments({
    signals,
    learningWindowDays: 14,
    minSignalCount: 10,
    maxDeltaPerCycle: 0,
    protectedParams: [],
    currentPolicy: {
      recencyWeight: 0.4,
      lifecyclePromoteHeatThreshold: 0.55,
      lifecycleStaleDecayThreshold: 0.65,
      cronRecallInstructionHeavyTokenCap: 24,
    },
    now: new Date("2026-02-28T00:00:00.000Z"),
  });

  assert.equal(state.adjustments.length, 0);
});

test("token cap learning is symmetric at small delta budgets", () => {
  const positiveSignals = Array.from({ length: 20 }, (_, idx) =>
    signal({
      memoryId: `p-${idx}`,
      signalHash: `p-${idx}`,
      direction: "positive",
    }),
  );
  const negativeSignals = Array.from({ length: 20 }, (_, idx) =>
    signal({
      memoryId: `n-${idx}`,
      signalHash: `n-${idx}`,
      direction: "negative",
      category: "correction",
      signalType: "correction_override",
    }),
  );

  const commonInput = {
    learningWindowDays: 14,
    minSignalCount: 10,
    maxDeltaPerCycle: 0.03,
    protectedParams: [],
    currentPolicy: {
      recencyWeight: 0.2,
      lifecyclePromoteHeatThreshold: 0.55,
      lifecycleStaleDecayThreshold: 0.65,
      cronRecallInstructionHeavyTokenCap: 24,
    },
    now: new Date("2026-02-28T00:00:00.000Z"),
  };

  const positive = learnBehaviorPolicyAdjustments({
    ...commonInput,
    signals: positiveSignals,
  });
  const negative = learnBehaviorPolicyAdjustments({
    ...commonInput,
    signals: negativeSignals,
  });

  const up = positive.adjustments.find((a) => a.parameter === "cronRecallInstructionHeavyTokenCap");
  const down = negative.adjustments.find((a) => a.parameter === "cronRecallInstructionHeavyTokenCap");
  assert.ok(up);
  assert.ok(down);
  assert.equal(up.nextValue, 25);
  assert.equal(down.nextValue, 23);
});
