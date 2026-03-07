import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { listJsonFiles, readJsonFile } from "./json-store.js";
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

export type WorkProductLedgerSource = "tool_result" | "cli" | "system" | "manual";
export type WorkProductLedgerKind = "artifact" | "file" | "record" | "report" | "workspace";
export type WorkProductLedgerAction = "created" | "updated" | "deleted" | "referenced" | "published";

export interface WorkProductLedgerEntry {
  schemaVersion: 1;
  entryId: string;
  recordedAt: string;
  sessionKey: string;
  source: WorkProductLedgerSource;
  kind: WorkProductLedgerKind;
  action: WorkProductLedgerAction;
  scope: string;
  summary: string;
  artifactPath?: string;
  objectiveStateSnapshotRefs?: string[];
  entityRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface WorkProductLedgerStatus {
  enabled: boolean;
  rootDir: string;
  entriesDir: string;
  entries: {
    total: number;
    valid: number;
    invalid: number;
    byKind: Partial<Record<WorkProductLedgerKind, number>>;
    byAction: Partial<Record<WorkProductLedgerAction, number>>;
    latestEntryId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestEntry?: WorkProductLedgerEntry;
  invalidEntries: Array<{
    path: string;
    error: string;
  }>;
}

export function resolveWorkProductLedgerDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "work-product-ledger");
}

export function validateWorkProductLedgerEntry(raw: unknown): WorkProductLedgerEntry {
  if (!isRecord(raw)) throw new Error("work-product ledger entry must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const source = assertString(raw.source, "source");
  if (!["tool_result", "cli", "system", "manual"].includes(source)) {
    throw new Error("source must be one of tool_result|cli|system|manual");
  }

  const kind = assertString(raw.kind, "kind");
  if (!["artifact", "file", "record", "report", "workspace"].includes(kind)) {
    throw new Error("kind must be one of artifact|file|record|report|workspace");
  }

  const action = assertString(raw.action, "action");
  if (!["created", "updated", "deleted", "referenced", "published"].includes(action)) {
    throw new Error("action must be one of created|updated|deleted|referenced|published");
  }

  return {
    schemaVersion: 1,
    entryId: assertSafePathSegment(assertString(raw.entryId, "entryId"), "entryId"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    source: source as WorkProductLedgerSource,
    kind: kind as WorkProductLedgerKind,
    action: action as WorkProductLedgerAction,
    scope: assertString(raw.scope, "scope"),
    summary: assertString(raw.summary, "summary"),
    artifactPath: optionalString(raw.artifactPath),
    objectiveStateSnapshotRefs: optionalStringArray(raw.objectiveStateSnapshotRefs, "objectiveStateSnapshotRefs"),
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateStringRecord(raw.metadata, "metadata"),
  };
}

export async function recordWorkProductLedgerEntry(options: {
  memoryDir: string;
  workProductLedgerDir?: string;
  entry: WorkProductLedgerEntry;
}): Promise<string> {
  const rootDir = resolveWorkProductLedgerDir(options.memoryDir, options.workProductLedgerDir);
  const validated = validateWorkProductLedgerEntry(options.entry);
  const day = recordStoreDay(validated.recordedAt);
  const entriesDir = path.join(rootDir, "entries", day);
  const filePath = path.join(entriesDir, `${validated.entryId}.json`);
  await mkdir(entriesDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

async function readWorkProductLedgerEntries(options: {
  memoryDir: string;
  workProductLedgerDir?: string;
}): Promise<{
  files: string[];
  entries: WorkProductLedgerEntry[];
  invalidEntries: Array<{ path: string; error: string }>;
}> {
  const rootDir = resolveWorkProductLedgerDir(options.memoryDir, options.workProductLedgerDir);
  const files = await listJsonFiles(path.join(rootDir, "entries"));
  const entries: WorkProductLedgerEntry[] = [];
  const invalidEntries: Array<{ path: string; error: string }> = [];
  for (const filePath of files) {
    try {
      entries.push(validateWorkProductLedgerEntry(await readJsonFile(filePath)));
    } catch (error) {
      invalidEntries.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { files, entries, invalidEntries };
}

export async function getWorkProductLedgerStatus(options: {
  memoryDir: string;
  workProductLedgerDir?: string;
  enabled: boolean;
}): Promise<WorkProductLedgerStatus> {
  const rootDir = resolveWorkProductLedgerDir(options.memoryDir, options.workProductLedgerDir);
  const entriesDir = path.join(rootDir, "entries");
  const { files, entries, invalidEntries } = await readWorkProductLedgerEntries(options);
  entries.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  const byKind: Partial<Record<WorkProductLedgerKind, number>> = {};
  const byAction: Partial<Record<WorkProductLedgerAction, number>> = {};
  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
  }

  return {
    enabled: options.enabled,
    rootDir,
    entriesDir,
    entries: {
      total: files.length,
      valid: entries.length,
      invalid: invalidEntries.length,
      byKind,
      byAction,
      latestEntryId: entries[0]?.entryId,
      latestRecordedAt: entries[0]?.recordedAt,
      latestSessionKey: entries[0]?.sessionKey,
    },
    latestEntry: entries[0],
    invalidEntries,
  };
}
