import path from "node:path";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";

export type EvalRunStatus = "running" | "completed" | "failed" | "partial";

export interface EvalBenchmarkCase {
  id: string;
  prompt: string;
  expectedSignals?: string[];
  notes?: string;
}

export interface EvalBenchmarkManifest {
  schemaVersion: 1;
  benchmarkId: string;
  title: string;
  description?: string;
  tags?: string[];
  sourceLinks?: string[];
  cases: EvalBenchmarkCase[];
}

export interface EvalRunMetrics {
  recallPrecisionAtK?: number;
  actionOutcomeScore?: number;
  objectiveStateCoverage?: number;
  causalPathRecall?: number;
  trustViolationRate?: number;
  creationRecoveryScore?: number;
}

export interface EvalRunSummary {
  schemaVersion: 1;
  runId: string;
  benchmarkId: string;
  status: EvalRunStatus;
  startedAt: string;
  completedAt?: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  metrics?: EvalRunMetrics;
  notes?: string;
  gitRef?: string;
}

export interface EvalShadowRecallRecord {
  schemaVersion: 1;
  traceId: string;
  recordedAt: string;
  sessionKey: string;
  promptHash: string;
  promptLength: number;
  retrievalQueryHash: string;
  retrievalQueryLength: number;
  recallMode: "no_recall" | "minimal" | "full" | "graph_mode";
  recallResultLimit: number;
  source: "none" | "hot_qmd" | "hot_embedding" | "cold_fallback" | "recent_scan";
  recalledMemoryCount: number;
  injected: boolean;
  contextChars: number;
  memoryIds: string[];
  policyVersion?: string;
  identityInjectionMode?: "recovery_only" | "minimal" | "full" | "none";
  identityInjectedChars?: number;
  identityInjectionTruncated?: boolean;
  durationMs: number;
  timings?: Record<string, string>;
}

export interface EvalHarnessStatus {
  enabled: boolean;
  shadowModeEnabled: boolean;
  rootDir: string;
  benchmarkDir: string;
  runsDir: string;
  benchmarks: {
    total: number;
    valid: number;
    invalid: number;
    totalCases: number;
    tags: string[];
    sourceLinks: string[];
  };
  runs: {
    total: number;
    invalid: number;
    completed: number;
    failed: number;
    partial: number;
    running: number;
    latestRunId?: string;
    latestBenchmarkId?: string;
    latestCompletedAt?: string;
  };
  shadows: {
    total: number;
    invalid: number;
    latestTraceId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestRun?: EvalRunSummary;
  latestShadow?: EvalShadowRecallRecord;
  invalidBenchmarks: Array<{
    path: string;
    error: string;
  }>;
  invalidRuns: Array<{
    path: string;
    error: string;
  }>;
  invalidShadows: Array<{
    path: string;
    error: string;
  }>;
}

export interface EvalBenchmarkPackSummary {
  sourcePath: string;
  manifestPath: string;
  benchmarkId: string;
  title: string;
  totalCases: number;
  tags: string[];
  sourceLinks: string[];
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

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (out.length !== value.length) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return out;
}

export function resolveEvalStoreDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "evals");
}

function assertSafeBenchmarkId(benchmarkId: string): string {
  if (benchmarkId === "." || benchmarkId === ".." || benchmarkId.includes("/") || benchmarkId.includes("\\")) {
    throw new Error("benchmarkId must be a safe path segment");
  }
  return benchmarkId;
}

