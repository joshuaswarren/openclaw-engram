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

export interface TrustZonePromotionPlan {
  allowed: boolean;
  reasons: string[];
  sourceRecordId: string;
  sourceZone: TrustZoneName;
  targetZone: TrustZoneName;
  provenanceAnchored: boolean;
}

export interface TrustZonePromotionResult {
  plan: TrustZonePromotionPlan;
  wroteRecord: boolean;
  record: TrustZoneRecord;
  filePath?: string;
  sourceRecord: TrustZoneRecord;
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

function hasAnchoredProvenance(record: TrustZoneRecord): boolean {
  return Boolean(record.provenance.sourceId && record.provenance.evidenceHash);
}

function buildPromotionRecordId(sourceRecordId: string, targetZone: TrustZoneName, recordedAt: string): string {
  const suffix = recordedAt.replace(/[^0-9]/g, "").slice(0, 14);
  return `${sourceRecordId}-${targetZone}-${suffix}`;
}

function dedupeStrings(values: Array<string | undefined>): string[] | undefined {
  const out = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (out.length === 0) return undefined;
  return [...new Set(out)];
}

export function planTrustZonePromotion(options: {
  record: TrustZoneRecord;
  targetZone: TrustZoneName;
}): TrustZonePromotionPlan {
  const { record, targetZone } = options;
  const reasons: string[] = [];
  const provenanceAnchored = hasAnchoredProvenance(record);

  if (record.zone === targetZone) {
    reasons.push(`record is already in the ${targetZone} zone`);
  }
  if (record.zone === "trusted") {
    reasons.push("trusted records are terminal and cannot be promoted again");
  }
  if (record.zone === "quarantine" && targetZone === "trusted") {
    reasons.push("quarantine records must pass through working before trusted promotion");
  }
  if (record.zone === "working" && targetZone === "quarantine") {
    reasons.push("working records cannot be demoted back into quarantine in this promotion path");
  }
  if (record.zone === "quarantine" && targetZone !== "working") {
    reasons.push("quarantine promotions only support the working zone");
  }
  if (record.zone === "working" && targetZone !== "trusted") {
    reasons.push("working promotions only support the trusted zone");
  }
  if (
    targetZone === "trusted" &&
    ["tool_output", "web_content", "subagent_trace"].includes(record.provenance.sourceClass) &&
    provenanceAnchored !== true
  ) {
    reasons.push("trusted promotion for external/tool-derived provenance requires both provenance.sourceId and provenance.evidenceHash");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    sourceRecordId: record.recordId,
    sourceZone: record.zone,
    targetZone,
    provenanceAnchored,
  };
}

async function findTrustZoneRecordById(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  recordId: string;
}): Promise<TrustZoneRecord | null> {
  const { records } = await readTrustZoneRecords(options);
  records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  return records.find((record) => record.recordId === options.recordId) ?? null;
}

export async function promoteTrustZoneRecord(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  enabled: boolean;
  promotionEnabled: boolean;
  sourceRecordId: string;
  targetZone: TrustZoneName;
  recordedAt: string;
  promotionReason: string;
  summary?: string;
  dryRun?: boolean;
}): Promise<TrustZonePromotionResult> {
  if (options.enabled !== true) {
    throw new Error("trust zone promotion requires trustZonesEnabled=true");
  }
  if (options.promotionEnabled !== true) {
    throw new Error("trust zone promotion requires quarantinePromotionEnabled=true");
  }

  const sourceRecord = await findTrustZoneRecordById({
    memoryDir: options.memoryDir,
    trustZoneStoreDir: options.trustZoneStoreDir,
    recordId: assertSafePathSegment(assertString(options.sourceRecordId, "sourceRecordId"), "sourceRecordId"),
  });
  if (!sourceRecord) {
    throw new Error(`source trust-zone record not found: ${options.sourceRecordId}`);
  }

  const plan = planTrustZonePromotion({
    record: sourceRecord,
    targetZone: options.targetZone,
  });
  if (!plan.allowed) {
    throw new Error(`trust-zone promotion denied: ${plan.reasons.join("; ")}`);
  }

  const recordedAt = assertIsoRecordedAt(assertString(options.recordedAt, "recordedAt"));
  const promotionReason = assertString(options.promotionReason, "promotionReason");
  const nextRecord: TrustZoneRecord = {
    schemaVersion: 1,
    recordId: buildPromotionRecordId(sourceRecord.recordId, options.targetZone, recordedAt),
    zone: options.targetZone,
    recordedAt,
    kind: sourceRecord.kind,
    summary: optionalString(options.summary) ?? sourceRecord.summary,
    provenance: sourceRecord.provenance,
    promotedFromZone: sourceRecord.zone,
    entityRefs: sourceRecord.entityRefs,
    tags: dedupeStrings([...(sourceRecord.tags ?? []), "promotion"]),
    metadata: {
      ...(sourceRecord.metadata ?? {}),
      sourceRecordId: sourceRecord.recordId,
      promotionReason,
    },
  };

  if (options.dryRun === true) {
    return {
      plan,
      wroteRecord: false,
      record: nextRecord,
      sourceRecord,
    };
  }

  const filePath = await recordTrustZoneRecord({
    memoryDir: options.memoryDir,
    trustZoneStoreDir: options.trustZoneStoreDir,
    record: nextRecord,
  });

  return {
    plan,
    wroteRecord: true,
    record: nextRecord,
    filePath,
    sourceRecord,
  };
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
