import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import {
  assertIsoRecordedAt,
  assertSafePathSegment,
  assertString,
  isRecord,
  optionalStringArray,
  validateStringRecord,
} from "./store-contract.js";

export type CueAnchorType = "entity" | "file" | "tool" | "outcome" | "constraint" | "date";

export interface CueAnchor {
  schemaVersion: 1;
  anchorId: string;
  anchorType: CueAnchorType;
  anchorValue: string;
  normalizedCue: string;
  recordedAt: string;
  sessionKey: string;
  nodeRefs: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface CueAnchorStoreStatus {
  enabled: boolean;
  anchorsEnabled: boolean;
  rootDir: string;
  anchors: {
    total: number;
    valid: number;
    invalid: number;
    byType: Partial<Record<CueAnchorType, number>>;
    totalNodeRefs: number;
    latestAnchorId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestAnchor?: CueAnchor;
  invalidAnchors: Array<{
    path: string;
    error: string;
  }>;
}

function validateAnchorType(raw: unknown): CueAnchorType {
  const value = assertString(raw, "anchorType");
  if (!["entity", "file", "tool", "outcome", "constraint", "date"].includes(value)) {
    throw new Error("anchorType must be one of entity|file|tool|outcome|constraint|date");
  }
  return value as CueAnchorType;
}

function validateNodeRefs(raw: unknown): string[] {
  const nodeRefs = optionalStringArray(raw, "nodeRefs");
  if (!nodeRefs || nodeRefs.length === 0) {
    throw new Error("nodeRefs must contain at least one node reference");
  }
  return nodeRefs.map((nodeRef, index) => assertSafePathSegment(nodeRef, `nodeRefs[${index}]`));
}

export function resolveCueAnchorStoreDir(
  abstractionNodeStoreDir: string,
  overrideDir?: string,
): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(abstractionNodeStoreDir, "anchors");
}

export function validateCueAnchor(raw: unknown): CueAnchor {
  if (!isRecord(raw)) throw new Error("cue anchor must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  return {
    schemaVersion: 1,
    anchorId: assertSafePathSegment(assertString(raw.anchorId, "anchorId"), "anchorId"),
    anchorType: validateAnchorType(raw.anchorType),
    anchorValue: assertString(raw.anchorValue, "anchorValue"),
    normalizedCue: assertString(raw.normalizedCue, "normalizedCue"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    nodeRefs: validateNodeRefs(raw.nodeRefs),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateStringRecord(raw.metadata, "metadata"),
  };
}

export async function recordCueAnchor(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  cueAnchorStoreDir?: string;
  anchor: CueAnchor;
}): Promise<string> {
  const abstractionNodeStoreDir = options.abstractionNodeStoreDir?.trim().length
    ? options.abstractionNodeStoreDir.trim()
    : path.join(options.memoryDir, "state", "abstraction-nodes");
  const rootDir = resolveCueAnchorStoreDir(abstractionNodeStoreDir, options.cueAnchorStoreDir);
  const validated = validateCueAnchor(options.anchor);
  const anchorDir = path.join(rootDir, validated.anchorType);
  const filePath = path.join(anchorDir, `${validated.anchorId}.json`);
  await mkdir(anchorDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

export async function getCueAnchorStoreStatus(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  cueAnchorStoreDir?: string;
  enabled: boolean;
  anchorsEnabled: boolean;
}): Promise<CueAnchorStoreStatus> {
  const abstractionNodeStoreDir = options.abstractionNodeStoreDir?.trim().length
    ? options.abstractionNodeStoreDir.trim()
    : path.join(options.memoryDir, "state", "abstraction-nodes");
  const rootDir = resolveCueAnchorStoreDir(abstractionNodeStoreDir, options.cueAnchorStoreDir);
  const files = await listJsonFiles(rootDir);
  const anchors: CueAnchor[] = [];
  const invalidAnchors: Array<{ path: string; error: string }> = [];

  for (const filePath of files) {
    try {
      anchors.push(validateCueAnchor(await readJsonFile(filePath)));
    } catch (error) {
      invalidAnchors.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  anchors.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  const byType: Partial<Record<CueAnchorType, number>> = {};
  let totalNodeRefs = 0;
  for (const anchor of anchors) {
    byType[anchor.anchorType] = (byType[anchor.anchorType] ?? 0) + 1;
    totalNodeRefs += anchor.nodeRefs.length;
  }

  return {
    enabled: options.enabled,
    anchorsEnabled: options.anchorsEnabled,
    rootDir,
    anchors: {
      total: files.length,
      valid: anchors.length,
      invalid: invalidAnchors.length,
      byType,
      totalNodeRefs,
      latestAnchorId: anchors[0]?.anchorId,
      latestRecordedAt: anchors[0]?.recordedAt,
      latestSessionKey: anchors[0]?.sessionKey,
    },
    latestAnchor: anchors[0],
    invalidAnchors,
  };
}
