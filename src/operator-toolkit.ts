import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { lintWorkspaceFiles } from "./hygiene.js";
import { parseConfig } from "./config.js";
import { StorageManager } from "./storage.js";
import { listNamespaces } from "./namespaces/migrate.js";
import {
  createEvalBaselineSnapshot,
  getEvalHarnessStatus,
  runEvalBaselineDeltaReport,
  runEvalBenchmarkCiGate,
  validateEvalBenchmarkPack,
  type EvalBaselineDeltaReport,
  type EvalCiGateReport,
  type EvalHarnessStatus,
} from "./evals.js";
import { analyzeGraphHealth, type GraphHealthReport } from "./graph.js";
import {
  analyzeSessionIntegrity,
  applySessionRepair,
  planSessionRepair,
  type SessionIntegrityReport,
  type SessionRepairApplyResult,
  type SessionRepairPlan,
} from "./session-integrity.js";
import {
  listMemoryGovernanceRuns,
  readMemoryGovernanceRunArtifact,
} from "./maintenance/memory-governance.js";
import type { FileHygieneConfig, MemoryFile, PluginConfig } from "./types.js";

interface QmdRuntimeLike {
  probe(): Promise<boolean>;
  isAvailable(): boolean;
  ensureCollection(memoryDir: string): Promise<"present" | "missing" | "unknown" | "skipped">;
  debugStatus(): string;
}

interface ConversationIndexLike {
  getConversationIndexHealth(): Promise<{
    enabled: boolean;
    backend: "qmd" | "faiss";
    status: "ok" | "degraded" | "disabled";
    chunkDocCount: number;
    lastUpdateAt: string | null;
    qmdAvailable?: boolean;
    faiss?: {
      ok: boolean;
      status: "ok" | "degraded" | "error";
      indexPath: string;
      message?: string;
      manifest?: {
        version: number;
        modelId: string;
        normalizedModelId: string;
        dimension: number;
        chunkCount: number;
        updatedAt: string;
        lastSuccessfulRebuildAt: string;
      };
    };
  }>;
  rebuildConversationIndex(
    sessionKey?: string,
    hours?: number,
    opts?: { embed?: boolean },
  ): Promise<{
    chunks: number;
    skipped: boolean;
    reason?: string;
    embedded?: boolean;
    rebuilt?: boolean;
  }>;
}

export interface OperatorToolkitOrchestrator extends ConversationIndexLike {
  config: PluginConfig;
  qmd: QmdRuntimeLike;
}

export interface OperatorConfigLoadResult {
  found: boolean;
  path: string;
  parsed: boolean;
  memoryDir?: string;
  workspaceDir?: string;
  error?: string;
}

export interface OperatorSetupReport {
  schemaVersion: 1;
  generatedAt: string;
  config: OperatorConfigLoadResult;
  memoryDir: string;
  workspaceDir: string;
  directories: Array<{ path: string; exists: boolean; writable: boolean }>;
  qmd: {
    enabled: boolean;
    available: boolean;
    collectionState: "present" | "missing" | "unknown" | "skipped";
    debugStatus: string;
  };
  nativeKnowledge: {
    enabled: boolean;
    includeFiles: string[];
    openclawWorkspaceAdapterEnabled: boolean;
    obsidianVaultAdapterEnabled: boolean;
  };
  explicitCapture: {
    captureMode: string;
    enabled: boolean;
    memoryDocPath: string;
    memoryDocExists: boolean;
    memoryDocInstalled: boolean;
  };
  nextSteps: string[];
  verificationCommands: string[];
}

export interface OperatorDoctorCheck {
  key: string;
  status: "ok" | "warn" | "error";
  summary: string;
  remediation?: string;
  details?: unknown;
}

export interface OperatorDoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  ok: boolean;
  summary: {
    ok: number;
    warn: number;
    error: number;
  };
  config: OperatorConfigLoadResult;
  checks: OperatorDoctorCheck[];
}

export interface OperatorInventoryNamespaceSummary {
  namespace: string;
  memoryCount: number;
  entityCount: number;
}

