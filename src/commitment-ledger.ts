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

export type CommitmentLedgerSource = "tool_result" | "cli" | "system" | "manual";
export type CommitmentLedgerKind = "promise" | "follow_up" | "deadline" | "deliverable";
export type CommitmentLedgerState = "open" | "fulfilled" | "cancelled" | "expired";

export interface CommitmentLedgerEntry {
  schemaVersion: 1;
  entryId: string;
  recordedAt: string;
  sessionKey: string;
  source: CommitmentLedgerSource;
  kind: CommitmentLedgerKind;
  state: CommitmentLedgerState;
  scope: string;
  summary: string;
  dueAt?: string;
  entityRefs?: string[];
  workProductEntryRefs?: string[];
  objectiveStateSnapshotRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface CommitmentLedgerStatus {
  enabled: boolean;
  rootDir: string;
  entriesDir: string;
  entries: {
    total: number;
    valid: number;
    invalid: number;
    byKind: Partial<Record<CommitmentLedgerKind, number>>;
    byState: Partial<Record<CommitmentLedgerState, number>>;
    latestEntryId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestEntry?: CommitmentLedgerEntry;
  invalidEntries: Array<{
    path: string;
    error: string;
  }>;
}

export function resolveCommitmentLedgerDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "commitment-ledger");
}

export function validateCommitmentLedgerEntry(raw: unknown): CommitmentLedgerEntry {
  if (!isRecord(raw)) throw new Error("commitment ledger entry must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const source = assertString(raw.source, "source");
  if (!["tool_result", "cli", "system", "manual"].includes(source)) {
    throw new Error("source must be one of tool_result|cli|system|manual");
  }

  const kind = assertString(raw.kind, "kind");
  if (!["promise", "follow_up", "deadline", "deliverable"].includes(kind)) {
    throw new Error("kind must be one of promise|follow_up|deadline|deliverable");
  }

  const state = assertString(raw.state, "state");
  if (!["open", "fulfilled", "cancelled", "expired"].includes(state)) {
    throw new Error("state must be one of open|fulfilled|cancelled|expired");
  }

  const dueAt = optionalString(raw.dueAt);
  if (dueAt !== undefined) {
    assertIsoRecordedAt(dueAt, "dueAt");
  }

  return {
    schemaVersion: 1,
    entryId: assertSafePathSegment(assertString(raw.entryId, "entryId"), "entryId"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    source: source as CommitmentLedgerSource,
    kind: kind as CommitmentLedgerKind,
    state: state as CommitmentLedgerState,
    scope: assertString(raw.scope, "scope"),
    summary: assertString(raw.summary, "summary"),
    dueAt,
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    workProductEntryRefs: optionalStringArray(raw.workProductEntryRefs, "workProductEntryRefs"),
    objectiveStateSnapshotRefs: optionalStringArray(raw.objectiveStateSnapshotRefs, "objectiveStateSnapshotRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateStringRecord(raw.metadata, "metadata"),
  };
}

export async function recordCommitmentLedgerEntry(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  entry: CommitmentLedgerEntry;
}): Promise<string> {
  const rootDir = resolveCommitmentLedgerDir(options.memoryDir, options.commitmentLedgerDir);
  const validated = validateCommitmentLedgerEntry(options.entry);
  const day = recordStoreDay(validated.recordedAt);
  const entriesDir = path.join(rootDir, "entries", day);
  const filePath = path.join(entriesDir, `${validated.entryId}.json`);
  await mkdir(entriesDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

async function readCommitmentLedgerEntries(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
}): Promise<{
  files: string[];
  entries: CommitmentLedgerEntry[];
  invalidEntries: Array<{ path: string; error: string }>;
}> {
  const rootDir = resolveCommitmentLedgerDir(options.memoryDir, options.commitmentLedgerDir);
  const files = await listJsonFiles(path.join(rootDir, "entries"));
  const entries: CommitmentLedgerEntry[] = [];
  const invalidEntries: Array<{ path: string; error: string }> = [];
  for (const filePath of files) {
    try {
      entries.push(validateCommitmentLedgerEntry(await readJsonFile(filePath)));
    } catch (error) {
      invalidEntries.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { files, entries, invalidEntries };
}

export async function getCommitmentLedgerStatus(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  enabled: boolean;
}): Promise<CommitmentLedgerStatus> {
  const rootDir = resolveCommitmentLedgerDir(options.memoryDir, options.commitmentLedgerDir);
  const entriesDir = path.join(rootDir, "entries");
  const { files, entries, invalidEntries } = await readCommitmentLedgerEntries(options);
  entries.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  const byKind: Partial<Record<CommitmentLedgerKind, number>> = {};
  const byState: Partial<Record<CommitmentLedgerState, number>> = {};
  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    byState[entry.state] = (byState[entry.state] ?? 0) + 1;
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
      byState,
      latestEntryId: entries[0]?.entryId,
      latestRecordedAt: entries[0]?.recordedAt,
      latestSessionKey: entries[0]?.sessionKey,
    },
    latestEntry: entries[0],
    invalidEntries,
  };
}
