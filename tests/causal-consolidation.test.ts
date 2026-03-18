import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  deriveCausalPromotionCandidates,
  synthesizeCausalPreferencesViaLlm,
} from "../src/causal-consolidation.js";
import { recordCausalTrajectory, type CausalTrajectoryRecord } from "../src/causal-trajectory.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

test("deriveCausalPromotionCandidates returns empty for empty store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-consol-empty-"));
  const candidates = await deriveCausalPromotionCandidates({
    memoryDir,
    config: { minRecurrence: 3, minSessions: 2, successThreshold: 0.7 },
    // No gatewayConfig — LLM not available, should return empty
  });
  assert.equal(candidates.length, 0);
});

test("deriveCausalPromotionCandidates returns empty when too few trajectories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-consol-few-"));

  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-1",
      recordedAt: new Date().toISOString(),
      sessionKey: "session-1",
      goal: "Fix auth",
      actionSummary: "Patched handler",
      observationSummary: "Tests pass",
      outcomeKind: "success",
      outcomeSummary: "Done",
    },
  });

  const candidates = await deriveCausalPromotionCandidates({
    memoryDir,
    config: { minRecurrence: 3, minSessions: 2, successThreshold: 0.7 },
  });
  assert.equal(candidates.length, 0, "Should need at least minRecurrence trajectories");
});

test("deriveCausalPromotionCandidates returns empty without LLM when trajectories exist", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-consol-nollm-"));

  for (let i = 0; i < 3; i++) {
    await recordCausalTrajectory({
      memoryDir,
      record: {
        schemaVersion: 1,
        trajectoryId: `traj-${i}`,
        recordedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
        sessionKey: `session-${i}`,
        goal: "Fix authentication error handling",
        actionSummary: "Updated login handler",
        observationSummary: "Tests pass",
        outcomeKind: "success",
        outcomeSummary: "Auth fixed",
      },
    });
  }

  // No gatewayConfig — LLM not available
  const candidates = await deriveCausalPromotionCandidates({
    memoryDir,
    config: { minRecurrence: 3, minSessions: 2, successThreshold: 0.7 },
  });
  assert.equal(candidates.length, 0, "Without LLM, should return empty");
});

test("synthesizeCausalPreferencesViaLlm returns null for empty store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-pref-empty-"));
  const result = await synthesizeCausalPreferencesViaLlm({ memoryDir });
  assert.equal(result, null);
});

test("synthesizeCausalPreferencesViaLlm returns null without LLM", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-pref-nollm-"));

  for (let i = 0; i < 3; i++) {
    await recordCausalTrajectory({
      memoryDir,
      record: {
        schemaVersion: 1,
        trajectoryId: `traj-pref-${i}`,
        recordedAt: new Date().toISOString(),
        sessionKey: `session-${i}`,
        goal: "Use TypeScript for frontend",
        actionSummary: "Created React component in TypeScript",
        observationSummary: "Type checks pass",
        outcomeKind: "success",
        outcomeSummary: "Component works",
      },
    });
  }

  const result = await synthesizeCausalPreferencesViaLlm({ memoryDir });
  assert.equal(result, null, "Without LLM, should return null");
});
