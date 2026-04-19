import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import type { ObjectiveStateOutcome } from "./objective-state.js";
import { countRecallTokenOverlap, normalizeRecallTokens } from "./recall-tokenization.js";
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

export interface CausalTrajectorySearchResult {
  record: CausalTrajectoryRecord;
  score: number;
  matchedFields: string[];
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
  actionGraphRecallEnabled?: boolean;
  cmcEnabled?: boolean;
  cmcStitchLookbackDays?: number;
  cmcStitchMinScore?: number;
  cmcStitchMaxEdgesPerTrajectory?: number;
  record: CausalTrajectoryRecord;
}): Promise<string> {
  const rootDir = resolveCausalTrajectoryStoreDir(options.memoryDir, options.causalTrajectoryStoreDir);
  const validated = validateCausalTrajectoryRecord(options.record);
  const day = recordStoreDay(validated.recordedAt);
  const trajectoriesDir = path.join(rootDir, "trajectories", day);
  const filePath = path.join(trajectoriesDir, `${validated.trajectoryId}.json`);
  await mkdir(trajectoriesDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  if (options.actionGraphRecallEnabled === true) {
    try {
      const { appendCausalTrajectoryGraphEdges } = await import("./causal-trajectory-graph.js");
      await appendCausalTrajectoryGraphEdges({
        memoryDir: options.memoryDir,
        record: validated,
      });
    } catch (error) {
      const { log } = await import("./logger.js");
      log.warn(
        `[causal-trajectory] action-conditioned graph write failed for ${validated.trajectoryId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (options.cmcEnabled === true) {
    try {
      const { stitchCausalChain } = await import("./causal-chain.js");
      await stitchCausalChain({
        memoryDir: options.memoryDir,
        causalTrajectoryStoreDir: options.causalTrajectoryStoreDir,
        newTrajectory: validated,
        config: {
          lookbackDays: options.cmcStitchLookbackDays ?? 7,
          minScore: options.cmcStitchMinScore ?? 2.5,
          maxEdgesPerTrajectory: options.cmcStitchMaxEdgesPerTrajectory ?? 3,
        },
      });
    } catch (error) {
      const { log } = await import("./logger.js");
      log.warn(
        `[cmc] causal chain stitching failed for ${validated.trajectoryId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return filePath;
}

export async function readCausalTrajectoryRecords(options: {
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

/** Keep trajectories whose recordedAt is within the last `lookbackDays` (issue #519 miner). */
export function filterTrajectoriesByLookbackDays(
  trajectories: CausalTrajectoryRecord[],
  lookbackDays: number,
  nowMs: number = Date.now(),
): CausalTrajectoryRecord[] {
  const days = Math.max(1, Math.floor(lookbackDays));
  const cutoff = nowMs - days * 86_400_000;
  return trajectories.filter((t) => {
    const ms = Date.parse(t.recordedAt);
    return Number.isFinite(ms) && ms >= cutoff;
  });
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

function lexicalScoreCausalTrajectoryRecord(
  record: CausalTrajectoryRecord,
  queryTokens: Set<string>,
): { score: number; matchedFields: string[] } {
  const weightedFields: Array<[field: string, value: string | undefined, weight: number]> = [
    ["goal", record.goal, 4],
    ["action", record.actionSummary, 3],
    ["observation", record.observationSummary, 3],
    ["outcome", record.outcomeSummary, 3],
    ["follow_up", record.followUpSummary, 2],
    ["outcome_kind", record.outcomeKind, 1],
    ["tags", record.tags?.join(" "), 2],
    ["entity_refs", record.entityRefs?.join(" "), 2],
    ["objective_state_refs", record.objectiveStateSnapshotRefs?.join(" "), 1],
  ];

  let score = 0;
  const matchedFields: string[] = [];
  for (const [field, value, weight] of weightedFields) {
    const matches = countRecallTokenOverlap(queryTokens, value, ["make"]);
    if (matches > 0) matchedFields.push(field);
    score += matches * weight;
  }
  return { score, matchedFields };
}

function scoreCausalTrajectoryRecord(
  record: CausalTrajectoryRecord,
  lexicalScore: number,
  sessionKey?: string,
): number {
  let score = lexicalScore;
  if (sessionKey && record.sessionKey === sessionKey) score += 1.5;

  const recordedAtMs = Date.parse(record.recordedAt);
  if (Number.isFinite(recordedAtMs)) {
    const ageHours = Math.max(0, (Date.now() - recordedAtMs) / 3_600_000);
    score += 1 / (1 + ageHours);
  }
  return score;
}

export async function searchCausalTrajectories(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
  query: string;
  maxResults: number;
  sessionKey?: string;
}): Promise<CausalTrajectorySearchResult[]> {
  const maxResults = Math.max(0, Math.floor(options.maxResults));
  if (maxResults === 0) return [];

  const { trajectories } = await readCausalTrajectoryRecords(options);
  if (trajectories.length === 0) return [];

  const queryTokens = new Set(normalizeRecallTokens(options.query, ["make"]));
  if (queryTokens.size === 0) return [];
  const scored = trajectories.map((record) => {
    const lexical = lexicalScoreCausalTrajectoryRecord(record, queryTokens);
    return {
      record,
      matchedFields: lexical.matchedFields,
      lexicalScore: lexical.score,
      score: scoreCausalTrajectoryRecord(record, lexical.score, options.sessionKey),
    };
  });

  const filtered = scored.filter((result) => result.lexicalScore > 0);

  filtered.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.record.recordedAt.localeCompare(left.record.recordedAt);
  });

  return filtered.slice(0, maxResults).map(({ record, score, matchedFields }) => ({
    record,
    score,
    matchedFields,
  }));
}
