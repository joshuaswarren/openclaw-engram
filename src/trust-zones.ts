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

export type TrustZoneName = "quarantine" | "working" | "trusted";
export type TrustZoneRecordKind = "memory" | "artifact" | "state" | "trajectory" | "external";
export type TrustZoneSourceClass =
  | "tool_output"
  | "web_content"
  | "subagent_trace"
  | "system_memory"
  | "user_input"
  | "manual";

export interface TrustZoneProvenance {
  sourceClass: TrustZoneSourceClass;
  observedAt: string;
  sessionKey?: string;
  sourceId?: string;
  evidenceHash?: string;
}

export interface TrustZoneRecord {
  schemaVersion: 1;
  recordId: string;
  zone: TrustZoneName;
  recordedAt: string;
  kind: TrustZoneRecordKind;
  summary: string;
  provenance: TrustZoneProvenance;
  promotedFromZone?: TrustZoneName;
  entityRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface TrustZoneStoreStatus {
  enabled: boolean;
  promotionEnabled: boolean;
  rootDir: string;
  zonesDir: string;
  records: {
    total: number;
    valid: number;
    invalid: number;
    byZone: Partial<Record<TrustZoneName, number>>;
    byKind: Partial<Record<TrustZoneRecordKind, number>>;
    latestRecordId?: string;
    latestRecordedAt?: string;
    latestZone?: TrustZoneName;
  };
  latestRecord?: TrustZoneRecord;
  invalidRecords: Array<{
    path: string;
    error: string;
  }>;
}

function validateMetadata(raw: unknown): Record<string, string> | undefined {
  return validateStringRecord(raw, "metadata");
}

function validateZone(raw: unknown, field: string): TrustZoneName {
  const value = assertString(raw, field);
  if (!["quarantine", "working", "trusted"].includes(value)) {
    throw new Error(`${field} must be one of quarantine|working|trusted`);
  }
  return value as TrustZoneName;
}

function validateKind(raw: unknown): TrustZoneRecordKind {
  const value = assertString(raw, "kind");
  if (!["memory", "artifact", "state", "trajectory", "external"].includes(value)) {
    throw new Error("kind must be one of memory|artifact|state|trajectory|external");
  }
  return value as TrustZoneRecordKind;
}

function validateProvenance(raw: unknown): TrustZoneProvenance {
  if (!isRecord(raw)) throw new Error("provenance must be an object");
  const sourceClass = assertString(raw.sourceClass, "provenance.sourceClass");
  if (!["tool_output", "web_content", "subagent_trace", "system_memory", "user_input", "manual"].includes(sourceClass)) {
    throw new Error("provenance.sourceClass must be one of tool_output|web_content|subagent_trace|system_memory|user_input|manual");
  }
  return {
    sourceClass: sourceClass as TrustZoneSourceClass,
    observedAt: assertIsoRecordedAt(assertString(raw.observedAt, "provenance.observedAt"), "provenance.observedAt"),
    sessionKey: optionalString(raw.sessionKey),
    sourceId: optionalString(raw.sourceId),
    evidenceHash: optionalString(raw.evidenceHash),
  };
}

export function resolveTrustZoneStoreDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "trust-zones");
}

export function validateTrustZoneRecord(raw: unknown): TrustZoneRecord {
  if (!isRecord(raw)) throw new Error("trust-zone record must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  return {
    schemaVersion: 1,
    recordId: assertSafePathSegment(assertString(raw.recordId, "recordId"), "recordId"),
    zone: validateZone(raw.zone, "zone"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    kind: validateKind(raw.kind),
    summary: assertString(raw.summary, "summary"),
    provenance: validateProvenance(raw.provenance),
    promotedFromZone: raw.promotedFromZone === undefined ? undefined : validateZone(raw.promotedFromZone, "promotedFromZone"),
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateMetadata(raw.metadata),
  };
}

export async function recordTrustZoneRecord(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  record: TrustZoneRecord;
}): Promise<string> {
  const rootDir = resolveTrustZoneStoreDir(options.memoryDir, options.trustZoneStoreDir);
  const validated = validateTrustZoneRecord(options.record);
  const day = recordStoreDay(validated.recordedAt);
  const zoneDir = path.join(rootDir, "zones", validated.zone, day);
  const filePath = path.join(zoneDir, `${validated.recordId}.json`);
  await mkdir(zoneDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

async function readTrustZoneRecords(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
}): Promise<{
  files: string[];
  records: TrustZoneRecord[];
  invalidRecords: Array<{ path: string; error: string }>;
}> {
  const rootDir = resolveTrustZoneStoreDir(options.memoryDir, options.trustZoneStoreDir);
  const files = await listJsonFiles(path.join(rootDir, "zones"));
  const records: TrustZoneRecord[] = [];
  const invalidRecords: Array<{ path: string; error: string }> = [];
  for (const filePath of files) {
    try {
      records.push(validateTrustZoneRecord(await readJsonFile(filePath)));
    } catch (error) {
      invalidRecords.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { files, records, invalidRecords };
}

export async function getTrustZoneStoreStatus(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  enabled: boolean;
  promotionEnabled: boolean;
}): Promise<TrustZoneStoreStatus> {
  const rootDir = resolveTrustZoneStoreDir(options.memoryDir, options.trustZoneStoreDir);
  const zonesDir = path.join(rootDir, "zones");
  const { files, records, invalidRecords } = await readTrustZoneRecords(options);
  records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  const byZone: Partial<Record<TrustZoneName, number>> = {};
  const byKind: Partial<Record<TrustZoneRecordKind, number>> = {};
  for (const record of records) {
    byZone[record.zone] = (byZone[record.zone] ?? 0) + 1;
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
  }

  return {
    enabled: options.enabled,
    promotionEnabled: options.promotionEnabled,
    rootDir,
    zonesDir,
    records: {
      total: files.length,
      valid: records.length,
      invalid: invalidRecords.length,
      byZone,
      byKind,
      latestRecordId: records[0]?.recordId,
      latestRecordedAt: records[0]?.recordedAt,
      latestZone: records[0]?.zone,
    },
    latestRecord: records[0],
    invalidRecords,
  };
}