export interface OperatorInventoryReport {
  schemaVersion: 1;
  generatedAt: string;
  memoryDir: string;
  totals: {
    memories: number;
    entities: number;
    namespaces: number;
    reviewQueue: number;
    storageBytes: number;
  };
  categories: Record<string, number>;
  statuses: Record<string, number>;
  namespaces: OperatorInventoryNamespaceSummary[];
  ageBands: Record<string, number>;
  profile: {
    exists: boolean;
    chars: number;
    lines: number;
  };
  storageFootprint: {
    bytes: number;
    byTopLevel: Record<string, number>;
  };
  archivePressure: {
    archived: number;
    pendingReview: number;
    quarantined: number;
    rejected: number;
  };
  conversationIndex: {
    enabled: boolean;
    backend: "qmd" | "faiss";
    status: "ok" | "degraded" | "disabled";
    chunkDocCount: number;
    lastUpdateAt: string | null;
  };
}

export interface BenchmarkRecallReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: "status" | "validate" | "baseline-report" | "ci-gate" | "snapshot";
  status: EvalHarnessStatus;
  validate?: Awaited<ReturnType<typeof validateEvalBenchmarkPack>>;
  baselineReport?: EvalBaselineDeltaReport;
  ciGate?: EvalCiGateReport;
  snapshot?: {
    targetPath: string;
    snapshotId: string;
  };
}

export interface OperatorRepairReport {
  schemaVersion: 1;
  generatedAt: string;
  dryRun: boolean;
  sessionCheck: SessionIntegrityReport;
  sessionRepairPlan: SessionRepairPlan;
  sessionRepairApply: SessionRepairApplyResult;
  graphHealth: GraphHealthReport;
}

export interface OperatorSetupOptions {
  orchestrator: OperatorToolkitOrchestrator;
  installCaptureInstructions?: boolean;
  configPath?: string;
  now?: Date;
}

export interface OperatorDoctorOptions {
  orchestrator: OperatorToolkitOrchestrator;
  configPath?: string;
  now?: Date;
}

export interface OperatorInventoryOptions {
  orchestrator: OperatorToolkitOrchestrator;
  now?: Date;
}

export interface BenchmarkRecallOptions {
  config: Pick<
    PluginConfig,
    | "memoryDir"
    | "evalStoreDir"
    | "evalHarnessEnabled"
    | "evalShadowModeEnabled"
    | "benchmarkBaselineSnapshotsEnabled"
    | "benchmarkDeltaReporterEnabled"
    | "memoryRedTeamBenchEnabled"
  >;
  validatePath?: string;
  baseEvalStoreDir?: string;
  candidateEvalStoreDir?: string;
  snapshotId?: string;
  createSnapshot?: boolean;
  snapshotNotes?: string;
  gitRef?: string;
  createdAt?: string;
  now?: Date;
}

export interface OperatorRepairOptions {
  config: Pick<
    PluginConfig,
    "memoryDir" | "entityGraphEnabled" | "timeGraphEnabled" | "causalGraphEnabled"
  >;
  apply?: boolean;
  dryRun?: boolean;
  allowSessionFileRepair?: boolean;
  sessionFilesDir?: string;
  now?: Date;
}

function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) return explicitPath.trim();
  const configured =
    process.env.OPENCLAW_ENGRAM_CONFIG_PATH ||
    process.env.OPENCLAW_CONFIG_PATH;
  if (configured && configured.trim().length > 0) return configured.trim();
  return path.join(process.env.HOME ?? os.homedir(), ".openclaw", "openclaw.json");
}

