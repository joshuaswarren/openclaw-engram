import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import {
  assertIsoRecordedAt,
  assertSafePathSegment,
  assertString,
  isRecord,
  optionalStringArray,
  recordStoreDay,
  validateStringRecord,
} from "./store-contract.js";

export type AbstractionNodeKind = "episode" | "topic" | "project" | "workflow" | "constraint";
export type AbstractionLevel = "micro" | "meso" | "macro";

export interface AbstractionNode {
  schemaVersion: 1;
  nodeId: string;
  recordedAt: string;
  sessionKey: string;
  kind: AbstractionNodeKind;
  abstractionLevel: AbstractionLevel;
  title: string;
  summary: string;
  sourceMemoryIds?: string[];
  entityRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface AbstractionNodeStoreStatus {
  enabled: boolean;
  anchorsEnabled: boolean;
  rootDir: string;
  nodesDir: string;
  nodes: {
    total: number;
    valid: number;
    invalid: number;
    byKind: Partial<Record<AbstractionNodeKind, number>>;
    byLevel: Partial<Record<AbstractionLevel, number>>;
    latestNodeId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestNode?: AbstractionNode;
  invalidNodes: Array<{
    path: string;
    error: string;
  }>;
}

function validateKind(raw: unknown): AbstractionNodeKind {
  const value = assertString(raw, "kind");
  if (!["episode", "topic", "project", "workflow", "constraint"].includes(value)) {
    throw new Error("kind must be one of episode|topic|project|workflow|constraint");
  }
  return value as AbstractionNodeKind;
}

function validateLevel(raw: unknown): AbstractionLevel {
  const value = assertString(raw, "abstractionLevel");
  if (!["micro", "meso", "macro"].includes(value)) {
    throw new Error("abstractionLevel must be one of micro|meso|macro");
  }
  return value as AbstractionLevel;
}

export function resolveAbstractionNodeStoreDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "abstraction-nodes");
}

export function validateAbstractionNode(raw: unknown): AbstractionNode {
  if (!isRecord(raw)) throw new Error("abstraction node must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  return {
    schemaVersion: 1,
    nodeId: assertSafePathSegment(assertString(raw.nodeId, "nodeId"), "nodeId"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    kind: validateKind(raw.kind),
    abstractionLevel: validateLevel(raw.abstractionLevel),
    title: assertString(raw.title, "title"),
    summary: assertString(raw.summary, "summary"),
    sourceMemoryIds: optionalStringArray(raw.sourceMemoryIds, "sourceMemoryIds"),
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateStringRecord(raw.metadata, "metadata"),
  };
}

export async function recordAbstractionNode(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  node: AbstractionNode;
}): Promise<string> {
  const rootDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const validated = validateAbstractionNode(options.node);
  const day = recordStoreDay(validated.recordedAt);
  const nodesDir = path.join(rootDir, "nodes", day);
  const filePath = path.join(nodesDir, `${validated.nodeId}.json`);
  await mkdir(nodesDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

export async function getAbstractionNodeStoreStatus(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  enabled: boolean;
  anchorsEnabled: boolean;
}): Promise<AbstractionNodeStoreStatus> {
  const rootDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const nodesDir = path.join(rootDir, "nodes");
  const files = await listJsonFiles(nodesDir);
  const nodes: AbstractionNode[] = [];
  const invalidNodes: Array<{ path: string; error: string }> = [];

  for (const filePath of files) {
    try {
      nodes.push(validateAbstractionNode(await readJsonFile(filePath)));
    } catch (error) {
      invalidNodes.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  nodes.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  const byKind: Partial<Record<AbstractionNodeKind, number>> = {};
  const byLevel: Partial<Record<AbstractionLevel, number>> = {};
  for (const node of nodes) {
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
    byLevel[node.abstractionLevel] = (byLevel[node.abstractionLevel] ?? 0) + 1;
  }

  return {
    enabled: options.enabled,
    anchorsEnabled: options.anchorsEnabled,
    rootDir,
    nodesDir,
    nodes: {
      total: files.length,
      valid: nodes.length,
      invalid: invalidNodes.length,
      byKind,
      byLevel,
      latestNodeId: nodes[0]?.nodeId,
      latestRecordedAt: nodes[0]?.recordedAt,
      latestSessionKey: nodes[0]?.sessionKey,
    },
    latestNode: nodes[0],
    invalidNodes,
  };
}
