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

export type ResumeBundleSource = "tool_result" | "cli" | "system" | "manual";

export interface ResumeBundle {
  schemaVersion: 1;
  bundleId: string;
  recordedAt: string;
  sessionKey: string;
  source: ResumeBundleSource;
  scope: string;
  summary: string;
  objectiveStateSnapshotRefs?: string[];
  workProductEntryRefs?: string[];
  commitmentEntryRefs?: string[];
  keyFacts?: string[];
  nextActions?: string[];
  riskFlags?: string[];
  metadata?: Record<string, string>;
}

export interface ResumeBundleStatus {
  enabled: boolean;
  rootDir: string;
  bundlesDir: string;
  bundles: {
    total: number;
    valid: number;
    invalid: number;
    bySource: Partial<Record<ResumeBundleSource, number>>;
    latestBundleId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestBundle?: ResumeBundle;
  invalidBundles: Array<{
    path: string;
    error: string;
  }>;
}

export function resolveResumeBundleDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "resume-bundles");
}

export function validateResumeBundle(raw: unknown): ResumeBundle {
  if (!isRecord(raw)) throw new Error("resume bundle must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const source = assertString(raw.source, "source");
  if (!["tool_result", "cli", "system", "manual"].includes(source)) {
    throw new Error("source must be one of tool_result|cli|system|manual");
  }

  return {
    schemaVersion: 1,
    bundleId: assertSafePathSegment(assertString(raw.bundleId, "bundleId"), "bundleId"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    source: source as ResumeBundleSource,
    scope: assertString(raw.scope, "scope"),
    summary: assertString(raw.summary, "summary"),
    objectiveStateSnapshotRefs: optionalStringArray(raw.objectiveStateSnapshotRefs, "objectiveStateSnapshotRefs"),
    workProductEntryRefs: optionalStringArray(raw.workProductEntryRefs, "workProductEntryRefs"),
    commitmentEntryRefs: optionalStringArray(raw.commitmentEntryRefs, "commitmentEntryRefs"),
    keyFacts: optionalStringArray(raw.keyFacts, "keyFacts"),
    nextActions: optionalStringArray(raw.nextActions, "nextActions"),
    riskFlags: optionalStringArray(raw.riskFlags, "riskFlags"),
    metadata: validateStringRecord(raw.metadata, "metadata"),
  };
}

export async function recordResumeBundle(options: {
  memoryDir: string;
  resumeBundleDir?: string;
  bundle: ResumeBundle;
}): Promise<string> {
  const rootDir = resolveResumeBundleDir(options.memoryDir, options.resumeBundleDir);
  const validated = validateResumeBundle(options.bundle);
  const day = recordStoreDay(validated.recordedAt);
  const bundlesDir = path.join(rootDir, "bundles", day);
  const filePath = path.join(bundlesDir, `${validated.bundleId}.json`);
  await mkdir(bundlesDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

async function readResumeBundles(options: {
  memoryDir: string;
  resumeBundleDir?: string;
}): Promise<{
  files: string[];
  bundles: ResumeBundle[];
  invalidBundles: Array<{ path: string; error: string }>;
}> {
  const rootDir = resolveResumeBundleDir(options.memoryDir, options.resumeBundleDir);
  const files = await listJsonFiles(path.join(rootDir, "bundles"));
  const bundles: ResumeBundle[] = [];
  const invalidBundles: Array<{ path: string; error: string }> = [];
  for (const filePath of files) {
    try {
      bundles.push(validateResumeBundle(await readJsonFile(filePath)));
    } catch (error) {
      invalidBundles.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { files, bundles, invalidBundles };
}

export async function getResumeBundleStatus(options: {
  memoryDir: string;
  resumeBundleDir?: string;
  enabled: boolean;
}): Promise<ResumeBundleStatus> {
  const rootDir = resolveResumeBundleDir(options.memoryDir, options.resumeBundleDir);
  const bundlesDir = path.join(rootDir, "bundles");
  const { files, bundles, invalidBundles } = await readResumeBundles(options);

  let latestBundle: ResumeBundle | undefined;
  const bySource: Partial<Record<ResumeBundleSource, number>> = {};
  for (const bundle of bundles) {
    bySource[bundle.source] = (bySource[bundle.source] ?? 0) + 1;
    if (!latestBundle || Date.parse(bundle.recordedAt) > Date.parse(latestBundle.recordedAt)) {
      latestBundle = bundle;
    }
  }

  return {
    enabled: options.enabled,
    rootDir,
    bundlesDir,
    bundles: {
      total: files.length,
      valid: bundles.length,
      invalid: invalidBundles.length,
      bySource,
      latestBundleId: latestBundle?.bundleId,
      latestRecordedAt: latestBundle?.recordedAt,
      latestSessionKey: latestBundle?.sessionKey,
    },
    latestBundle,
    invalidBundles,
  };
}