async function loadCliPluginConfig(configPath?: string): Promise<OperatorConfigLoadResult> {
  const resolvedPath = resolveConfigPath(configPath);
  try {
    const raw = JSON.parse(await readFile(resolvedPath, "utf-8")) as Record<string, unknown>;
    const pluginEntry = raw?.plugins && typeof raw.plugins === "object"
      ? (raw.plugins as Record<string, unknown>).entries
      : undefined;
    const config =
      pluginEntry && typeof pluginEntry === "object"
        ? (pluginEntry as Record<string, unknown>)["openclaw-engram"]
        : undefined;
    const parsedConfig = parseConfig(
      config && typeof config === "object"
        ? ((config as Record<string, unknown>).config ?? {})
        : {},
    );
    return {
      found: true,
      path: resolvedPath,
      parsed: true,
      memoryDir: parsedConfig.memoryDir,
      workspaceDir: parsedConfig.workspaceDir,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      found: !/ENOENT/i.test(message),
      path: resolvedPath,
      parsed: false,
      error: message,
    };
  }
}

async function isWritable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function gatherDirectoryStatus(
  paths: string[],
): Promise<Array<{ path: string; exists: boolean; writable: boolean }>> {
  return Promise.all(paths.map(async (targetPath) => {
    try {
      await access(targetPath, fsConstants.F_OK);
      return {
        path: targetPath,
        exists: true,
        writable: await isWritable(targetPath),
      };
    } catch {
      return {
        path: targetPath,
        exists: false,
        writable: false,
      };
    }
  }));
}

function getSetupPaths(config: PluginConfig): string[] {
  return [
    config.memoryDir,
    config.workspaceDir,
    path.join(config.memoryDir, "facts"),
    path.join(config.memoryDir, "entities"),
    path.join(config.memoryDir, "state"),
    path.join(config.memoryDir, "questions"),
    path.join(config.memoryDir, "artifacts"),
    path.join(config.memoryDir, "config"),
  ];
}

function buildCaptureInstructions(): string {
  return [
    "# Memory",
    "",
    "Use this file for explicit memory capture notes when Engram runs in explicit or hybrid mode.",
    "",
    "## Suggested format",
    "",
    "- Write durable facts, decisions, commitments, or corrections.",
    "- Keep entries concise and specific.",
    "- Avoid secrets, tokens, and private credentials.",
    "",
    "## Example",
    "",
    "- Decision: recall benchmark packs live under `state/evals/benchmarks/`.",
    "- Commitment: rerun `openclaw engram doctor --json` after changing retrieval settings.",
    "",
  ].join("\n");
}

export async function runOperatorSetup(options: OperatorSetupOptions): Promise<OperatorSetupReport> {
  const now = options.now ?? new Date();
  const configStatus = await loadCliPluginConfig(options.configPath);
  const storage = new StorageManager(options.orchestrator.config.memoryDir);
  await storage.ensureDirectories();
  await mkdir(options.orchestrator.config.workspaceDir, { recursive: true });

  const qmdAvailable = await options.orchestrator.qmd.probe();
  const collectionState = options.orchestrator.config.qmdEnabled
    ? await options.orchestrator.qmd.ensureCollection(options.orchestrator.config.memoryDir)
    : "skipped";

  const memoryDocPath = path.join(options.orchestrator.config.workspaceDir, "MEMORY.md");
  let memoryDocExists = false;
  try {
    await access(memoryDocPath, fsConstants.F_OK);
    memoryDocExists = true;
  } catch {
    memoryDocExists = false;
  }
  let memoryDocInstalled = false;
  const explicitCaptureEnabled = options.orchestrator.config.captureMode === "explicit"
    || options.orchestrator.config.captureMode === "hybrid";
  if (options.installCaptureInstructions && explicitCaptureEnabled && !memoryDocExists) {
    await writeFile(memoryDocPath, buildCaptureInstructions(), "utf-8");
    memoryDocExists = true;
    memoryDocInstalled = true;
  }

  const directories = await gatherDirectoryStatus(getSetupPaths(options.orchestrator.config));
  const nextSteps = [
    `Run \`openclaw engram doctor${options.installCaptureInstructions ? "" : " --json"}\` to verify runtime health.`,
    "Run `openclaw engram inventory --json` to capture a baseline footprint.",
    "If QMD is enabled and the collection is missing, add the collection to `~/.config/qmd/index.yml` and run `qmd update && qmd embed`.",
  ];
  if (explicitCaptureEnabled && !memoryDocExists) {
    nextSteps.push("Re-run `openclaw engram setup --install-capture-instructions` to scaffold `MEMORY.md` for explicit capture.");
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    config: configStatus,
    memoryDir: options.orchestrator.config.memoryDir,
    workspaceDir: options.orchestrator.config.workspaceDir,
    directories,
    qmd: {
      enabled: options.orchestrator.config.qmdEnabled,
      available: qmdAvailable,
      collectionState,
      debugStatus: options.orchestrator.qmd.debugStatus(),
    },
    nativeKnowledge: {
      enabled: options.orchestrator.config.nativeKnowledge?.enabled === true,
      includeFiles: options.orchestrator.config.nativeKnowledge?.includeFiles ?? [],
      openclawWorkspaceAdapterEnabled:
        options.orchestrator.config.nativeKnowledge?.openclawWorkspace?.enabled === true,
      obsidianVaultAdapterEnabled:
        (options.orchestrator.config.nativeKnowledge?.obsidianVaults?.length ?? 0) > 0,
    },
    explicitCapture: {
      captureMode: options.orchestrator.config.captureMode,
      enabled: explicitCaptureEnabled,
      memoryDocPath,
      memoryDocExists,
      memoryDocInstalled,
    },
    nextSteps,
    verificationCommands: [
      "openclaw engram doctor --json",
      "openclaw engram inventory --json",
      "openclaw engram benchmark recall --json",
    ],
  };
}