export function validateEvalBenchmarkManifest(raw: unknown): EvalBenchmarkManifest {
  if (!isRecord(raw)) throw new Error("benchmark manifest must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (!Array.isArray(raw.cases)) throw new Error("cases must be an array");

  const cases = raw.cases.map((item, index) => {
    if (!isRecord(item)) throw new Error(`cases[${index}] must be an object`);
    return {
      id: assertString(item.id, `cases[${index}].id`),
      prompt: assertString(item.prompt, `cases[${index}].prompt`),
      expectedSignals: optionalStringArray(item.expectedSignals, `cases[${index}].expectedSignals`),
      notes: typeof item.notes === "string" && item.notes.trim().length > 0 ? item.notes.trim() : undefined,
    } satisfies EvalBenchmarkCase;
  });

  return {
    schemaVersion: 1,
    benchmarkId: assertString(raw.benchmarkId, "benchmarkId"),
    title: assertString(raw.title, "title"),
    description:
      typeof raw.description === "string" && raw.description.trim().length > 0
        ? raw.description.trim()
        : undefined,
    tags: optionalStringArray(raw.tags, "tags"),
    sourceLinks: optionalStringArray(raw.sourceLinks, "sourceLinks"),
    cases,
  };
}

export function validateEvalRunSummary(raw: unknown): EvalRunSummary {
  if (!isRecord(raw)) throw new Error("eval run summary must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const status = assertString(raw.status, "status");
  if (!["running", "completed", "failed", "partial"].includes(status)) {
    throw new Error("status must be one of running|completed|failed|partial");
  }

  const totalCases = Number(raw.totalCases);
  const passedCases = Number(raw.passedCases);
  const failedCases = Number(raw.failedCases);
  if (!Number.isFinite(totalCases) || totalCases < 0) throw new Error("totalCases must be a non-negative number");
  if (!Number.isFinite(passedCases) || passedCases < 0) throw new Error("passedCases must be a non-negative number");
  if (!Number.isFinite(failedCases) || failedCases < 0) throw new Error("failedCases must be a non-negative number");

  const metrics = isRecord(raw.metrics)
    ? {
        recallPrecisionAtK:
          typeof raw.metrics.recallPrecisionAtK === "number" ? raw.metrics.recallPrecisionAtK : undefined,
        actionOutcomeScore:
          typeof raw.metrics.actionOutcomeScore === "number" ? raw.metrics.actionOutcomeScore : undefined,
        objectiveStateCoverage:
          typeof raw.metrics.objectiveStateCoverage === "number" ? raw.metrics.objectiveStateCoverage : undefined,
        causalPathRecall:
          typeof raw.metrics.causalPathRecall === "number" ? raw.metrics.causalPathRecall : undefined,
        trustViolationRate:
          typeof raw.metrics.trustViolationRate === "number" ? raw.metrics.trustViolationRate : undefined,
        creationRecoveryScore:
          typeof raw.metrics.creationRecoveryScore === "number" ? raw.metrics.creationRecoveryScore : undefined,
      } satisfies EvalRunMetrics
    : undefined;

  return {
    schemaVersion: 1,
    runId: assertString(raw.runId, "runId"),
    benchmarkId: assertString(raw.benchmarkId, "benchmarkId"),
    status: status as EvalRunStatus,
    startedAt: assertString(raw.startedAt, "startedAt"),
    completedAt:
      typeof raw.completedAt === "string" && raw.completedAt.trim().length > 0
        ? raw.completedAt.trim()
        : undefined,
    totalCases,
    passedCases,
    failedCases,
    metrics,
    notes: typeof raw.notes === "string" && raw.notes.trim().length > 0 ? raw.notes.trim() : undefined,
    gitRef: typeof raw.gitRef === "string" && raw.gitRef.trim().length > 0 ? raw.gitRef.trim() : undefined,
  };
}

export function validateEvalShadowRecallRecord(raw: unknown): EvalShadowRecallRecord {
  if (!isRecord(raw)) throw new Error("eval shadow recall record must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const recallMode = assertString(raw.recallMode, "recallMode");
  if (!["no_recall", "minimal", "full", "graph_mode"].includes(recallMode)) {
    throw new Error("recallMode must be one of no_recall|minimal|full|graph_mode");
  }

  const source = assertString(raw.source, "source");
  if (!["none", "hot_qmd", "hot_embedding", "cold_fallback", "recent_scan"].includes(source)) {
    throw new Error("source must be one of none|hot_qmd|hot_embedding|cold_fallback|recent_scan");
  }

  const promptLength = Number(raw.promptLength);
  const retrievalQueryLength = Number(raw.retrievalQueryLength);
  const recallResultLimit = Number(raw.recallResultLimit);
  const recalledMemoryCount = Number(raw.recalledMemoryCount);
  const contextChars = Number(raw.contextChars);
  const durationMs = Number(raw.durationMs);

  for (const [field, value] of [
    ["promptLength", promptLength],
    ["retrievalQueryLength", retrievalQueryLength],
    ["recallResultLimit", recallResultLimit],
    ["recalledMemoryCount", recalledMemoryCount],
    ["contextChars", contextChars],
    ["durationMs", durationMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a non-negative number`);
    }
  }

  const memoryIds = optionalStringArray(raw.memoryIds, "memoryIds") ?? [];
  if (typeof raw.injected !== "boolean") throw new Error("injected must be a boolean");

  let timings: Record<string, string> | undefined;
  if (raw.timings !== undefined) {
    if (!isRecord(raw.timings)) throw new Error("timings must be an object of strings");
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.timings)) {
      if (typeof value !== "string") throw new Error("timings must be an object of strings");
      out[key] = value;
    }
    timings = out;
  }

  const identityInjectionModeRaw =
    typeof raw.identityInjectionMode === "string" && raw.identityInjectionMode.trim().length > 0
      ? raw.identityInjectionMode.trim()
      : undefined;
  if (
    identityInjectionModeRaw !== undefined &&
    !["recovery_only", "minimal", "full", "none"].includes(identityInjectionModeRaw)
  ) {
    throw new Error("identityInjectionMode must be one of recovery_only|minimal|full|none");
  }

  return {
    schemaVersion: 1,
    traceId: assertString(raw.traceId, "traceId"),
    recordedAt: assertString(raw.recordedAt, "recordedAt"),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    promptHash: assertString(raw.promptHash, "promptHash"),
    promptLength,
    retrievalQueryHash: assertString(raw.retrievalQueryHash, "retrievalQueryHash"),
    retrievalQueryLength,
    recallMode: recallMode as EvalShadowRecallRecord["recallMode"],
    recallResultLimit,
    source: source as EvalShadowRecallRecord["source"],
    recalledMemoryCount,
    injected: raw.injected,
    contextChars,
    memoryIds,
    policyVersion:
      typeof raw.policyVersion === "string" && raw.policyVersion.trim().length > 0
        ? raw.policyVersion.trim()
        : undefined,
    identityInjectionMode: identityInjectionModeRaw as EvalShadowRecallRecord["identityInjectionMode"],
    identityInjectedChars:
      typeof raw.identityInjectedChars === "number" && Number.isFinite(raw.identityInjectedChars)
        ? raw.identityInjectedChars
        : undefined,
    identityInjectionTruncated:
      typeof raw.identityInjectionTruncated === "boolean" ? raw.identityInjectionTruncated : undefined,
    durationMs,
    timings,
  };
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await listJsonFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        out.push(fullPath);
      }
    }
    return out.sort();
  } catch {
    return [];
  }
}

async function listNamedFiles(dir: string, fileName: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await listNamedFiles(fullPath, fileName)));
      } else if (entry.isFile() && entry.name === fileName) {
        out.push(fullPath);
      }
    }
    return out.sort();
  } catch {
    return [];
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf-8")) as unknown;
}

async function resolveBenchmarkManifestPath(sourcePath: string): Promise<{ sourceKind: "file" | "directory"; manifestPath: string }> {
  const info = await stat(sourcePath);
  if (info.isDirectory()) {
    return {
      sourceKind: "directory",
      manifestPath: path.join(sourcePath, "manifest.json"),
    };
  }
  if (info.isFile()) {
    return {
      sourceKind: "file",
      manifestPath: sourcePath,
    };
  }
  throw new Error("benchmark pack source must be a file or directory");
}

export async function validateEvalBenchmarkPack(sourcePath: string): Promise<EvalBenchmarkPackSummary> {
  const trimmedSourcePath = sourcePath.trim();
  if (trimmedSourcePath.length === 0) {
    throw new Error("benchmark pack path must be a non-empty string");
  }
  const { manifestPath } = await resolveBenchmarkManifestPath(trimmedSourcePath);
  const manifest = validateEvalBenchmarkManifest(await readJsonFile(manifestPath));
  return {
    sourcePath: trimmedSourcePath,
    manifestPath,
    benchmarkId: assertSafeBenchmarkId(manifest.benchmarkId),
    title: manifest.title,
    totalCases: manifest.cases.length,
    tags: [...(manifest.tags ?? [])],
    sourceLinks: [...(manifest.sourceLinks ?? [])],
  };
}

export async function importEvalBenchmarkPack(options: {
  sourcePath: string;
  memoryDir: string;
  evalStoreDir?: string;
  force?: boolean;
}): Promise<EvalBenchmarkPackSummary & { targetDir: string; overwritten: boolean }> {
  const summary = await validateEvalBenchmarkPack(options.sourcePath);
  const rootDir = resolveEvalStoreDir(options.memoryDir, options.evalStoreDir);
  const benchmarkDir = path.join(rootDir, "benchmarks");
  const targetDir = path.join(benchmarkDir, summary.benchmarkId);
  const { sourceKind, manifestPath } = await resolveBenchmarkManifestPath(summary.sourcePath);

  let overwritten = false;
  try {
    await stat(targetDir);
    if (options.force !== true) {
      throw new Error(`benchmark pack already exists at ${targetDir}; rerun with force to replace it`);
    }
    overwritten = true;
    await rm(targetDir, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(benchmarkDir, { recursive: true });
  if (sourceKind === "directory") {
    await cp(summary.sourcePath, targetDir, { recursive: true });
  } else {
    await mkdir(targetDir, { recursive: true });
    await cp(manifestPath, path.join(targetDir, "manifest.json"));
  }

  return {
    ...summary,
    targetDir,
    overwritten,
  };
}

export async function recordEvalShadowRecall(options: {
  memoryDir: string;
  evalStoreDir?: string;
  record: EvalShadowRecallRecord;
}): Promise<string> {
  const rootDir = resolveEvalStoreDir(options.memoryDir, options.evalStoreDir);
  const validated = validateEvalShadowRecallRecord(options.record);
  const day = validated.recordedAt.slice(0, 10);
  const shadowDir = path.join(rootDir, "shadow", day);
  const targetPath = path.join(shadowDir, `${validated.traceId}.json`);
  await mkdir(shadowDir, { recursive: true });
  await writeFile(targetPath, JSON.stringify(validated, null, 2), "utf-8");
  return targetPath;
}

export async function getEvalHarnessStatus(options: {
  memoryDir: string;
  evalStoreDir?: string;
  enabled: boolean;
  shadowModeEnabled: boolean;
}): Promise<EvalHarnessStatus> {
  const rootDir = resolveEvalStoreDir(options.memoryDir, options.evalStoreDir);
  const benchmarkDir = path.join(rootDir, "benchmarks");
  const runsDir = path.join(rootDir, "runs");
  const shadowDir = path.join(rootDir, "shadow");
  const benchmarkFiles = await listNamedFiles(benchmarkDir, "manifest.json");
  const runFiles = await listJsonFiles(runsDir);
  const shadowFiles = await listJsonFiles(shadowDir);

  const invalidBenchmarks: Array<{ path: string; error: string }> = [];
  const invalidRuns: Array<{ path: string; error: string }> = [];
  const invalidShadows: Array<{ path: string; error: string }> = [];
  const manifests: EvalBenchmarkManifest[] = [];

  for (const filePath of benchmarkFiles) {
    try {
      manifests.push(validateEvalBenchmarkManifest(await readJsonFile(filePath)));
    } catch (error) {
      invalidBenchmarks.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const runs: EvalRunSummary[] = [];
  for (const filePath of runFiles) {
    try {
      runs.push(validateEvalRunSummary(await readJsonFile(filePath)));
    } catch (error) {
      invalidRuns.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const shadows: EvalShadowRecallRecord[] = [];
  for (const filePath of shadowFiles) {
    try {
      shadows.push(validateEvalShadowRecallRecord(await readJsonFile(filePath)));
    } catch (error) {
      invalidShadows.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  runs.sort((a, b) => {
    const aTime = Date.parse(a.completedAt ?? a.startedAt);
    const bTime = Date.parse(b.completedAt ?? b.startedAt);
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });
  const latestRun = runs[0];
  shadows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const latestShadow = shadows[0];

  const tags = new Set<string>();
  const sourceLinks = new Set<string>();
  let totalCases = 0;
  for (const manifest of manifests) {
    totalCases += manifest.cases.length;
    for (const tag of manifest.tags ?? []) tags.add(tag);
    for (const link of manifest.sourceLinks ?? []) sourceLinks.add(link);
  }

  return {
    enabled: options.enabled,
    shadowModeEnabled: options.shadowModeEnabled,
    rootDir,
    benchmarkDir,
    runsDir,
    benchmarks: {
      total: benchmarkFiles.length,
      valid: manifests.length,
      invalid: invalidBenchmarks.length,
      totalCases,
      tags: [...tags].sort(),
      sourceLinks: [...sourceLinks].sort(),
    },
    runs: {
      total: runFiles.length,
      invalid: invalidRuns.length,
      completed: runs.filter((run) => run.status === "completed").length,
      failed: runs.filter((run) => run.status === "failed").length,
      partial: runs.filter((run) => run.status === "partial").length,
      running: runs.filter((run) => run.status === "running").length,
      latestRunId: latestRun?.runId,
      latestBenchmarkId: latestRun?.benchmarkId,
      latestCompletedAt: latestRun?.completedAt,
    },
    shadows: {
      total: shadowFiles.length,
      invalid: invalidShadows.length,
      latestTraceId: latestShadow?.traceId,
      latestRecordedAt: latestShadow?.recordedAt,
      latestSessionKey: latestShadow?.sessionKey,
    },
    latestRun,
    latestShadow,
    invalidBenchmarks,
    invalidRuns,
    invalidShadows,
  };
}
