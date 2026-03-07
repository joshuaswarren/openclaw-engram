import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import type { ObjectiveStateOutcome } from "./objective-state.js";
import {
  assertIsoRecordedAt,
  assertSafePathSegment,
  assertString,
  isRecord,
  optionalString,
  optionalStringArray,
  recordStoreDay,
  validateStringRecord,
} from "./store-contract.js";

export interface CausalTrajectoryRecord {
  schemaVersion: 1;
  trajectoryId: string;
  recordedAt: string;
  sessionKey: string;
  goal: string;
  actionSummary: string;
  observationSummary: string;
  outcomeKind: ObjectiveStateOutcome;
  outcomeSummary: string;
  followUpSummary?: string;
  objectiveStateSnapshotRefs?: string[];
  entityRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface CausalTrajectoryStoreStatus {
  enabled: boolean;
  rootDir: string;
  trajectoriesDir: string;
  trajectories: {
    total: number;
    valid: number;
    invalid: number;
    byOutcome: Partial<Record<ObjectiveStateOutcome, number>>;
    latestTrajectoryId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestTrajectory?: CausalTrajectoryRecord;
  invalidTrajectories: Array<{
    path: string;
    error: string;
  }>;
}

function validateMetadata(raw: unknown): Record<string, string> | undefined {
  return validateStringRecord(raw, "metadata");
}

export function resolveCausalTrajectoryStoreDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "causal-trajectories");
}

export function validateCausalTrajectoryRecord(raw: unknown): CausalTrajectoryRecord {
  if (!isRecord(raw)) throw new Error("causal trajectory record must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const outcomeKind = assertString(raw.outcomeKind, "outcomeKind");
  if (!["success", "failure", "partial", "unknown"].includes(outcomeKind)) {
    throw new Error("outcomeKind must be one of success|failure|partial|unknown");
  }

  return {
    schemaVersion: 1,
    trajectoryId: assertSafePathSegment(assertString(raw.trajectoryId, "trajectoryId"), "trajectoryId"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    goal: assertString(raw.goal, "goal"),
    actionSummary: assertString(raw.actionSummary, "actionSummary"),
    observationSummary: assertString(raw.observationSummary, "observationSummary"),
    outcomeKind: outcomeKind as ObjectiveStateOutcome,
    outcomeSummary: assertString(raw.outcomeSummary, "outcomeSummary"),
    followUpSummary: optionalString(raw.followUpSummary),
    objectiveStateSnapshotRefs: optionalStringArray(raw.objectiveStateSnapshotRefs, "objectiveStateSnapshotRefs"),
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateMetadata(raw.metadata),
  };
}

export async function recordCausalTrajectory(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
  record: CausalTrajectoryRecord;
}): Promise<string> {
  const rootDir = resolveCausalTrajectoryStoreDir(options.memoryDir, options.causalTrajectoryStoreDir);
  const validated = validateCausalTrajectoryRecord(options.record);
  const day = recordStoreDay(validated.recordedAt);
  const trajectoriesDir = path.join(rootDir, "trajectories", day);
  const filePath = path.join(trajectoriesDir, `${validated.trajectoryId}.json`);
  await mkdir(trajectoriesDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

async function readCausalTrajectoryRecords(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
}): Promise<{
  files: string[];
  trajectories: CausalTrajectoryRecord[];
  invalidTrajectories: Array<{ path: string; error: string }>;
}> {
  const rootDir = resolveCausalTrajectoryStoreDir(options.memoryDir, options.causalTrajectoryStoreDir);
  const files = await listJsonFiles(path.join(rootDir, "trajectories"));
  const trajectories: CausalTrajectoryRecord[] = [];
  const invalidTrajectories: Array<{ path: string; error: string }> = [];
  for (const filePath of files) {
    try {
      trajectories.push(validateCausalTrajectoryRecord(await readJsonFile(filePath)));
    } catch (error) {
      invalidTrajectories.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { files, trajectories, invalidTrajectories };
}

export async function getCausalTrajectoryStoreStatus(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
  enabled: boolean;
}): Promise<CausalTrajectoryStoreStatus> {
  const rootDir = resolveCausalTrajectoryStoreDir(options.memoryDir, options.causalTrajectoryStoreDir);
  const trajectoriesDir = path.join(rootDir, "trajectories");
  const { files, trajectories, invalidTrajectories } = await readCausalTrajectoryRecords(options);

  trajectories.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const byOutcome: Partial<Record<ObjectiveStateOutcome, number>> = {};
  for (const trajectory of trajectories) {
    byOutcome[trajectory.outcomeKind] = (byOutcome[trajectory.outcomeKind] ?? 0) + 1;
  }

  return {
    enabled: options.enabled,
    rootDir,
    trajectoriesDir,
    trajectories: {
      total: files.length,
      valid: trajectories.length,
      invalid: invalidTrajectories.length,
      byOutcome,
      latestTrajectoryId: trajectories[0]?.trajectoryId,
      latestRecordedAt: trajectories[0]?.recordedAt,
      latestSessionKey: trajectories[0]?.sessionKey,
    },
    latestTrajectory: trajectories[0],
    invalidTrajectories,
  };
}