function summarizeHygieneWarnings(
  warnings: Awaited<ReturnType<typeof lintWorkspaceFiles>>,
  hygiene: FileHygieneConfig | undefined,
): OperatorDoctorCheck {
  if (!hygiene?.enabled || hygiene.lintEnabled !== true) {
    return {
      key: "file_hygiene",
      status: "warn",
      summary: "File hygiene linting is disabled; bootstrap file truncation warnings are not active.",
      remediation: "Enable `fileHygiene.enabled` and `fileHygiene.lintEnabled` if large workspace bootstrap files are common.",
      details: {
        enabled: hygiene?.enabled === true,
        lintEnabled: hygiene?.lintEnabled === true,
      },
    };
  }
  if (warnings.length > 0) {
    return {
      key: "file_hygiene",
      status: "warn",
      summary: `${warnings.length} bootstrap file(s) are near or above the configured budget.`,
      remediation: "Archive/split the listed files or adjust `fileHygiene` budgets.",
      details: { warnings },
    };
  }
  return {
    key: "file_hygiene",
    status: "ok",
    summary: "Bootstrap file hygiene is within budget.",
    details: {
      enabled: true,
      lintPaths: hygiene.lintPaths,
      budgetBytes: hygiene.lintBudgetBytes,
    },
  };
}

