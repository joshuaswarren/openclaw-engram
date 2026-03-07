import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  getCausalTrajectoryStoreStatus,
  recordCausalTrajectory,
  resolveCausalTrajectoryStoreDir,
  validateCausalTrajectoryRecord,
} from "../src/causal-trajectory.js";
import { runCausalTrajectoryStatusCliCommand } from "../src/cli.js";

test("causal-trajectory config path resolves under memoryDir by default", () => {
  assert.equal(
    resolveCausalTrajectoryStoreDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "causal-trajectories"),
  );
});

test("validateCausalTrajectoryRecord accepts the normalized causal chain contract", () => {
  const record = validateCausalTrajectoryRecord({
    schemaVersion: 1,
    trajectoryId: "traj-1",
    recordedAt: "2026-03-07T10:00:00.000Z",
    sessionKey: "agent:main",
    goal: "Recover a failing verification run",
    actionSummary: "Ran npm test after updating parser handling",
    observationSummary: "The run still reported 3 failures in objective-state output",
    outcomeKind: "failure",
    outcomeSummary: "Verification is still red because negated pass phrases are misclassified",
    followUpSummary: "Patch the negation parser and rerun the focused tests",
    objectiveStateSnapshotRefs: ["snap-verify-failure", "snap-parser-edit"],
    entityRefs: ["repo:openclaw-engram"],
    tags: ["verification", "trajectory"],
    metadata: { source: "agent_end" },
  });

  assert.equal(record.trajectoryId, "traj-1");
  assert.equal(record.outcomeKind, "failure");
  assert.deepEqual(record.objectiveStateSnapshotRefs, ["snap-verify-failure", "snap-parser-edit"]);
});

test("recordCausalTrajectory persists records into dated causal-trajectory storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-record-"));
  const filePath = await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-2",
      recordedAt: "2026-03-07T10:01:00.000Z",
      sessionKey: "agent:main",
      goal: "Validate the PR8 store contract",
      actionSummary: "Persisted the first causal trajectory record",
      observationSummary: "The store directory should now contain a dated JSON artifact",
      outcomeKind: "success",
      outcomeSummary: "Record write completed without errors",
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "causal-trajectories", "trajectories", "2026-03-07", "traj-2.json"),
  );
});

test("recordCausalTrajectory rejects unsafe ids and malformed timestamps", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-reject-"));

  await assert.rejects(
    () =>
      recordCausalTrajectory({
        memoryDir,
        record: {
          schemaVersion: 1,
          trajectoryId: "../escape",
          recordedAt: "2026-03-07T10:02:00.000Z",
          sessionKey: "agent:main",
          goal: "Invalid path test",
          actionSummary: "Attempted to persist an unsafe id",
          observationSummary: "The validator should reject path traversal",
          outcomeKind: "failure",
          outcomeSummary: "Path traversal blocked",
        },
      }),
    /trajectoryId must be a safe path segment/i,
  );

  await assert.rejects(
    () =>
      recordCausalTrajectory({
        memoryDir,
        record: {
          schemaVersion: 1,
          trajectoryId: "traj-bad-date",
          recordedAt: "not-a-date",
          sessionKey: "agent:main",
          goal: "Invalid timestamp test",
          actionSummary: "Attempted to persist a malformed timestamp",
          observationSummary: "The validator should reject non-ISO dates",
          outcomeKind: "failure",
          outcomeSummary: "Bad timestamp blocked",
        },
      }),
    /recordedAt must be an ISO timestamp/i,
  );
});

test("causal-trajectory status reports valid and invalid records", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-status-"));
  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-3",
      recordedAt: "2026-03-07T10:03:00.000Z",
      sessionKey: "agent:main",
      goal: "Diagnose merge readiness",
      actionSummary: "Reran the stale review-thread check",
      observationSummary: "GitHub reported a fresh successful rerun",
      outcomeKind: "success",
      outcomeSummary: "The PR became merge-ready",
      objectiveStateSnapshotRefs: ["snap-rerun-thread-check"],
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "causal-trajectories",
    "trajectories",
    "2026-03-07",
    "invalid.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, trajectoryId: "" }, null, 2), "utf8");

  const status = await getCausalTrajectoryStoreStatus({
    memoryDir,
    enabled: true,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.trajectories.total, 2);
  assert.equal(status.trajectories.valid, 1);
  assert.equal(status.trajectories.invalid, 1);
  assert.equal(status.trajectories.byOutcome.success, 1);
  assert.equal(status.latestTrajectory?.trajectoryId, "traj-3");
  assert.match(status.invalidTrajectories[0]?.path ?? "", /invalid\.json$/);
});

test("causal-trajectory-status CLI command returns the store summary", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-cli-"));
  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-4",
      recordedAt: "2026-03-07T10:04:00.000Z",
      sessionKey: "agent:main",
      goal: "Prepare PR9 graph work",
      actionSummary: "Stored the causal chain foundation",
      observationSummary: "The trajectory store now has one valid record",
      outcomeKind: "partial",
      outcomeSummary: "Storage exists, but graph wiring is still future work",
    },
  });

  const status = await runCausalTrajectoryStatusCliCommand({
    memoryDir,
    causalTrajectoryMemoryEnabled: true,
  });

  assert.equal(status.trajectories.total, 1);
  assert.equal(status.latestTrajectory?.trajectoryId, "traj-4");
  assert.equal(status.trajectories.byOutcome.partial, 1);
});
