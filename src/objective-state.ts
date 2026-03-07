import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { listJsonFiles, readJsonFile } from "./json-store.js";

export type ObjectiveStateSnapshotSource = "tool_result" | "cli" | "system" | "manual";
export type ObjectiveStateSnapshotKind = "tool" | "file" | "process" | "record" | "workspace";
export type ObjectiveStateChangeKind = "created" | "updated" | "deleted" | "observed" | "executed" | "failed";
export type ObjectiveStateOutcome = "success" | "failure" | "partial" | "unknown";

export interface ObjectiveStateValueRef {
  exists?: boolean;
  ref?: string;
  valueHash?: string;
}

export interface ObjectiveStateSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  recordedAt: string;
  sessionKey: string;
  source: ObjectiveStateSnapshotSource;
  kind: ObjectiveStateSnapshotKind;
  changeKind: ObjectiveStateChangeKind;
  scope: string;
  summary: string;
  toolName?: string;
  command?: string;
  outcome?: ObjectiveStateOutcome;
  before?: ObjectiveStateValueRef;
  after?: ObjectiveStateValueRef;
  entityRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface ObjectiveStateStoreStatus {
  enabled: boolean;
  writesEnabled: boolean;
  rootDir: string;
  snapshotsDir: string;
  snapshots: {
    total: number;
    valid: number;
    invalid: number;
    byKind: Partial<Record<ObjectiveStateSnapshotKind, number>>;
    byOutcome: Partial<Record<ObjectiveStateOutcome, number>>;
    latestSnapshotId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestSnapshot?: ObjectiveStateSnapshot;
  invalidSnapshots: Array<{
    path: string;
    error: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

function assertSafePathSegment(value: string, field: string): string {
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`${field} must be a safe path segment`);
  }
  return value;
}

function assertIsoRecordedAt(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error("recordedAt must be an ISO timestamp");
  }
  return value;
}

function objectiveStateDay(recordedAt: string): string {
  const day = recordedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("recordedAt must start with a valid YYYY-MM-DD date");
  }
  return day;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
  const items = value.map((item, index) => assertString(item, `${field}[${index}]`));
  return items.length > 0 ? items : undefined;
}

function validateValueRef(raw: unknown, field: string): ObjectiveStateValueRef | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  const exists = typeof raw.exists === "boolean" ? raw.exists : undefined;
  const ref = optionalString(raw.ref);
  const valueHash = optionalString(raw.valueHash);
  if (exists === undefined && ref === undefined && valueHash === undefined) {
    throw new Error(`${field} must include exists, ref, or valueHash`);
  }
  return { exists, ref, valueHash };
}

function validateMetadata(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error("metadata must be an object of strings");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new Error("metadata must be an object of strings");
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolveObjectiveStateStoreDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "objective-state");
}

export function validateObjectiveStateSnapshot(raw: unknown): ObjectiveStateSnapshot {
  if (!isRecord(raw)) throw new Error("objective-state snapshot must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const source = assertString(raw.source, "source");
  if (!["tool_result", "cli", "system", "manual"].includes(source)) {
    throw new Error("source must be one of tool_result|cli|system|manual");
  }

  const kind = assertString(raw.kind, "kind");
  if (!["tool", "file", "process", "record", "workspace"].includes(kind)) {
    throw new Error("kind must be one of tool|file|process|record|workspace");
  }

  const changeKind = assertString(raw.changeKind, "changeKind");
  if (!["created", "updated", "deleted", "observed", "executed", "failed"].includes(changeKind)) {
    throw new Error("changeKind must be one of created|updated|deleted|observed|executed|failed");
  }

  const outcomeRaw = optionalString(raw.outcome);
  if (outcomeRaw !== undefined && !["success", "failure", "partial", "unknown"].includes(outcomeRaw)) {
    throw new Error("outcome must be one of success|failure|partial|unknown");
  }

  return {
    schemaVersion: 1,
    snapshotId: assertSafePathSegment(assertString(raw.snapshotId, "snapshotId"), "snapshotId"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    source: source as ObjectiveStateSnapshotSource,
    kind: kind as ObjectiveStateSnapshotKind,
    changeKind: changeKind as ObjectiveStateChangeKind,
    scope: assertString(raw.scope, "scope"),
    summary: assertString(raw.summary, "summary"),
    toolName: optionalString(raw.toolName),
    command: optionalString(raw.command),
    outcome: outcomeRaw as ObjectiveStateOutcome | undefined,
    before: validateValueRef(raw.before, "before"),
    after: validateValueRef(raw.after, "after"),
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateMetadata(raw.metadata),
  };
}

export async function recordObjectiveStateSnapshot(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  snapshot: ObjectiveStateSnapshot;
}): Promise<string> {
  const rootDir = resolveObjectiveStateStoreDir(options.memoryDir, options.objectiveStateStoreDir);
  const validated = validateObjectiveStateSnapshot(options.snapshot);
  const day = objectiveStateDay(validated.recordedAt);
  const snapshotsDir = path.join(rootDir, "snapshots", day);
  const filePath = path.join(snapshotsDir, `${validated.snapshotId}.json`);
  await mkdir(snapshotsDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

export async function getObjectiveStateStoreStatus(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  enabled: boolean;
  writesEnabled: boolean;
}): Promise<ObjectiveStateStoreStatus> {
  const rootDir = resolveObjectiveStateStoreDir(options.memoryDir, options.objectiveStateStoreDir);
  const snapshotsDir = path.join(rootDir, "snapshots");
  const files = await listJsonFiles(snapshotsDir);
  const snapshots: ObjectiveStateSnapshot[] = [];
  const invalidSnapshots: Array<{ path: string; error: string }> = [];

  for (const filePath of files) {
    try {
      snapshots.push(validateObjectiveStateSnapshot(await readJsonFile(filePath)));
    } catch (error) {
      invalidSnapshots.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  snapshots.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const byKind: Partial<Record<ObjectiveStateSnapshotKind, number>> = {};
  const byOutcome: Partial<Record<ObjectiveStateOutcome, number>> = {};
  for (const snapshot of snapshots) {
    byKind[snapshot.kind] = (byKind[snapshot.kind] ?? 0) + 1;
    const outcome = snapshot.outcome ?? "unknown";
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  }

  return {
    enabled: options.enabled,
    writesEnabled: options.writesEnabled,
    rootDir,
    snapshotsDir,
    snapshots: {
      total: files.length,
      valid: snapshots.length,
      invalid: invalidSnapshots.length,
      byKind,
      byOutcome,
      latestSnapshotId: snapshots[0]?.snapshotId,
      latestRecordedAt: snapshots[0]?.recordedAt,
      latestSessionKey: snapshots[0]?.sessionKey,
    },
    latestSnapshot: snapshots[0],
    invalidSnapshots,
  };
}