export async function runOperatorDoctor(options: OperatorDoctorOptions): Promise<OperatorDoctorReport> {
  const now = options.now ?? new Date();
  const configStatus = await loadCliPluginConfig(options.configPath);
  const checks: OperatorDoctorCheck[] = [];
  const config = options.orchestrator.config;
  const setupPaths = await gatherDirectoryStatus(getSetupPaths(config));
  const missingPaths = setupPaths.filter((entry) => !entry.exists).map((entry) => entry.path);

  checks.push({
    key: "config",
    status: configStatus.parsed
      ? "ok"
      : options.configPath
      ? "error"
      : "warn",
    summary: configStatus.parsed ? "OpenClaw config loaded and Engram config parsed successfully." : "Config file could not be parsed.",
    remediation: configStatus.parsed ? undefined : "Fix the config file or set OPENCLAW_ENGRAM_CONFIG_PATH/OPENCLAW_CONFIG_PATH.",
    details: configStatus,
  });

  checks.push({
    key: "memory_dir",
    status: missingPaths.length === 0 ? "ok" : "warn",
    summary: missingPaths.length === 0
      ? "Expected Engram directories exist."
      : `${missingPaths.length} expected directory path(s) are missing.`,
    remediation: missingPaths.length === 0 ? undefined : "Run `openclaw engram setup` to create missing directories.",
    details: { directories: setupPaths },
  });

  const qmdAvailable = await options.orchestrator.qmd.probe();
  const collectionState = config.qmdEnabled
    ? await options.orchestrator.qmd.ensureCollection(config.memoryDir)
    : "skipped";
  checks.push({
    key: "qmd",
    status: !config.qmdEnabled
      ? "warn"
      : !qmdAvailable
      ? "error"
      : collectionState === "present"
      ? "ok"
      : collectionState === "missing"
      ? "error"
      : "warn",
    summary: !config.qmdEnabled
      ? "QMD is disabled in config."
      : qmdAvailable
      ? `QMD is reachable (${collectionState}).`
      : "QMD is not currently reachable.",
    remediation: !config.qmdEnabled
      ? "Enable `qmdEnabled` if you expect hybrid search."
      : !qmdAvailable
      ? "Ensure the `qmd` binary is installed and on PATH, or set `qmdPath`."
      : collectionState === "missing"
      ? "Add the configured collection to `~/.config/qmd/index.yml`."
      : collectionState === "present"
      ? undefined
      : "Re-run `openclaw engram setup` after restoring QMD access.",
    details: {
      available: qmdAvailable,
      collectionState,
      debugStatus: options.orchestrator.qmd.debugStatus(),
    },
  });

  const conversationIndex = await options.orchestrator.getConversationIndexHealth();
  checks.push({
    key: "conversation_index",
    status: conversationIndex.status === "ok"
      ? "ok"
      : conversationIndex.enabled
      ? "error"
      : "warn",
    summary: conversationIndex.enabled
      ? `Conversation index backend is ${conversationIndex.status}.`
      : "Conversation index is disabled.",
    remediation: conversationIndex.enabled && conversationIndex.status !== "ok"
      ? "Run `openclaw engram rebuild-index` to refresh the conversation index artifacts."
      : undefined,
    details: conversationIndex,
  });

  const meta = await new StorageManager(config.memoryDir).loadMeta();
  checks.push({
    key: "maintenance",
    status: meta.lastExtractionAt || meta.lastConsolidationAt ? "ok" : "warn",
    summary: meta.lastExtractionAt || meta.lastConsolidationAt
      ? "Extraction/consolidation metadata is present."
      : "No extraction or consolidation metadata found yet.",
    remediation: meta.lastExtractionAt || meta.lastConsolidationAt
      ? undefined
      : "Run a normal agent turn or `openclaw engram consolidate` after seeding memory.",
    details: meta,
  });

  const agentAccessEnabled = config.agentAccessHttp?.enabled === true;
  checks.push({
    key: "access_http_auth",
    status: !agentAccessEnabled
      ? "warn"
      : config.agentAccessHttp?.authToken
      ? "ok"
      : "error",
    summary: !agentAccessEnabled
      ? "Agent access HTTP bridge is disabled."
      : config.agentAccessHttp?.authToken
      ? "Agent access HTTP bridge has an auth token configured."
      : "Agent access HTTP bridge is enabled without an auth token.",
    remediation: !agentAccessEnabled
      ? "Ignore unless you plan to enable the HTTP bridge."
      : config.agentAccessHttp?.authToken
      ? undefined
      : "Set `agentAccessHttp.authToken` before exposing the bridge.",
  });

  const warnings = config.fileHygiene?.lintEnabled
    ? await lintWorkspaceFiles({
        workspaceDir: config.workspaceDir,
        paths: config.fileHygiene.lintPaths,
        budgetBytes: config.fileHygiene.lintBudgetBytes,
        warnRatio: config.fileHygiene.lintWarnRatio,
      })
    : [];
  checks.push(summarizeHygieneWarnings(warnings, config.fileHygiene));

  const summary = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { ok: 0, warn: 0, error: 0 },
  );

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    ok: summary.error === 0,
    summary,
    config: configStatus,
    checks,
  };
}

function getMemoryAgeBand(memory: MemoryFile, now: Date): string {
  const created = Date.parse(memory.frontmatter.created ?? "");
  if (!Number.isFinite(created)) return "unknown";
  const ageDays = Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
  if (ageDays < 7) return "0_6d";
  if (ageDays < 30) return "7_29d";
  if (ageDays < 90) return "30_89d";
  return "90d_plus";
}

async function dirSize(targetPath: string): Promise<number> {
  try {
    const info = await stat(targetPath);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
  } catch {
    return 0;
  }

  let total = 0;
  let entries;
  try {
    entries = await readdir(targetPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    total += await dirSize(path.join(targetPath, entry.name));
  }
  return total;
}

async function summarizeStorageFootprint(memoryDir: string): Promise<{ bytes: number; byTopLevel: Record<string, number> }> {
  const topLevel = [
    "facts",
    "entities",
    "questions",
    "corrections",
    "artifacts",
    "state",
    "identity",
    "namespaces",
    "summaries",
    "profile.md",
  ];
  const byTopLevel: Record<string, number> = {};
  let bytes = 0;
  for (const name of topLevel) {
    const size = await dirSize(path.join(memoryDir, name));
    if (size > 0) {
      byTopLevel[name] = size;
      bytes += size;
    }
  }
  return { bytes, byTopLevel };
}

export async function runOperatorInventory(options: OperatorInventoryOptions): Promise<OperatorInventoryReport> {
  const now = options.now ?? new Date();
  const config = options.orchestrator.config;
  const namespaceEntries = await listNamespaces({ config });
  const uniqueRootEntries = new Map<string, { namespace: string; rootDir: string }>();
  for (const entry of namespaceEntries) {
    if (!uniqueRootEntries.has(entry.rootDir)) {
      uniqueRootEntries.set(entry.rootDir, { namespace: entry.namespace, rootDir: entry.rootDir });
    }
  }
  const categories: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const ageBands: Record<string, number> = {
    "0_6d": 0,
    "7_29d": 0,
    "30_89d": 0,
    "90d_plus": 0,
    unknown: 0,
  };
  const namespaces: OperatorInventoryNamespaceSummary[] = [];
  let totalMemories = 0;
  let totalEntities = 0;
  let archived = 0;
  let pendingReview = 0;
  let quarantined = 0;
  let rejected = 0;

  for (const entry of uniqueRootEntries.values()) {
    const storage = new StorageManager(entry.rootDir);
    const memories = await storage.readAllMemories();
    const entities = await storage.readAllEntityFiles();
    namespaces.push({
      namespace: entry.namespace,
      memoryCount: memories.length,
      entityCount: entities.length,
    });
    totalMemories += memories.length;
    totalEntities += entities.length;
    for (const memory of memories) {
      const category = memory.frontmatter.category;
      categories[category] = (categories[category] ?? 0) + 1;
      const status = memory.frontmatter.status ?? "active";
      statuses[status] = (statuses[status] ?? 0) + 1;
      ageBands[getMemoryAgeBand(memory, now)] += 1;
      if (status === "archived") archived += 1;
      if (status === "pending_review") pendingReview += 1;
      if (status === "quarantined") quarantined += 1;
      if (status === "rejected") rejected += 1;
    }
  }

  const defaultStorage = new StorageManager(config.memoryDir);
  const profile = await defaultStorage.readProfile();
  const footprint = await summarizeStorageFootprint(config.memoryDir);
  const reviewRunId = (await listMemoryGovernanceRuns(config.memoryDir))[0];
  let reviewQueue = 0;
  if (reviewRunId) {
    try {
      reviewQueue = (await readMemoryGovernanceRunArtifact(config.memoryDir, reviewRunId)).reviewQueue.length;
    } catch {
      reviewQueue = 0;
    }
  }
  const conversationIndex = await options.orchestrator.getConversationIndexHealth();

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    memoryDir: config.memoryDir,
    totals: {
      memories: totalMemories,
      entities: totalEntities,
      namespaces: namespaceEntries.length,
      reviewQueue,
      storageBytes: footprint.bytes,
    },
    categories,
    statuses,
    namespaces,
    ageBands,
    profile: {
      exists: profile.length > 0,
      chars: profile.length,
      lines: profile.length > 0 ? profile.split("\n").length : 0,
    },
    storageFootprint: footprint,
    archivePressure: {
      archived,
      pendingReview,
      quarantined,
      rejected,
    },
    conversationIndex: {
      enabled: conversationIndex.enabled,
      backend: conversationIndex.backend,
      status: conversationIndex.status,
      chunkDocCount: conversationIndex.chunkDocCount,
      lastUpdateAt: conversationIndex.lastUpdateAt,
    },
  };
}

export async function runBenchmarkRecall(options: BenchmarkRecallOptions): Promise<BenchmarkRecallReport> {
  const now = options.now ?? new Date();
  const status = await getEvalHarnessStatus({
    memoryDir: options.config.memoryDir,
    evalStoreDir: options.config.evalStoreDir,
    enabled: options.config.evalHarnessEnabled,
    shadowModeEnabled: options.config.evalShadowModeEnabled,
    baselineSnapshotsEnabled: options.config.benchmarkBaselineSnapshotsEnabled,
    memoryRedTeamBenchEnabled: options.config.memoryRedTeamBenchEnabled,
  });

  if (options.createSnapshot && options.snapshotId) {
    const snapshot = await createEvalBaselineSnapshot({
      memoryDir: options.config.memoryDir,
      evalStoreDir: options.config.evalStoreDir,
      baselineSnapshotsEnabled: options.config.benchmarkBaselineSnapshotsEnabled,
      snapshotId: options.snapshotId,
      notes: options.snapshotNotes,
      gitRef: options.gitRef,
      createdAt: options.createdAt,
    });
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      mode: "snapshot",
      status,
      snapshot: {
        targetPath: snapshot.targetPath,
        snapshotId: snapshot.snapshot.snapshotId,
      },
    };
  }

  if (options.baseEvalStoreDir && options.candidateEvalStoreDir) {
    const ciGate = await runEvalBenchmarkCiGate({
      baseEvalStoreDir: options.baseEvalStoreDir,
      candidateEvalStoreDir: options.candidateEvalStoreDir,
    });
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      mode: "ci-gate",
      status,
      ciGate,
    };
  }

  if (options.snapshotId) {
    const baselineReport = await runEvalBaselineDeltaReport({
      memoryDir: options.config.memoryDir,
      evalStoreDir: options.config.evalStoreDir,
      benchmarkDeltaReporterEnabled: options.config.benchmarkDeltaReporterEnabled,
      snapshotId: options.snapshotId,
    });
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      mode: "baseline-report",
      status,
      baselineReport,
    };
  }

  if (options.validatePath) {
    const validate = await validateEvalBenchmarkPack(options.validatePath, {
      memoryRedTeamBenchEnabled: options.config.memoryRedTeamBenchEnabled,
    });
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      mode: "validate",
      status,
      validate,
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    mode: "status",
    status,
  };
}

export async function runOperatorRepair(options: OperatorRepairOptions): Promise<OperatorRepairReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true || options.apply !== true;
  const sessionCheck = await analyzeSessionIntegrity({ memoryDir: options.config.memoryDir });
  const sessionRepairPlan = planSessionRepair({
    report: sessionCheck,
    dryRun,
    allowSessionFileRepair: options.allowSessionFileRepair,
    sessionFilesDir: options.sessionFilesDir,
  });
  const sessionRepairApply = await applySessionRepair({
    plan: sessionRepairPlan,
  });
  const graphHealth = await analyzeGraphHealth(options.config.memoryDir, {
    entityGraphEnabled: options.config.entityGraphEnabled,
    timeGraphEnabled: options.config.timeGraphEnabled,
    causalGraphEnabled: options.config.causalGraphEnabled,
    includeRepairGuidance: true,
  });
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    dryRun,
    sessionCheck,
    sessionRepairPlan,
    sessionRepairApply,
    graphHealth,
  };
}
