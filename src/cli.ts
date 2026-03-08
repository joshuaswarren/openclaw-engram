import path from "node:path";
import { access, readFile, readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Orchestrator } from "./orchestrator.js";
import { ThreadingManager } from "./threading.js";
import type {
  BehaviorSignalEvent,
  ContinuityIncidentRecord,
  MemoryActionEvent,
  MemoryFile,
  TranscriptEntry,
} from "./types.js";
import { chunkContent } from "./chunking.js";
import { rescoreMemoryImportance } from "./importance.js";
import { exportJsonBundle } from "./transfer/export-json.js";
import { exportMarkdownBundle } from "./transfer/export-md.js";
import { backupMemoryDir } from "./transfer/backup.js";
import { exportSqlite } from "./transfer/export-sqlite.js";
import { importJsonBundle } from "./transfer/import-json.js";
import { importSqlite } from "./transfer/import-sqlite.js";
import { importMarkdownBundle } from "./transfer/import-md.js";
import { detectImportFormat } from "./transfer/autodetect.js";
import { buildReplayNormalizerRegistry, clampBatchSize, runReplay, type ReplayRunSummary } from "./replay/runner.js";
import { chatgptReplayNormalizer } from "./replay/normalizers/chatgpt.js";
import { claudeReplayNormalizer } from "./replay/normalizers/claude.js";
import { openclawReplayNormalizer } from "./replay/normalizers/openclaw.js";
import { isReplaySource, normalizeReplaySessionKey, type ReplaySource, type ReplayTurn } from "./replay/types.js";
import { archiveObservations } from "./maintenance/archive-observations.js";
import { rebuildObservations } from "./maintenance/rebuild-observations.js";
import { migrateObservations } from "./maintenance/migrate-observations.js";
import { WorkStorage } from "./work/storage.js";
import type { WorkProjectStatus, WorkTaskPriority, WorkTaskStatus } from "./work/types.js";
import {
  selectRouteRule,
  validateRouteTarget,
  type RoutePatternType,
  type RouteRule,
  type RouteTarget,
} from "./routing/engine.js";
import { RoutingRulesStore } from "./routing/store.js";
import { TailscaleHelper, type TailscaleSyncOptions } from "./network/tailscale.js";
import { WebDavServer } from "./network/webdav.js";
import { GraphDashboardServer, type DashboardStatus } from "./dashboard-runtime.js";
import { runCompatChecks } from "./compat/checks.js";
import type { CompatReport, CompatRunner } from "./compat/types.js";
import {
  getEvalHarnessStatus,
  importEvalBenchmarkPack,
  type EvalBenchmarkPackSummary,
  type EvalCiGateReport,
  type EvalHarnessStatus,
  runEvalBenchmarkCiGate,
  validateEvalBenchmarkPack,
} from "./evals.js";
import { analyzeGraphHealth, type GraphHealthReport } from "./graph.js";
import {
  getCausalTrajectoryStoreStatus,
  type CausalTrajectoryStoreStatus,
} from "./causal-trajectory.js";
import {
  getAbstractionNodeStoreStatus,
  type AbstractionNodeStoreStatus,
} from "./abstraction-nodes.js";
import {
  getCueAnchorStoreStatus,
  type CueAnchorStoreStatus,
} from "./cue-anchors.js";
import {
  searchHarmonicRetrieval,
  type HarmonicRetrievalResult,
} from "./harmonic-retrieval.js";
import {
  searchVerifiedEpisodes,
  type VerifiedEpisodeResult,
} from "./verified-recall.js";
import {
  searchVerifiedSemanticRules,
  type VerifiedSemanticRuleResult,
} from "./semantic-rule-verifier.js";
import {
  applyCommitmentLedgerLifecycle,
  getCommitmentLedgerStatus,
  recordCommitmentLedgerEntry,
  transitionCommitmentLedgerEntryState,
  type CommitmentLedgerEntry,
  type CommitmentLedgerLifecycleResult,
  type CommitmentLedgerStatus,
} from "./commitment-ledger.js";
import {
  getWorkProductLedgerStatus,
  recordWorkProductLedgerEntry,
  searchWorkProductLedgerEntries,
  type WorkProductLedgerEntry,
  type WorkProductLedgerSearchResult,
  type WorkProductLedgerStatus,
} from "./work-product-ledger.js";
import {
  promoteSemanticRuleFromMemory,
  type SemanticRulePromotionReport,
} from "./semantic-rule-promotion.js";
import { getObjectiveStateStoreStatus, type ObjectiveStateStoreStatus } from "./objective-state.js";
import {
  getTrustZoneStoreStatus,
  promoteTrustZoneRecord,
  type TrustZoneName,
  type TrustZonePromotionResult,
  type TrustZoneStoreStatus,
} from "./trust-zones.js";
import {
  analyzeSessionIntegrity,
  applySessionRepair,
  planSessionRepair,
  type SessionIntegrityReport,
  type SessionRepairApplyResult,
  type SessionRepairPlan,
} from "./session-integrity.js";
import type { TierMigrationCycleSummary, TierMigrationStatusSnapshot } from "./recall-state.js";
import {
  readRuntimePolicySnapshot as readPolicyRuntimeSnapshot,
  sanitizeRuntimePolicyValues,
  type RuntimePolicyValues,
} from "./policy-runtime.js";

interface CliApi {
  registerCli(
    handler: (opts: { program: CliProgram }) => void,
    options: { commands: string[] },
  ): void;
}

interface CliProgram {
  command(name: string): CliCommand;
}

interface CliCommand {
  description(desc: string): CliCommand;
  option(flags: string, desc: string, defaultValue?: string): CliCommand;
  requiredOption(flags: string, desc: string, defaultValue?: string): CliCommand;
  argument(name: string, desc: string): CliCommand;
  action(fn: (...args: unknown[]) => Promise<void> | void): CliCommand;
  command(name: string): CliCommand;
}

export interface DedupeCandidate {
  path: string;
  content: string;
  frontmatter: {
    id?: string;
    confidence?: number;
    updated?: string;
    created?: string;
  };
}

export interface ExactDedupePlan {
  groups: number;
  duplicates: number;
  keepPaths: string[];
  deletePaths: string[];
}

function rankCandidateForKeep(a: DedupeCandidate, b: DedupeCandidate): number {
  const aConfidence = typeof a.frontmatter.confidence === "number" ? a.frontmatter.confidence : 0;
  const bConfidence = typeof b.frontmatter.confidence === "number" ? b.frontmatter.confidence : 0;
  if (aConfidence !== bConfidence) return bConfidence - aConfidence;

  const aTs = Date.parse(a.frontmatter.updated ?? a.frontmatter.created ?? "");
  const bTs = Date.parse(b.frontmatter.updated ?? b.frontmatter.created ?? "");
  const aTime = Number.isNaN(aTs) ? 0 : aTs;
  const bTime = Number.isNaN(bTs) ? 0 : bTs;
  if (aTime !== bTime) return bTime - aTime;

  return a.path.localeCompare(b.path);
}

function buildDedupePlan(
  memories: DedupeCandidate[],
  keyBuilder: (memory: DedupeCandidate) => string,
): ExactDedupePlan {
  const byKey = new Map<string, DedupeCandidate[]>();
  for (const memory of memories) {
    const key = keyBuilder(memory);
    if (key.length === 0) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.push(memory);
    } else {
      byKey.set(key, [memory]);
    }
  }

  const keepPaths: string[] = [];
  const deletePaths: string[] = [];
  let groups = 0;
  let duplicates = 0;

  for (const entries of byKey.values()) {
    if (entries.length <= 1) continue;
    groups += 1;
    duplicates += entries.length - 1;
    const ranked = [...entries].sort(rankCandidateForKeep);
    keepPaths.push(ranked[0].path);
    for (let i = 1; i < ranked.length; i += 1) {
      deletePaths.push(ranked[i].path);
    }
  }

  return { groups, duplicates, keepPaths, deletePaths };
}

function normalizeAggressiveBody(content: string): string {
  return content
    .normalize("NFKC")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~>#-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function planExactDuplicateDeletions(memories: DedupeCandidate[]): ExactDedupePlan {
  return buildDedupePlan(memories, (memory) => memory.content.trim());
}

export function planAggressiveDuplicateDeletions(memories: DedupeCandidate[]): ExactDedupePlan {
  return buildDedupePlan(memories, (memory) => normalizeAggressiveBody(memory.content));
}

export interface ReplayCliCommandOptions {
  source: ReplaySource;
  inputPath: string;
  from?: string;
  to?: string;
  dryRun?: boolean;
  startOffset?: number;
  maxTurns?: number;
  batchSize?: number;
  defaultSessionKey?: string;
  strict?: boolean;
  runConsolidation?: boolean;
  extractionIdleTimeoutMs?: number;
}

export interface ReplayCliOrchestrator {
  ingestReplayBatch(
    turns: ReplayTurn[],
    options?: { deadlineMs?: number },
  ): Promise<void>;
  waitForConsolidationIdle(timeoutMs?: number): Promise<boolean>;
  runConsolidationNow(): Promise<{ memoriesProcessed: number; merged: number; invalidated: number }>;
}

export interface ArchiveObservationsCliCommandOptions {
  memoryDir: string;
  retentionDays?: number;
  write?: boolean;
  now?: Date;
}

export interface RebuildObservationsCliCommandOptions {
  memoryDir: string;
  write?: boolean;
  now?: Date;
}

export interface MigrateObservationsCliCommandOptions {
  memoryDir: string;
  write?: boolean;
  now?: Date;
}

interface WorkTaskPatchInput {
  title?: string;
  description?: string;
  status?: WorkTaskStatus;
  priority?: WorkTaskPriority;
  owner?: string | null;
  assignee?: string | null;
  projectId?: string | null;
  tags?: string[];
  dueAt?: string | null;
}

interface WorkProjectPatchInput {
  name?: string;
  description?: string;
  status?: WorkProjectStatus;
  owner?: string | null;
  tags?: string[];
}

export interface WorkTaskCliCommandOptions {
  memoryDir: string;
  action: "create" | "get" | "list" | "update" | "transition" | "delete" | "link";
  id?: string;
  title?: string;
  description?: string;
  status?: WorkTaskStatus;
  priority?: WorkTaskPriority;
  owner?: string;
  assignee?: string;
  projectId?: string;
  tags?: string[];
  dueAt?: string;
  patch?: WorkTaskPatchInput;
}

export interface WorkProjectCliCommandOptions {
  memoryDir: string;
  action: "create" | "get" | "list" | "update" | "delete";
  id?: string;
  name?: string;
  description?: string;
  status?: WorkProjectStatus;
  owner?: string;
  tags?: string[];
  patch?: WorkProjectPatchInput;
}

export interface RouteCliCommandOptions {
  memoryDir: string;
  stateFile?: string;
  action: "list" | "add" | "remove" | "test";
  pattern?: string;
  patternType?: RoutePatternType;
  priority?: number;
  targetRaw?: string;
  text?: string;
  id?: string;
}

interface TailscaleHelperLike {
  status(): Promise<{
    available: boolean;
    running: boolean;
    backendState?: string;
    version?: string;
    selfHostname?: string;
    selfIp?: string;
  }>;
  syncDirectory(options: TailscaleSyncOptions): Promise<void>;
}

export interface ConversationIndexHealthCliOrchestrator {
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
    };
  }>;
}

export interface GraphHealthCliCommandOptions {
  memoryDir: string;
  entityGraphEnabled?: boolean;
  timeGraphEnabled?: boolean;
  causalGraphEnabled?: boolean;
  includeRepairGuidance?: boolean;
}

export interface SessionIntegrityCliCommandOptions {
  memoryDir: string;
}

export interface SessionRepairCliCommandOptions {
  memoryDir: string;
  apply?: boolean;
  dryRun?: boolean;
  allowSessionFileRepair?: boolean;
  sessionFilesDir?: string;
}

export interface TierMigrationCliOrchestrator {
  getTierMigrationStatus(): Promise<TierMigrationStatusSnapshot>;
  runTierMigrationNow(options?: { dryRun?: boolean; limit?: number }): Promise<TierMigrationCycleSummary>;
}

export interface MemoryActionAuditCliCommandOptions {
  namespace?: string;
  limit?: number;
}

export interface MemoryActionAuditCliNamespaceSummary {
  namespace: string;
  eventCount: number;
  actions: Record<string, number>;
  outcomes: Record<string, number>;
  policyDecisions: Record<string, number>;
}

export interface MemoryActionAuditCliReport {
  generatedAt: string;
  limit: number;
  namespaces: MemoryActionAuditCliNamespaceSummary[];
  totals: {
    eventCount: number;
    actions: Record<string, number>;
    outcomes: Record<string, number>;
    policyDecisions: Record<string, number>;
  };
}

interface MemoryActionAuditCliOrchestrator {
  config: {
    defaultNamespace: string;
    sharedNamespace: string;
    namespacesEnabled: boolean;
    namespacePolicies: Array<{ name: string }>;
  };
  getStorage(namespace?: string): Promise<{
    readMemoryActionEvents(limit?: number): Promise<MemoryActionEvent[]>;
  }>;
}

export interface TailscaleStatusCliCommandOptions {
  helper?: TailscaleHelperLike;
  timeoutMs?: number;
}

export interface TailscaleSyncCliCommandOptions extends TailscaleSyncOptions {
  helper?: TailscaleHelperLike;
}

interface WebDavServerLike {
  start(): Promise<{ running: boolean; host: string; port: number; rootCount: number }>;
  stop(): Promise<void>;
  status(): { running: boolean; host: string; port: number; rootCount: number };
}

export interface WebDavServeCliCommandOptions {
  enabled?: boolean;
  host?: string;
  port?: number;
  allowlistDirs: string[];
  authUsername?: string;
  authPassword?: string;
  createServer?: (options: {
    enabled?: boolean;
    host?: string;
    port: number;
    allowlistDirs: string[];
    auth?: {
      username: string;
      password: string;
    };
  }) => Promise<WebDavServerLike>;
}

export interface CompatCliCommandOptions {
  repoRoot?: string;
  strict?: boolean;
  runner?: CompatRunner;
  now?: Date;
}

interface DashboardServerLike {
  start(): Promise<DashboardStatus>;
  stop(): Promise<void>;
  status(): DashboardStatus;
}

export interface DashboardStartCliCommandOptions {
  memoryDir: string;
  host?: string;
  port?: number;
  publicDir?: string;
  createServer?: (options: {
    memoryDir: string;
    host?: string;
    port?: number;
    publicDir?: string;
  }) => DashboardServerLike;
}

let activeWebDavServer: WebDavServerLike | null = null;
let webDavOperationChain: Promise<void> = Promise.resolve();
let activeDashboardServer: DashboardServerLike | null = null;
let dashboardOperationChain: Promise<void> = Promise.resolve();

async function withWebDavLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = webDavOperationChain.then(operation, operation);
  webDavOperationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withDashboardLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = dashboardOperationChain.then(operation, operation);
  dashboardOperationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isRoutePatternType(value: string | undefined): value is RoutePatternType {
  return value === "keyword" || value === "regex";
}

function parseRouteTargetCliArg(raw: string): RouteTarget {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("missing target");

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as RouteTarget;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid target JSON");
    return parsed;
  }

  const target: RouteTarget = {};
  for (const token of trimmed.split(",")) {
    const part = token.trim();
    if (part.length === 0) continue;
    const normalized = part.replace(":", "=");
    const [rawKey, ...rawValueParts] = normalized.split("=");
    if (!rawKey || rawValueParts.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rawValueParts.join("=").trim();
    if (value.length === 0) continue;
    if (key === "category") {
      target.category = value as RouteTarget["category"];
      continue;
    }
    if (key === "namespace") {
      target.namespace = value;
    }
  }

  return target;
}

function normalizeNullableCliValue(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

function parseTagsCsv(raw: string | undefined, preserveEmpty = false): string[] | undefined {
  if (raw === undefined) return undefined;
  const tags = raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (tags.length === 0) {
    return preserveEmpty ? [] : undefined;
  }
  return tags;
}

function isWorkTaskStatus(value: string | undefined): value is "todo" | "in_progress" | "blocked" | "done" | "cancelled" {
  return value === "todo" || value === "in_progress" || value === "blocked" || value === "done" || value === "cancelled";
}

function isWorkTaskPriority(value: string | undefined): value is "low" | "medium" | "high" {
  return value === "low" || value === "medium" || value === "high";
}

function isWorkProjectStatus(value: string | undefined): value is "active" | "on_hold" | "completed" | "archived" {
  return value === "active" || value === "on_hold" || value === "completed" || value === "archived";
}

export async function runArchiveObservationsCliCommand(
  options: ArchiveObservationsCliCommandOptions,
) {
  return archiveObservations({
    memoryDir: options.memoryDir,
    retentionDays: options.retentionDays,
    dryRun: options.write !== true,
    now: options.now,
  });
}

export async function runRebuildObservationsCliCommand(
  options: RebuildObservationsCliCommandOptions,
) {
  return rebuildObservations({
    memoryDir: options.memoryDir,
    dryRun: options.write !== true,
    now: options.now,
  });
}

export async function runMigrateObservationsCliCommand(
  options: MigrateObservationsCliCommandOptions,
) {
  return migrateObservations({
    memoryDir: options.memoryDir,
    dryRun: options.write !== true,
    now: options.now,
  });
}

export async function runConversationIndexHealthCliCommand(
  orchestrator: ConversationIndexHealthCliOrchestrator,
): Promise<{
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
  };
}> {
  return orchestrator.getConversationIndexHealth();
}

export async function runGraphHealthCliCommand(
  options: GraphHealthCliCommandOptions,
): Promise<GraphHealthReport> {
  return analyzeGraphHealth(options.memoryDir, {
    entityGraphEnabled: options.entityGraphEnabled,
    timeGraphEnabled: options.timeGraphEnabled,
    causalGraphEnabled: options.causalGraphEnabled,
    includeRepairGuidance: options.includeRepairGuidance,
  });
}

export async function runBenchmarkStatusCliCommand(options: {
  memoryDir: string;
  evalStoreDir?: string;
  evalHarnessEnabled: boolean;
  evalShadowModeEnabled: boolean;
  memoryRedTeamBenchEnabled: boolean;
}): Promise<EvalHarnessStatus> {
  return getEvalHarnessStatus({
    memoryDir: options.memoryDir,
    evalStoreDir: options.evalStoreDir,
    enabled: options.evalHarnessEnabled,
    shadowModeEnabled: options.evalShadowModeEnabled,
    memoryRedTeamBenchEnabled: options.memoryRedTeamBenchEnabled,
  });
}

export async function runBenchmarkValidateCliCommand(options: {
  path: string;
  memoryRedTeamBenchEnabled: boolean;
}): Promise<EvalBenchmarkPackSummary> {
  return validateEvalBenchmarkPack(options.path, {
    memoryRedTeamBenchEnabled: options.memoryRedTeamBenchEnabled,
  });
}

export async function runBenchmarkImportCliCommand(options: {
  path: string;
  memoryDir: string;
  evalStoreDir?: string;
  force?: boolean;
  memoryRedTeamBenchEnabled: boolean;
}): Promise<EvalBenchmarkPackSummary & { targetDir: string; overwritten: boolean }> {
  return importEvalBenchmarkPack({
    sourcePath: options.path,
    memoryDir: options.memoryDir,
    evalStoreDir: options.evalStoreDir,
    force: options.force === true,
    memoryRedTeamBenchEnabled: options.memoryRedTeamBenchEnabled,
  });
}

export async function runBenchmarkCiGateCliCommand(options: {
  baseEvalStoreDir: string;
  candidateEvalStoreDir: string;
}): Promise<EvalCiGateReport> {
  return runEvalBenchmarkCiGate({
    baseEvalStoreDir: options.baseEvalStoreDir,
    candidateEvalStoreDir: options.candidateEvalStoreDir,
  });
}

export async function runObjectiveStateStatusCliCommand(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  objectiveStateMemoryEnabled: boolean;
  objectiveStateSnapshotWritesEnabled: boolean;
}): Promise<ObjectiveStateStoreStatus> {
  return getObjectiveStateStoreStatus({
    memoryDir: options.memoryDir,
    objectiveStateStoreDir: options.objectiveStateStoreDir,
    enabled: options.objectiveStateMemoryEnabled,
    writesEnabled: options.objectiveStateSnapshotWritesEnabled,
  });
}

export async function runCausalTrajectoryStatusCliCommand(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
  causalTrajectoryMemoryEnabled: boolean;
}): Promise<CausalTrajectoryStoreStatus> {
  return getCausalTrajectoryStoreStatus({
    memoryDir: options.memoryDir,
    causalTrajectoryStoreDir: options.causalTrajectoryStoreDir,
    enabled: options.causalTrajectoryMemoryEnabled,
  });
}

export async function runTrustZoneStatusCliCommand(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  trustZonesEnabled: boolean;
  quarantinePromotionEnabled: boolean;
  memoryPoisoningDefenseEnabled: boolean;
}): Promise<TrustZoneStoreStatus> {
  return getTrustZoneStoreStatus({
    memoryDir: options.memoryDir,
    trustZoneStoreDir: options.trustZoneStoreDir,
    enabled: options.trustZonesEnabled,
    promotionEnabled: options.quarantinePromotionEnabled,
    poisoningDefenseEnabled: options.memoryPoisoningDefenseEnabled,
  });
}

export async function runAbstractionNodeStatusCliCommand(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  harmonicRetrievalEnabled: boolean;
  abstractionAnchorsEnabled: boolean;
}): Promise<AbstractionNodeStoreStatus> {
  return getAbstractionNodeStoreStatus({
    memoryDir: options.memoryDir,
    abstractionNodeStoreDir: options.abstractionNodeStoreDir,
    enabled: options.harmonicRetrievalEnabled,
    anchorsEnabled: options.abstractionAnchorsEnabled,
  });
}

export async function runCueAnchorStatusCliCommand(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  harmonicRetrievalEnabled: boolean;
  abstractionAnchorsEnabled: boolean;
}): Promise<CueAnchorStoreStatus> {
  return getCueAnchorStoreStatus({
    memoryDir: options.memoryDir,
    abstractionNodeStoreDir: options.abstractionNodeStoreDir,
    enabled: options.harmonicRetrievalEnabled,
    anchorsEnabled: options.abstractionAnchorsEnabled,
  });
}

export async function runHarmonicSearchCliCommand(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  harmonicRetrievalEnabled: boolean;
  abstractionAnchorsEnabled: boolean;
  query: string;
  maxResults?: number;
  sessionKey?: string;
}): Promise<HarmonicRetrievalResult[]> {
  if (!options.harmonicRetrievalEnabled) return [];
  return searchHarmonicRetrieval({
    memoryDir: options.memoryDir,
    abstractionNodeStoreDir: options.abstractionNodeStoreDir,
    query: options.query,
    maxResults: Math.max(1, Math.floor(options.maxResults ?? 3)),
    sessionKey: options.sessionKey,
    anchorsEnabled: options.abstractionAnchorsEnabled,
  });
}

export async function runVerifiedRecallSearchCliCommand(options: {
  memoryDir: string;
  verifiedRecallEnabled: boolean;
  query: string;
  maxResults?: number;
  boxRecallDays?: number;
}): Promise<VerifiedEpisodeResult[]> {
  if (!options.verifiedRecallEnabled) return [];
  return searchVerifiedEpisodes({
    memoryDir: options.memoryDir,
    query: options.query,
    maxResults: Math.max(1, Math.floor(options.maxResults ?? 3)),
    boxRecallDays: options.boxRecallDays,
  });
}

export async function runSemanticRulePromoteCliCommand(options: {
  memoryDir: string;
  semanticRulePromotionEnabled: boolean;
  sourceMemoryId: string;
  dryRun?: boolean;
}): Promise<SemanticRulePromotionReport> {
  return promoteSemanticRuleFromMemory({
    memoryDir: options.memoryDir,
    enabled: options.semanticRulePromotionEnabled,
    sourceMemoryId: options.sourceMemoryId,
    dryRun: options.dryRun,
  });
}

export async function runSemanticRuleVerifyCliCommand(options: {
  memoryDir: string;
  semanticRuleVerificationEnabled: boolean;
  query: string;
  maxResults?: number;
}): Promise<VerifiedSemanticRuleResult[]> {
  if (!options.semanticRuleVerificationEnabled) return [];
  return searchVerifiedSemanticRules({
    memoryDir: options.memoryDir,
    query: options.query,
    maxResults: Math.max(1, Math.floor(options.maxResults ?? 3)),
  });
}

export async function runWorkProductStatusCliCommand(options: {
  memoryDir: string;
  workProductLedgerDir?: string;
  creationMemoryEnabled: boolean;
}): Promise<WorkProductLedgerStatus> {
  return getWorkProductLedgerStatus({
    memoryDir: options.memoryDir,
    workProductLedgerDir: options.workProductLedgerDir,
    enabled: options.creationMemoryEnabled,
  });
}

export async function runWorkProductRecordCliCommand(options: {
  memoryDir: string;
  workProductLedgerDir?: string;
  creationMemoryEnabled: boolean;
  entry: WorkProductLedgerEntry;
}): Promise<string | null> {
  if (!options.creationMemoryEnabled) return null;
  return recordWorkProductLedgerEntry({
    memoryDir: options.memoryDir,
    workProductLedgerDir: options.workProductLedgerDir,
    entry: options.entry,
  });
}

export async function runWorkProductRecallSearchCliCommand(options: {
  memoryDir: string;
  workProductLedgerDir?: string;
  creationMemoryEnabled: boolean;
  workProductRecallEnabled: boolean;
  query: string;
  maxResults?: number;
  sessionKey?: string;
}): Promise<WorkProductLedgerSearchResult[]> {
  if (!options.creationMemoryEnabled || !options.workProductRecallEnabled) return [];
  return searchWorkProductLedgerEntries({
    memoryDir: options.memoryDir,
    workProductLedgerDir: options.workProductLedgerDir,
    query: options.query,
    maxResults: Math.max(1, Math.floor(options.maxResults ?? 3)),
    sessionKey: options.sessionKey,
  });
}

export async function runCommitmentStatusCliCommand(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  creationMemoryEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  commitmentLifecycleEnabled?: boolean;
  commitmentStaleDays?: number;
  commitmentDecayDays?: number;
  now?: string;
}): Promise<CommitmentLedgerStatus> {
  return getCommitmentLedgerStatus({
    memoryDir: options.memoryDir,
    commitmentLedgerDir: options.commitmentLedgerDir,
    enabled: options.creationMemoryEnabled && options.commitmentLedgerEnabled,
    lifecycleEnabled:
      options.creationMemoryEnabled &&
      options.commitmentLedgerEnabled &&
      options.commitmentLifecycleEnabled === true,
    staleDays: options.commitmentStaleDays,
    decayDays: options.commitmentDecayDays,
    now: options.now,
  });
}

export async function runCommitmentRecordCliCommand(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  creationMemoryEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  entry: CommitmentLedgerEntry;
}): Promise<string | null> {
  if (!options.creationMemoryEnabled || !options.commitmentLedgerEnabled) return null;
  return recordCommitmentLedgerEntry({
    memoryDir: options.memoryDir,
    commitmentLedgerDir: options.commitmentLedgerDir,
    entry: options.entry,
  });
}

export async function runCommitmentSetStateCliCommand(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  creationMemoryEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  commitmentLifecycleEnabled: boolean;
  entryId: string;
  nextState: CommitmentLedgerEntry["state"];
  changedAt: string;
}): Promise<CommitmentLedgerEntry | null> {
  if (
    !options.creationMemoryEnabled ||
    !options.commitmentLedgerEnabled ||
    !options.commitmentLifecycleEnabled
  ) {
    return null;
  }

  return transitionCommitmentLedgerEntryState({
    memoryDir: options.memoryDir,
    commitmentLedgerDir: options.commitmentLedgerDir,
    entryId: options.entryId,
    nextState: options.nextState,
    changedAt: options.changedAt,
  });
}

export async function runCommitmentLifecycleCliCommand(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  creationMemoryEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  commitmentLifecycleEnabled: boolean;
  commitmentDecayDays: number;
  now?: string;
}): Promise<CommitmentLedgerLifecycleResult | null> {
  if (
    !options.creationMemoryEnabled ||
    !options.commitmentLedgerEnabled ||
    !options.commitmentLifecycleEnabled
  ) {
    return null;
  }

  return applyCommitmentLedgerLifecycle({
    memoryDir: options.memoryDir,
    commitmentLedgerDir: options.commitmentLedgerDir,
    enabled: true,
    decayDays: options.commitmentDecayDays,
    now: options.now,
  });
}

export async function runTrustZonePromoteCliCommand(options: {
  memoryDir: string;
  trustZoneStoreDir?: string;
  trustZonesEnabled: boolean;
  quarantinePromotionEnabled: boolean;
  memoryPoisoningDefenseEnabled: boolean;
  sourceRecordId: string;
  targetZone: TrustZoneName;
  promotionReason: string;
  recordedAt?: string;
  summary?: string;
  dryRun?: boolean;
}): Promise<TrustZonePromotionResult & { dryRun: boolean }> {
  const result = await promoteTrustZoneRecord({
    memoryDir: options.memoryDir,
    trustZoneStoreDir: options.trustZoneStoreDir,
    enabled: options.trustZonesEnabled,
    promotionEnabled: options.quarantinePromotionEnabled,
    poisoningDefenseEnabled: options.memoryPoisoningDefenseEnabled,
    sourceRecordId: options.sourceRecordId,
    targetZone: options.targetZone,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    promotionReason: options.promotionReason,
    summary: options.summary,
    dryRun: options.dryRun === true,
  });

  return {
    ...result,
    dryRun: options.dryRun === true,
  };
}

export async function runSessionCheckCliCommand(
  options: SessionIntegrityCliCommandOptions,
): Promise<SessionIntegrityReport> {
  return analyzeSessionIntegrity({ memoryDir: options.memoryDir });
}

export async function runSessionRepairCliCommand(
  options: SessionRepairCliCommandOptions,
): Promise<{ report: SessionIntegrityReport; plan: SessionRepairPlan; applyResult: SessionRepairApplyResult }> {
  const report = await analyzeSessionIntegrity({ memoryDir: options.memoryDir });
  const dryRun = options.apply !== true || options.dryRun === true;
  const plan = planSessionRepair({
    report,
    dryRun,
    allowSessionFileRepair: options.allowSessionFileRepair === true,
    sessionFilesDir: options.sessionFilesDir,
  });
  const applyResult = await applySessionRepair({ plan });
  return { report, plan, applyResult };
}

export async function runTierStatusCliCommand(
  orchestrator: TierMigrationCliOrchestrator,
): Promise<TierMigrationStatusSnapshot> {
  return orchestrator.getTierMigrationStatus();
}

export async function runTierMigrateCliCommand(
  orchestrator: TierMigrationCliOrchestrator,
  options: { dryRun?: boolean; limit?: number } = {},
): Promise<TierMigrationCycleSummary> {
  return orchestrator.runTierMigrationNow({
    dryRun: options.dryRun === true,
    limit: options.limit,
  });
}

const MIGRATE_LIMIT_CAP = 2000;
const REEXTRACT_LIMIT_CAP = 500;

type MigrateMemoryStorage = {
  readAllMemories(): Promise<MemoryFile[]>;
  readArchivedMemories(): Promise<MemoryFile[]>;
  writeMemoryFrontmatter(memory: MemoryFile, patch: Partial<MemoryFile["frontmatter"]>): Promise<boolean>;
  getChunksForParent(parentId: string): Promise<MemoryFile[]>;
  updateMemory(id: string, newContent: string): Promise<boolean>;
  updateMemoryFrontmatter(id: string, patch: Partial<MemoryFile["frontmatter"]>): Promise<boolean>;
  writeChunk(
    parentId: string,
    chunkIndex: number,
    chunkTotal: number,
    category: MemoryFile["frontmatter"]["category"],
    content: string,
    options?: {
      confidence?: number;
      tags?: string[];
      entityRef?: string;
      source?: string;
      importance?: MemoryFile["frontmatter"]["importance"];
      intentGoal?: string;
      intentActionType?: string;
      intentEntityTypes?: string[];
      memoryKind?: MemoryFile["frontmatter"]["memoryKind"];
    },
  ): Promise<string>;
  invalidateMemory(id: string): Promise<boolean>;
  appendReextractJobs(events: Array<{
    memoryId: string;
    model: string;
    requestedAt: string;
    source: "cli-migrate";
  }>): Promise<number>;
};

export interface MigrateCliOrchestrator {
  config: {
    defaultNamespace: string;
  };
  getStorage(namespace?: string): Promise<MigrateMemoryStorage>;
}

export interface MigrateCliReport {
  action: "normalize-frontmatter" | "rescore-importance" | "rechunk" | "reextract";
  dryRun: boolean;
  scanned: number;
  changed: number;
  queued: number;
  limit: number;
  model?: string;
}

function clampMigrateLimit(limit: number | undefined, cap: number, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(cap, Math.floor(limit)));
}

async function readMigrateCandidateMemories(
  storage: MigrateMemoryStorage,
  options: { includeArchived: boolean },
): Promise<MemoryFile[]> {
  const merged = new Map<string, MemoryFile>();
  const addMany = (items: MemoryFile[]) => {
    for (const item of items) {
      if (!item.frontmatter?.id) continue;
      merged.set(item.path, item);
    }
  };
  addMany(await storage.readAllMemories());
  if (options.includeArchived) {
    addMany(await storage.readArchivedMemories());
  }
  return [...merged.values()]
    .sort((a, b) => a.path.localeCompare(b.path));
}

function sameImportance(a: MemoryFile["frontmatter"]["importance"], b: MemoryFile["frontmatter"]["importance"]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (Math.abs(a.score - b.score) > 0.000001) return false;
  if (a.level !== b.level) return false;
  if (a.reasons.join("|") !== b.reasons.join("|")) return false;
  if (a.keywords.join("|") !== b.keywords.join("|")) return false;
  return true;
}

function sameChunkContent(existing: MemoryFile[], desired: string[]): boolean {
  if (existing.length !== desired.length) return false;
  for (let i = 0; i < desired.length; i += 1) {
    const current = existing[i]?.content?.trim() ?? "";
    if (current !== desired[i]?.trim()) {
      return false;
    }
  }
  return true;
}

export async function runMigrateNormalizeFrontmatterCliCommand(
  orchestrator: MigrateCliOrchestrator,
  options: { write?: boolean; limit?: number } = {},
): Promise<MigrateCliReport> {
  const limit = clampMigrateLimit(options.limit, MIGRATE_LIMIT_CAP, 200);
  const storage = await orchestrator.getStorage(orchestrator.config.defaultNamespace);
  const candidates = (await readMigrateCandidateMemories(storage, { includeArchived: true }))
    .slice(0, limit);
  if (options.write === true) {
    for (const memory of candidates) {
      await storage.writeMemoryFrontmatter(memory, {});
    }
  }
  return {
    action: "normalize-frontmatter",
    dryRun: options.write !== true,
    scanned: candidates.length,
    changed: candidates.length,
    queued: 0,
    limit,
  };
}

export async function runMigrateRescoreImportanceCliCommand(
  orchestrator: MigrateCliOrchestrator,
  options: { write?: boolean; limit?: number } = {},
): Promise<MigrateCliReport> {
  const limit = clampMigrateLimit(options.limit, MIGRATE_LIMIT_CAP, 200);
  const storage = await orchestrator.getStorage(orchestrator.config.defaultNamespace);
  const candidates = (await readMigrateCandidateMemories(storage, { includeArchived: true }))
    .slice(0, limit);
  let changed = 0;
  for (const memory of candidates) {
    const nextImportance = rescoreMemoryImportance(memory);
    if (sameImportance(memory.frontmatter.importance, nextImportance)) continue;
    changed += 1;
    if (options.write === true) {
      await storage.writeMemoryFrontmatter(memory, {
        importance: nextImportance,
        updated: new Date().toISOString(),
      });
    }
  }

  return {
    action: "rescore-importance",
    dryRun: options.write !== true,
    scanned: candidates.length,
    changed,
    queued: 0,
    limit,
  };
}

export async function runMigrateRechunkCliCommand(
  orchestrator: MigrateCliOrchestrator,
  options: { write?: boolean; limit?: number } = {},
): Promise<MigrateCliReport> {
  const limit = clampMigrateLimit(options.limit, MIGRATE_LIMIT_CAP, 200);
  const storage = await orchestrator.getStorage(orchestrator.config.defaultNamespace);
  const candidates = (await readMigrateCandidateMemories(storage, { includeArchived: false }))
    .filter((memory) => memory.frontmatter.parentId === undefined)
    .slice(0, limit);

  let changed = 0;
  for (const memory of candidates) {
    const existing = await storage.getChunksForParent(memory.frontmatter.id);
    const chunked = chunkContent(memory.content);
    if (!chunked.chunked) {
      if (existing.length === 0) continue;
      changed += 1;
      if (options.write === true) {
        for (const stale of existing) {
          await storage.invalidateMemory(stale.frontmatter.id);
        }
      }
      continue;
    }
    const desired = chunked.chunks.map((chunk) => chunk.content);
    if (sameChunkContent(existing, desired)) continue;
    changed += 1;
    if (options.write !== true) continue;

    const total = chunked.chunks.length;
    for (const chunk of chunked.chunks) {
      const existingChunk = existing[chunk.index];
      if (existingChunk) {
        await storage.updateMemory(existingChunk.frontmatter.id, chunk.content);
        await storage.updateMemoryFrontmatter(existingChunk.frontmatter.id, {
          chunkIndex: chunk.index,
          chunkTotal: total,
          updated: new Date().toISOString(),
        });
        continue;
      }
      await storage.writeChunk(
        memory.frontmatter.id,
        chunk.index,
        total,
        memory.frontmatter.category,
        chunk.content,
        {
          confidence: memory.frontmatter.confidence,
          tags: memory.frontmatter.tags,
          entityRef: memory.frontmatter.entityRef,
          source: "migration-rechunk",
          importance: memory.frontmatter.importance,
          intentGoal: memory.frontmatter.intentGoal,
          intentActionType: memory.frontmatter.intentActionType,
          intentEntityTypes: memory.frontmatter.intentEntityTypes,
          memoryKind: memory.frontmatter.memoryKind,
        },
      );
    }
    for (let idx = total; idx < existing.length; idx += 1) {
      const stale = existing[idx];
      if (stale?.frontmatter?.id) {
        await storage.invalidateMemory(stale.frontmatter.id);
      }
    }
  }

  return {
    action: "rechunk",
    dryRun: options.write !== true,
    scanned: candidates.length,
    changed,
    queued: 0,
    limit,
  };
}

export async function runMigrateReextractCliCommand(
  orchestrator: MigrateCliOrchestrator,
  options: { model: string; write?: boolean; limit?: number },
): Promise<MigrateCliReport> {
  const model = options.model.trim();
  if (model.length === 0) {
    throw new Error("missing --model for migrate reextract");
  }
  const limit = clampMigrateLimit(options.limit, REEXTRACT_LIMIT_CAP, 100);
  const storage = await orchestrator.getStorage(orchestrator.config.defaultNamespace);
  const candidates = (await readMigrateCandidateMemories(storage, { includeArchived: false }))
    .filter((memory) => memory.frontmatter.parentId === undefined);
  const selected = candidates.slice(0, limit);
  let queued = 0;
  if (options.write === true && selected.length > 0) {
    queued = await storage.appendReextractJobs(
      selected.map((memory) => ({
        memoryId: memory.frontmatter.id,
        model,
        requestedAt: new Date().toISOString(),
        source: "cli-migrate",
      })),
    );
  }

  return {
    action: "reextract",
    dryRun: options.write !== true,
    scanned: selected.length,
    changed: selected.length,
    queued,
    limit,
    model,
  };
}

interface RuntimePolicySnapshotPayload {
  version: number;
  updatedAt: string;
  values: RuntimePolicyValues;
  sourceAdjustmentCount: number;
}

interface PolicySignalContribution {
  signalType: string;
  direction: string;
  count: number;
  lastSeenAt: string;
}

export interface PolicyStatusCliReport {
  generatedAt: string;
  autoTuneEnabled: boolean;
  current: (RuntimePolicySnapshotPayload & { policyVersion: string }) | null;
  previous: (RuntimePolicySnapshotPayload & { policyVersion: string }) | null;
  topContributingSignals: PolicySignalContribution[];
}

export interface PolicyDiffEntry {
  parameter: string;
  previousValue: number | null;
  nextValue: number | null;
  delta: number;
  evidenceCount: number;
}

export interface PolicyDiffCliReport {
  generatedAt: string;
  since: string;
  sinceIso: string;
  currentPolicyVersion: string | null;
  previousPolicyVersion: string | null;
  deltas: PolicyDiffEntry[];
  topContributingSignals: PolicySignalContribution[];
}

export interface PolicyRollbackCliReport {
  generatedAt: string;
  rolledBack: boolean;
  current: (RuntimePolicySnapshotPayload & { policyVersion: string }) | null;
}

export interface PolicyTuningCliOrchestrator {
  config: {
    memoryDir: string;
    defaultNamespace: string;
    sharedNamespace: string;
    namespacesEnabled: boolean;
    behaviorLoopAutoTuneEnabled: boolean;
    behaviorLoopLearningWindowDays: number;
    lifecycleArchiveDecayThreshold: number;
    recencyWeight: number;
    lifecyclePromoteHeatThreshold: number;
    lifecycleStaleDecayThreshold: number;
    cronRecallInstructionHeavyTokenCap: number;
    namespacePolicies: Array<{ name: string }>;
  };
  getStorage(namespace?: string): Promise<{
    readBehaviorSignals(limit?: number): Promise<BehaviorSignalEvent[]>;
  }>;
  rollbackBehaviorRuntimePolicy(): Promise<boolean>;
}

function effectivePolicyValuesForVersion(
  values: RuntimePolicyValues,
  config: PolicyTuningCliOrchestrator["config"],
): Required<RuntimePolicyValues> {
  const candidate: RuntimePolicyValues = {
    recencyWeight: values.recencyWeight ?? config.recencyWeight,
    lifecyclePromoteHeatThreshold: values.lifecyclePromoteHeatThreshold ?? config.lifecyclePromoteHeatThreshold,
    lifecycleStaleDecayThreshold: values.lifecycleStaleDecayThreshold ?? config.lifecycleStaleDecayThreshold,
    cronRecallInstructionHeavyTokenCap:
      values.cronRecallInstructionHeavyTokenCap ?? config.cronRecallInstructionHeavyTokenCap,
  };
  const normalized = sanitizeRuntimePolicyValues(candidate, {
    maxStaleDecayThreshold: config.lifecycleArchiveDecayThreshold,
  });
  return {
    recencyWeight: normalized.recencyWeight ?? config.recencyWeight,
    lifecyclePromoteHeatThreshold:
      normalized.lifecyclePromoteHeatThreshold ?? config.lifecyclePromoteHeatThreshold,
    lifecycleStaleDecayThreshold:
      normalized.lifecycleStaleDecayThreshold ?? config.lifecycleStaleDecayThreshold,
    cronRecallInstructionHeavyTokenCap:
      normalized.cronRecallInstructionHeavyTokenCap ?? config.cronRecallInstructionHeavyTokenCap,
  };
}

function policyVersionForValues(
  values: RuntimePolicyValues,
  config: PolicyTuningCliOrchestrator["config"],
): string {
  const normalized = effectivePolicyValuesForVersion(values, config);
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 12);
}

async function readRuntimePolicySnapshot(
  config: PolicyTuningCliOrchestrator["config"],
  fileName: string,
): Promise<RuntimePolicySnapshotPayload | null> {
  const filePath = path.join(config.memoryDir, "state", fileName);
  const snapshot = await readPolicyRuntimeSnapshot(filePath, {
    maxStaleDecayThreshold: config.lifecycleArchiveDecayThreshold,
  });
  if (!snapshot) return null;
  return {
    version: snapshot.version,
    updatedAt: snapshot.updatedAt,
    values: snapshot.values,
    sourceAdjustmentCount: Math.max(0, Math.floor(snapshot.sourceAdjustmentCount)),
  };
}

function parseSinceDurationMs(since: string): number {
  const trimmed = since.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)\s*([mhd])$/);
  if (!match) {
    throw new Error(`invalid --since value: ${since} (expected formats like 30m, 12h, 7d)`);
  }
  const amount = Number.parseInt(match[1] ?? "0", 10);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`invalid --since value: ${since}`);
  }
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

function resolvePolicySignalNamespaces(orchestrator: PolicyTuningCliOrchestrator): string[] {
  const names = new Set<string>([orchestrator.config.defaultNamespace]);
  if (orchestrator.config.namespacesEnabled) {
    names.add(orchestrator.config.sharedNamespace);
    for (const policy of orchestrator.config.namespacePolicies) {
      if (policy?.name) names.add(policy.name);
    }
  }
  return [...names];
}

async function readBehaviorSignalsForNamespaces(
  orchestrator: PolicyTuningCliOrchestrator,
  limitPerNamespace: number,
): Promise<BehaviorSignalEvent[]> {
  const namespaces = resolvePolicySignalNamespaces(orchestrator);
  const merged: BehaviorSignalEvent[] = [];
  for (const namespace of namespaces) {
    const storage = await orchestrator.getStorage(namespace);
    const events = await storage.readBehaviorSignals(limitPerNamespace);
    merged.push(...events);
  }
  return merged;
}

function summarizeTopSignals(
  signals: BehaviorSignalEvent[],
  cutoffIso?: string,
  topN: number = 5,
): PolicySignalContribution[] {
  const cutoffMs = cutoffIso ? Date.parse(cutoffIso) : Number.NEGATIVE_INFINITY;
  const grouped = new Map<string, PolicySignalContribution>();
  for (const signal of signals) {
    const ts = Date.parse(signal.timestamp);
    if (Number.isFinite(cutoffMs) && (!Number.isFinite(ts) || ts < cutoffMs)) continue;
    const key = `${signal.signalType}:${signal.direction}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      if (signal.timestamp > existing.lastSeenAt) {
        existing.lastSeenAt = signal.timestamp;
      }
    } else {
      grouped.set(key, {
        signalType: signal.signalType,
        direction: signal.direction,
        count: 1,
        lastSeenAt: signal.timestamp,
      });
    }
  }

  return [...grouped.values()]
    .sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, Math.max(1, topN));
}

export async function runPolicyStatusCliCommand(
  orchestrator: PolicyTuningCliOrchestrator,
): Promise<PolicyStatusCliReport> {
  const now = new Date();
  const current = await readRuntimePolicySnapshot(orchestrator.config, "policy-runtime.json");
  const previous = await readRuntimePolicySnapshot(orchestrator.config, "policy-runtime.prev.json");
  const signals = await readBehaviorSignalsForNamespaces(orchestrator, 1000);
  const defaultWindowMs = Math.max(0, orchestrator.config.behaviorLoopLearningWindowDays) * 24 * 60 * 60 * 1000;
  const cutoffIso = defaultWindowMs > 0 ? new Date(now.getTime() - defaultWindowMs).toISOString() : undefined;

  return {
    generatedAt: now.toISOString(),
    autoTuneEnabled: orchestrator.config.behaviorLoopAutoTuneEnabled,
    current: current
      ? {
        ...current,
        policyVersion: policyVersionForValues(current.values, orchestrator.config),
      }
      : null,
    previous: previous
      ? {
        ...previous,
        policyVersion: policyVersionForValues(previous.values, orchestrator.config),
      }
      : null,
    topContributingSignals: summarizeTopSignals(signals, cutoffIso),
  };
}

export async function runPolicyDiffCliCommand(
  orchestrator: PolicyTuningCliOrchestrator,
  options: { since?: string } = {},
): Promise<PolicyDiffCliReport> {
  const since = options.since?.trim() || "7d";
  const sinceMs = parseSinceDurationMs(since);
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();
  const current = await readRuntimePolicySnapshot(orchestrator.config, "policy-runtime.json");
  const previous = await readRuntimePolicySnapshot(orchestrator.config, "policy-runtime.prev.json");
  const currentValues = current?.values ?? {};
  const previousValues = previous?.values ?? {};
  const parameterKeys = new Set<string>([
    ...Object.keys(currentValues),
    ...Object.keys(previousValues),
  ]);
  const deltas: PolicyDiffEntry[] = [];
  for (const parameter of parameterKeys) {
    const previousRaw = (previousValues as Record<string, unknown>)[parameter];
    const nextRaw = (currentValues as Record<string, unknown>)[parameter];
    const previousValue = typeof previousRaw === "number" ? previousRaw : null;
    const nextValue = typeof nextRaw === "number" ? nextRaw : null;
    if (previousValue === nextValue) continue;
    deltas.push({
      parameter,
      previousValue,
      nextValue,
      delta: (nextValue ?? 0) - (previousValue ?? 0),
      evidenceCount: current?.sourceAdjustmentCount ?? 0,
    });
  }
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.parameter.localeCompare(b.parameter));

  const signals = await readBehaviorSignalsForNamespaces(orchestrator, 1000);
  return {
    generatedAt: new Date().toISOString(),
    since,
    sinceIso,
    currentPolicyVersion: current ? policyVersionForValues(current.values, orchestrator.config) : null,
    previousPolicyVersion: previous ? policyVersionForValues(previous.values, orchestrator.config) : null,
    deltas,
    topContributingSignals: summarizeTopSignals(signals, sinceIso),
  };
}

export async function runPolicyRollbackCliCommand(
  orchestrator: PolicyTuningCliOrchestrator,
): Promise<PolicyRollbackCliReport> {
  const rolledBack = await orchestrator.rollbackBehaviorRuntimePolicy();
  const current = await readRuntimePolicySnapshot(orchestrator.config, "policy-runtime.json");
  return {
    generatedAt: new Date().toISOString(),
    rolledBack,
    current: current
      ? {
        ...current,
        policyVersion: policyVersionForValues(current.values, orchestrator.config),
      }
      : null,
  };
}

function incrementCounter(target: Record<string, number>, key: string): void {
  const normalized = key && key.length > 0 ? key : "unknown";
  target[normalized] = (target[normalized] ?? 0) + 1;
}

function resolveAuditNamespaces(
  orchestrator: MemoryActionAuditCliOrchestrator,
  namespace?: string,
): string[] {
  if (namespace && namespace.length > 0) {
    return [namespace];
  }

  const names = new Set<string>([orchestrator.config.defaultNamespace]);
  if (orchestrator.config.namespacesEnabled) {
    names.add(orchestrator.config.sharedNamespace);
    for (const policy of orchestrator.config.namespacePolicies) {
      if (policy?.name) names.add(policy.name);
    }
  }

  return [...names];
}

export async function runMemoryActionAuditCliCommand(
  orchestrator: MemoryActionAuditCliOrchestrator,
  options: MemoryActionAuditCliCommandOptions = {},
): Promise<MemoryActionAuditCliReport> {
  const limit = Math.max(0, Math.floor(options.limit ?? 200));
  const namespaces = resolveAuditNamespaces(orchestrator, options.namespace);

  const namespaceSummaries: MemoryActionAuditCliNamespaceSummary[] = [];
  const totalsActions: Record<string, number> = {};
  const totalsOutcomes: Record<string, number> = {};
  const totalsPolicyDecisions: Record<string, number> = {};
  let totalEventCount = 0;

  for (const ns of namespaces) {
    const storage = await orchestrator.getStorage(ns);
    const events = await storage.readMemoryActionEvents(limit);

    const actions: Record<string, number> = {};
    const outcomes: Record<string, number> = {};
    const policyDecisions: Record<string, number> = {};

    for (const event of events) {
      incrementCounter(actions, event.action);
      incrementCounter(outcomes, event.outcome);
      incrementCounter(policyDecisions, event.policyDecision ?? "unknown");

      incrementCounter(totalsActions, event.action);
      incrementCounter(totalsOutcomes, event.outcome);
      incrementCounter(totalsPolicyDecisions, event.policyDecision ?? "unknown");
    }

    totalEventCount += events.length;
    namespaceSummaries.push({
      namespace: ns,
      eventCount: events.length,
      actions,
      outcomes,
      policyDecisions,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    limit,
    namespaces: namespaceSummaries,
    totals: {
      eventCount: totalEventCount,
      actions: totalsActions,
      outcomes: totalsOutcomes,
      policyDecisions: totalsPolicyDecisions,
    },
  };
}

export async function runTailscaleStatusCliCommand(
  options: TailscaleStatusCliCommandOptions = {},
): Promise<{
  available: boolean;
  running: boolean;
  backendState?: string;
  version?: string;
  selfHostname?: string;
  selfIp?: string;
}> {
  const helper = options.helper ?? new TailscaleHelper({ timeoutMs: options.timeoutMs });
  return helper.status();
}

export async function runTailscaleSyncCliCommand(
  options: TailscaleSyncCliCommandOptions,
): Promise<{ ok: true }> {
  const helper = options.helper ?? new TailscaleHelper();
  await helper.syncDirectory({
    sourceDir: options.sourceDir,
    destination: options.destination,
    delete: options.delete,
    dryRun: options.dryRun,
    extraArgs: options.extraArgs,
  });
  return { ok: true };
}

export async function runWebDavServeCliCommand(
  options: WebDavServeCliCommandOptions,
): Promise<{ running: boolean; host: string; port: number; rootCount: number }> {
  return withWebDavLock(async () => {
    if (!Array.isArray(options.allowlistDirs) || options.allowlistDirs.length === 0) {
      throw new Error("webdav allowlist requires at least one directory");
    }

    const usernameProvided = options.authUsername !== undefined;
    const passwordProvided = options.authPassword !== undefined;
    const username = options.authUsername?.trim();
    const password = options.authPassword?.trim();

    if ((usernameProvided && !username) || (passwordProvided && !password)) {
      throw new Error("webdav auth username/password must be non-empty when provided");
    }

    if ((username && !password) || (!username && password)) {
      throw new Error("webdav auth requires both username and password");
    }

    if (activeWebDavServer) {
      const current = activeWebDavServer.status();
      if (current.running) return current;
    }

    const createServer = options.createServer ?? WebDavServer.create;
    const server = await createServer({
      enabled: options.enabled ?? true,
      host: options.host,
      port: options.port ?? 8080,
      allowlistDirs: options.allowlistDirs,
      auth: username && password ? { username, password } : undefined,
    });

    activeWebDavServer = server;
    try {
      return await server.start();
    } catch (err) {
      if (activeWebDavServer === server) {
        activeWebDavServer = null;
      }
      throw err;
    }
  });
}

export async function runWebDavStopCliCommand(): Promise<{ stopped: boolean }> {
  return withWebDavLock(async () => {
    if (!activeWebDavServer) {
      return { stopped: false };
    }

    const server = activeWebDavServer;
    await server.stop();
    if (activeWebDavServer === server) {
      activeWebDavServer = null;
    }
    return { stopped: true };
  });
}

export async function runDashboardStartCliCommand(
  options: DashboardStartCliCommandOptions,
): Promise<DashboardStatus> {
  return withDashboardLock(async () => {
    if (activeDashboardServer) {
      const status = activeDashboardServer.status();
      if (status.running) return status;
    }

    const createServer = options.createServer ?? ((opts: DashboardStartCliCommandOptions) =>
      new GraphDashboardServer({
        memoryDir: opts.memoryDir,
        host: opts.host,
        port: opts.port,
        publicDir: opts.publicDir,
      }));

    const server = createServer(options);
    activeDashboardServer = server;
    try {
      return await server.start();
    } catch (err) {
      if (activeDashboardServer === server) {
        activeDashboardServer = null;
      }
      throw err;
    }
  });
}

export async function runDashboardStopCliCommand(): Promise<{ stopped: boolean }> {
  return withDashboardLock(async () => {
    if (!activeDashboardServer) return { stopped: false };
    const server = activeDashboardServer;
    await server.stop();
    if (activeDashboardServer === server) {
      activeDashboardServer = null;
    }
    return { stopped: true };
  });
}

export async function runDashboardStatusCliCommand(): Promise<{ running: false } | DashboardStatus> {
  return withDashboardLock(async () => {
    if (!activeDashboardServer) return { running: false };
    return activeDashboardServer.status();
  });
}

export async function runCompatCliCommand(
  options: CompatCliCommandOptions = {},
): Promise<{ report: CompatReport; exitCode: number }> {
  const report = await runCompatChecks({
    repoRoot: options.repoRoot ?? process.cwd(),
    runner: options.runner,
    now: options.now,
  });
  const hasWarnOrError = report.summary.warn > 0 || report.summary.error > 0;
  const exitCode = options.strict === true && hasWarnOrError ? 1 : 0;
  return { report, exitCode };
}

export async function runRouteCliCommand(options: RouteCliCommandOptions): Promise<unknown> {
  const store = new RoutingRulesStore(options.memoryDir, options.stateFile);

  if (options.action === "list") {
    const rules = await store.read();
    return [...rules].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.pattern.localeCompare(b.pattern);
    });
  }

  if (options.action === "add") {
    const pattern = options.pattern?.trim();
    if (!pattern) throw new Error("missing pattern");
    if (!options.targetRaw || options.targetRaw.trim().length === 0) throw new Error("missing target");
    const patternType = options.patternType ?? "keyword";
    if (!isRoutePatternType(patternType)) throw new Error(`invalid route pattern type: ${patternType}`);
    const priority = options.priority ?? 0;
    if (!Number.isFinite(priority)) throw new Error("invalid priority");
    const target = parseRouteTargetCliArg(options.targetRaw);
    const validation = validateRouteTarget(target);
    if (!validation.ok || !validation.target) throw new Error(validation.error ?? "invalid target");

    const rule: RouteRule = {
      id: options.id?.trim() || "",
      patternType,
      pattern,
      priority: Math.trunc(priority),
      target: validation.target,
      enabled: true,
    };
    return store.upsert(rule);
  }

  if (options.action === "remove") {
    const pattern = options.pattern?.trim();
    if (!pattern) throw new Error("missing pattern");
    return store.removeByPattern(pattern);
  }

  if (options.action === "test") {
    const text = options.text?.trim();
    if (!text) throw new Error("missing text");
    const rules = await store.read();
    return selectRouteRule(text, rules);
  }

  throw new Error(`unsupported route action: ${options.action}`);
}

export async function runWorkTaskCliCommand(options: WorkTaskCliCommandOptions): Promise<unknown> {
  const storage = new WorkStorage(options.memoryDir);

  if (options.action === "create") {
    if (!options.title || options.title.trim().length === 0) throw new Error("missing title");
    if (options.status !== undefined && !isWorkTaskStatus(options.status)) throw new Error(`invalid task status: ${options.status}`);
    if (options.priority !== undefined && !isWorkTaskPriority(options.priority)) {
      throw new Error(`invalid task priority: ${options.priority}`);
    }
    const explicitId = options.id?.trim();
    if (explicitId && explicitId.length > 0) {
      const existing = await storage.getTask(explicitId);
      if (existing) throw new Error(`task already exists: ${explicitId}`);
    }
    return storage.createTask({
      id: explicitId && explicitId.length > 0 ? explicitId : undefined,
      title: options.title.trim(),
      description: options.description?.trim(),
      status: options.status,
      priority: options.priority,
      owner: normalizeNullableCliValue(options.owner),
      assignee: normalizeNullableCliValue(options.assignee),
      projectId: normalizeNullableCliValue(options.projectId),
      tags: options.tags,
      dueAt: normalizeNullableCliValue(options.dueAt),
    });
  }

  if (options.action === "get") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    return storage.getTask(options.id.trim());
  }

  if (options.action === "list") {
    if (options.status !== undefined && !isWorkTaskStatus(options.status)) throw new Error(`invalid task status: ${options.status}`);
    return storage.listTasks({
      status: options.status,
      owner: options.owner?.trim() || undefined,
      assignee: options.assignee?.trim() || undefined,
      projectId: options.projectId?.trim() || undefined,
    });
  }

  if (options.action === "update") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    const patch = options.patch ?? {};
    if (patch.status !== undefined && !isWorkTaskStatus(patch.status)) throw new Error(`invalid task status: ${patch.status}`);
    if (patch.priority !== undefined && !isWorkTaskPriority(patch.priority)) {
      throw new Error(`invalid task priority: ${patch.priority}`);
    }

    const sparsePatch: WorkTaskPatchInput = {};
    if (Object.prototype.hasOwnProperty.call(patch, "title")) sparsePatch.title = patch.title;
    if (Object.prototype.hasOwnProperty.call(patch, "description")) sparsePatch.description = patch.description;
    if (Object.prototype.hasOwnProperty.call(patch, "status")) sparsePatch.status = patch.status;
    if (Object.prototype.hasOwnProperty.call(patch, "priority")) sparsePatch.priority = patch.priority;
    if (Object.prototype.hasOwnProperty.call(patch, "owner")) sparsePatch.owner = patch.owner;
    if (Object.prototype.hasOwnProperty.call(patch, "assignee")) sparsePatch.assignee = patch.assignee;
    if (Object.prototype.hasOwnProperty.call(patch, "projectId")) sparsePatch.projectId = patch.projectId;
    if (Object.prototype.hasOwnProperty.call(patch, "tags")) sparsePatch.tags = patch.tags;
    if (Object.prototype.hasOwnProperty.call(patch, "dueAt")) sparsePatch.dueAt = patch.dueAt;

    return storage.updateTask(options.id.trim(), sparsePatch);
  }

  if (options.action === "transition") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    if (!options.status || !isWorkTaskStatus(options.status)) throw new Error(`invalid task status: ${options.status}`);
    return storage.transitionTask(options.id.trim(), options.status);
  }

  if (options.action === "delete") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    return storage.deleteTask(options.id.trim());
  }

  if (options.action === "link") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    if (!options.projectId || options.projectId.trim().length === 0) throw new Error("missing projectId");
    return storage.linkTaskToProject(options.id.trim(), options.projectId.trim());
  }

  throw new Error(`unsupported task action: ${options.action}`);
}

export async function runWorkProjectCliCommand(options: WorkProjectCliCommandOptions): Promise<unknown> {
  const storage = new WorkStorage(options.memoryDir);

  if (options.action === "create") {
    if (!options.name || options.name.trim().length === 0) throw new Error("missing name");
    if (options.status !== undefined && !isWorkProjectStatus(options.status)) {
      throw new Error(`invalid project status: ${options.status}`);
    }
    const explicitId = options.id?.trim();
    if (explicitId && explicitId.length > 0) {
      const existing = await storage.getProject(explicitId);
      if (existing) throw new Error(`project already exists: ${explicitId}`);
    }
    return storage.createProject({
      id: explicitId && explicitId.length > 0 ? explicitId : undefined,
      name: options.name.trim(),
      description: options.description?.trim(),
      status: options.status,
      owner: normalizeNullableCliValue(options.owner),
      tags: options.tags,
    });
  }

  if (options.action === "get") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    return storage.getProject(options.id.trim());
  }

  if (options.action === "list") {
    return storage.listProjects();
  }

  if (options.action === "update") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    const patch = options.patch ?? {};
    if (patch.status !== undefined && !isWorkProjectStatus(patch.status)) {
      throw new Error(`invalid project status: ${patch.status}`);
    }

    const sparsePatch: WorkProjectPatchInput = {};
    if (Object.prototype.hasOwnProperty.call(patch, "name")) sparsePatch.name = patch.name;
    if (Object.prototype.hasOwnProperty.call(patch, "description")) sparsePatch.description = patch.description;
    if (Object.prototype.hasOwnProperty.call(patch, "status")) sparsePatch.status = patch.status;
    if (Object.prototype.hasOwnProperty.call(patch, "owner")) sparsePatch.owner = patch.owner;
    if (Object.prototype.hasOwnProperty.call(patch, "tags")) sparsePatch.tags = patch.tags;

    return storage.updateProject(options.id.trim(), sparsePatch);
  }

  if (options.action === "delete") {
    if (!options.id || options.id.trim().length === 0) throw new Error("missing id");
    return storage.deleteProject(options.id.trim());
  }

  throw new Error(`unsupported project action: ${options.action}`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runReplayCliCommand(
  orchestrator: ReplayCliOrchestrator,
  options: ReplayCliCommandOptions,
): Promise<ReplayRunSummary> {
  const extractionIdleTimeoutMs = Number.isFinite(options.extractionIdleTimeoutMs as number)
    ? Math.max(1_000, Math.floor(options.extractionIdleTimeoutMs as number))
    : 15 * 60_000;
  const inputRaw = await readFile(options.inputPath, "utf-8");
  const registry = buildReplayNormalizerRegistry([
    openclawReplayNormalizer,
    claudeReplayNormalizer,
    chatgptReplayNormalizer,
  ]);
  const ingestBatchSize = clampBatchSize(options.batchSize);
  const turnsBySession = new Map<string, ReplayTurn[]>();
  const ingestSessionChunk = async (sessionTurns: ReplayTurn[]): Promise<void> => {
    const deadlineMs = Date.now() + extractionIdleTimeoutMs;
    await withTimeout(
      orchestrator.ingestReplayBatch(sessionTurns, { deadlineMs }),
      extractionIdleTimeoutMs,
      `replay extraction batch did not complete before timeout (${extractionIdleTimeoutMs}ms)`,
    );
  };

  const summary = await runReplay(
    options.source,
    inputRaw,
    registry,
    {
      onBatch: async (batch) => {
        for (const turn of batch) {
          const key = normalizeReplaySessionKey(turn.sessionKey);
          const turns = turnsBySession.get(key) ?? [];
          turns.push(turn);
          turnsBySession.set(key, turns);
          while (turns.length >= ingestBatchSize) {
            const chunk = turns.splice(0, ingestBatchSize);
            await ingestSessionChunk(chunk);
          }
        }
      },
    },
    {
      from: options.from,
      to: options.to,
      dryRun: options.dryRun === true,
      startOffset: options.startOffset,
      maxTurns: options.maxTurns,
      batchSize: options.batchSize,
      defaultSessionKey: options.defaultSessionKey,
      strict: options.strict,
    },
  );

  if (!summary.dryRun) {
    for (const turns of turnsBySession.values()) {
      if (turns.length === 0) continue;
      await ingestSessionChunk(turns);
    }
    if (options.runConsolidation === true) {
      const consolidationIdle = await orchestrator.waitForConsolidationIdle(extractionIdleTimeoutMs);
      if (!consolidationIdle) {
        throw new Error(
          `replay consolidation did not become idle before timeout (${extractionIdleTimeoutMs}ms)`,
        );
      }
      await orchestrator.runConsolidationNow();
    }
  }

  return summary;
}

async function getPluginVersion(): Promise<string> {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw = await readFile(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveMemoryDirForNamespace(orchestrator: Orchestrator, namespace?: string): Promise<string> {
  const ns = (namespace ?? "").trim();
  if (!ns) return orchestrator.config.memoryDir;
  if (!orchestrator.config.namespacesEnabled) return orchestrator.config.memoryDir;

  const candidate = path.join(orchestrator.config.memoryDir, "namespaces", ns);
  if (ns === orchestrator.config.defaultNamespace) {
    return (await exists(candidate)) ? candidate : orchestrator.config.memoryDir;
  }
  return candidate;
}

async function readAllMemoryFiles(memoryDir: string): Promise<DedupeCandidate[]> {
  const roots = [path.join(memoryDir, "facts"), path.join(memoryDir, "corrections")];
  const out: DedupeCandidate[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string | Buffer }>;
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Array<{
        isDirectory(): boolean;
        isFile(): boolean;
        name: string | Buffer;
      }>;
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryName = typeof entry.name === "string" ? entry.name : entry.name.toString("utf-8");
      const fullPath = path.join(dir, entryName);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entryName.endsWith(".md")) continue;

      try {
        const raw = await readFile(fullPath, "utf-8");
        const parsed = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!parsed) continue;
        const fmRaw = parsed[1];
        const body = parsed[2] ?? "";
        const get = (key: string): string => {
          const match = fmRaw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
          return match ? match[1].trim() : "";
        };
        const confidenceRaw = get("confidence");
        const confidence = confidenceRaw.length > 0 ? Number(confidenceRaw) : undefined;
        out.push({
          path: fullPath,
          content: body,
          frontmatter: {
            id: get("id") || undefined,
            confidence: Number.isFinite(confidence as number) ? confidence : undefined,
            updated: get("updated") || undefined,
            created: get("created") || undefined,
          },
        });
      } catch {
        // Skip unreadable/malformed files.
      }
    }
  };

  for (const root of roots) {
    await walk(root);
  }

  return out;
}

function formatContinuityIncidentCli(incident: ContinuityIncidentRecord): string {
  const lines = [
    `${incident.id} [${incident.state}]`,
    `  opened: ${incident.openedAt}`,
  ];
  if (incident.closedAt) lines.push(`  closed: ${incident.closedAt}`);
  if (incident.triggerWindow) lines.push(`  window: ${incident.triggerWindow}`);
  lines.push(`  symptom: ${incident.symptom}`);
  if (incident.suspectedCause) lines.push(`  suspected-cause: ${incident.suspectedCause}`);
  if (incident.fixApplied) lines.push(`  fix-applied: ${incident.fixApplied}`);
  if (incident.verificationResult) lines.push(`  verification: ${incident.verificationResult}`);
  if (incident.preventiveRule) lines.push(`  preventive-rule: ${incident.preventiveRule}`);
  if (incident.filePath) lines.push(`  path: ${incident.filePath}`);
  return lines.join("\n");
}

export function registerCli(api: CliApi, orchestrator: Orchestrator): void {
  api.registerCli(
    ({ program }) => {
      const cmd = program
        .command("engram")
        .description("Engram local memory commands");

      cmd
        .command("stats")
        .description("Show memory system statistics")
        .action(async () => {
          // Ensure QMD is probed before checking availability
          await orchestrator.qmd.probe();

          const meta = await orchestrator.storage.loadMeta();
          const memories = await orchestrator.storage.readAllMemories();
          const entities = await orchestrator.storage.readEntities();
          const profile = await orchestrator.storage.readProfile();

          console.log("=== Engram Memory Stats ===\n");
          console.log(`Total memories: ${memories.length}`);
          console.log(`Total entities: ${entities.length}`);
          console.log(`Profile size: ${profile.length} chars`);
          console.log(`Extractions: ${meta.extractionCount}`);
          console.log(`Last extraction: ${meta.lastExtractionAt ?? "never"}`);
          console.log(
            `Last consolidation: ${meta.lastConsolidationAt ?? "never"}`,
          );
          console.log(`QMD: ${orchestrator.qmd.isAvailable() ? "available" : "not available"}`);

          // Category breakdown
          const categories: Record<string, number> = {};
          for (const m of memories) {
            categories[m.frontmatter.category] =
              (categories[m.frontmatter.category] ?? 0) + 1;
          }
          if (Object.keys(categories).length > 0) {
            console.log("\nBy category:");
            for (const [cat, count] of Object.entries(categories)) {
              console.log(`  ${cat}: ${count}`);
            }
          }
        });

      cmd
        .command("export")
        .description("Export Engram memory to JSON, Markdown bundle, or SQLite")
        .option("--format <format>", "Export format: json|md|sqlite", "json")
        .option("--out <path>", "Output path (dir for json/md, file for sqlite)")
        .option("--include-transcripts", "Include transcripts in export (default: false)")
        .option("--namespace <ns>", "Namespace to export (v3.0+, default: config defaultNamespace)", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const format = String(options.format ?? "json");
          const out = options.out ? String(options.out) : "";
          const includeTranscripts = options.includeTranscripts === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          if (!out) {
            console.log("Missing --out. Example: openclaw engram export --format json --out /tmp/engram-export");
            return;
          }

          const pluginVersion = await getPluginVersion();
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);
          if (format === "json") {
            await exportJsonBundle({
              memoryDir,
              outDir: out,
              includeTranscripts,
              pluginVersion,
              workspaceDir: orchestrator.config.workspaceDir,
              includeWorkspaceIdentity: true,
            });
          } else if (format === "md") {
            await exportMarkdownBundle({
              memoryDir,
              outDir: out,
              includeTranscripts,
              pluginVersion,
            });
          } else if (format === "sqlite") {
            await exportSqlite({
              memoryDir,
              outFile: out,
              includeTranscripts,
              pluginVersion,
            });
          } else {
            console.log(`Unknown format: ${format}`);
            return;
          }
          console.log("OK");
        });

      cmd
        .command("import")
        .description("Import Engram memory from JSON bundle, Markdown bundle, or SQLite")
        .option("--from <path>", "Import source path (dir or file)")
        .option("--format <format>", "Import format: auto|json|md|sqlite", "auto")
        .option("--conflict <mode>", "Conflict policy: skip|overwrite|dedupe", "skip")
        .option("--dry-run", "Validate import without writing files")
        .option("--namespace <ns>", "Namespace to import into (v3.0+, default: config defaultNamespace)", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const from = options.from ? String(options.from) : "";
          const formatOpt = String(options.format ?? "auto");
          const conflict = String(options.conflict ?? "skip") as "skip" | "overwrite" | "dedupe";
          const dryRun = options.dryRun === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          if (!from) {
            console.log("Missing --from. Example: openclaw engram import --from /tmp/engram-export --format auto");
            return;
          }

          const detected = formatOpt === "auto" ? await detectImportFormat(from) : (formatOpt as any);
          if (!detected) {
            console.log("Could not detect import format (use --format json|md|sqlite).");
            return;
          }

          const targetMemoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);

          if (detected === "json") {
            await importJsonBundle({
              targetMemoryDir,
              fromDir: from,
              conflict,
              dryRun,
              workspaceDir: orchestrator.config.workspaceDir,
            });
          } else if (detected === "sqlite") {
            await importSqlite({
              targetMemoryDir,
              fromFile: from,
              conflict,
              dryRun,
            });
          } else if (detected === "md") {
            await importMarkdownBundle({
              targetMemoryDir,
              fromDir: from,
              conflict,
              dryRun,
            });
          } else {
            console.log(`Unknown detected format: ${detected}`);
            return;
          }
          console.log("OK");
        });

      cmd
        .command("backup")
        .description("Create a timestamped backup of the Engram memory directory")
        .option("--out-dir <dir>", "Backup root directory")
        .option("--retention-days <n>", "Delete backups older than N days", "0")
        .option("--include-transcripts", "Include transcripts (default false)")
        .option("--namespace <ns>", "Namespace to back up (v3.0+, default: config defaultNamespace)", "")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const outDir = options.outDir ? String(options.outDir) : "";
          const retentionDays = parseInt(String(options.retentionDays ?? "0"), 10);
          const includeTranscripts = options.includeTranscripts === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          if (!outDir) {
            console.log("Missing --out-dir. Example: openclaw engram backup --out-dir /tmp/engram-backups");
            return;
          }
          const pluginVersion = await getPluginVersion();
          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);
          await backupMemoryDir({
            memoryDir,
            outDir,
            retentionDays: Number.isFinite(retentionDays) ? retentionDays : undefined,
            includeTranscripts,
            pluginVersion,
          });
          console.log("OK");
        });

      cmd
        .command("compat")
        .description("Run local compatibility diagnostics for Engram plugin wiring")
        .option("--json", "Emit JSON output for automation")
        .option("--strict", "Exit non-zero when warnings or errors are present")
        .option("--repo-root <path>", "Repository root to inspect", process.cwd())
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const strict = options.strict === true;
          const jsonOutput = options.json === true;
          const repoRoot =
            typeof options.repoRoot === "string" && options.repoRoot.trim().length > 0
              ? options.repoRoot.trim()
              : process.cwd();

          const result = await runCompatCliCommand({ repoRoot, strict });

          if (jsonOutput) {
            console.log(JSON.stringify({ strict, exitCode: result.exitCode, report: result.report }, null, 2));
          } else {
            console.log("=== Engram Compatibility Report ===");
            for (const check of result.report.checks) {
              console.log(`- [${check.level.toUpperCase()}] ${check.title}: ${check.message}`);
              if (check.remediation) {
                console.log(`    remediation: ${check.remediation}`);
              }
            }
            console.log(
              `Summary: ok=${result.report.summary.ok} warn=${result.report.summary.warn} error=${result.report.summary.error}`,
            );
          }

          if (result.exitCode !== 0) {
            process.exitCode = result.exitCode;
          }
        });

      cmd
        .command("replay")
        .description("Import replay transcripts from external exports")
        .option("--source <source>", "Replay source: openclaw|claude|chatgpt")
        .option("--input <path>", "Path to replay export file")
        .option("--from <iso>", "Inclusive lower bound timestamp (ISO UTC)")
        .option("--to <iso>", "Inclusive upper bound timestamp (ISO UTC)")
        .option("--dry-run", "Parse and validate only; do not enqueue extraction")
        .option("--start-offset <n>", "Start replay at offset", "0")
        .option("--max-turns <n>", "Maximum turns to process", "0")
        .option("--batch-size <n>", "Replay ingestion batch size", "100")
        .option("--default-session-key <key>", "Fallback session key when source session identifiers are missing")
        .option("--strict", "Fail on invalid source rows")
        .option("--run-consolidation", "Run consolidation after replay ingestion completes")
        .option("--idle-timeout-ms <n>", "Extraction idle timeout per replay batch/final drain in milliseconds", "900000")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const sourceRaw = typeof options.source === "string" ? options.source.trim().toLowerCase() : "";
          const inputPath = typeof options.input === "string" ? options.input.trim() : "";
          if (!isReplaySource(sourceRaw)) {
            console.log("Missing or invalid --source. Use one of: openclaw, claude, chatgpt.");
            return;
          }
          if (inputPath.length === 0) {
            console.log("Missing --input. Example: openclaw engram replay --source openclaw --input /tmp/replay.jsonl");
            return;
          }

          const startOffset = parseInt(String(options.startOffset ?? "0"), 10);
          const maxTurnsRaw = parseInt(String(options.maxTurns ?? "0"), 10);
          const batchSize = parseInt(String(options.batchSize ?? "100"), 10);
          const idleTimeoutMs = parseInt(String(options.idleTimeoutMs ?? "900000"), 10);
          const summary = await runReplayCliCommand(orchestrator, {
            source: sourceRaw,
            inputPath,
            from: typeof options.from === "string" ? options.from : undefined,
            to: typeof options.to === "string" ? options.to : undefined,
            dryRun: options.dryRun === true,
            startOffset: Number.isFinite(startOffset) ? Math.max(0, startOffset) : 0,
            maxTurns: Number.isFinite(maxTurnsRaw) && maxTurnsRaw > 0 ? maxTurnsRaw : undefined,
            batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 100,
            defaultSessionKey:
              typeof options.defaultSessionKey === "string" && options.defaultSessionKey.trim().length > 0
                ? options.defaultSessionKey.trim()
                : undefined,
            strict: options.strict === true,
            runConsolidation: options.runConsolidation === true,
            extractionIdleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : 900_000,
          });

          console.log(`Replay source: ${summary.source}`);
          console.log(`Parsed turns: ${summary.parsedTurns}`);
          console.log(`Valid turns: ${summary.validTurns}`);
          console.log(`Invalid turns: ${summary.invalidTurns}`);
          console.log(`Filtered by date: ${summary.filteredByDate}`);
          console.log(`Skipped by offset: ${summary.skippedByOffset}`);
          console.log(`Processed turns: ${summary.processedTurns}`);
          console.log(`Batches: ${summary.batchCount}`);
          console.log(`Dry run: ${summary.dryRun ? "yes" : "no"}`);
          console.log(`Next offset: ${summary.nextOffset}`);
          if (summary.firstTimestamp) console.log(`First timestamp: ${summary.firstTimestamp}`);
          if (summary.lastTimestamp) console.log(`Last timestamp: ${summary.lastTimestamp}`);
          if (summary.warnings.length > 0) {
            console.log(`Warnings (${summary.warnings.length}):`);
            for (const warning of summary.warnings.slice(0, 20)) {
              const idx = typeof warning.index === "number" ? ` @${warning.index}` : "";
              console.log(`  - ${warning.code}${idx}: ${warning.message}`);
            }
            if (summary.warnings.length > 20) {
              console.log(`  ... and ${summary.warnings.length - 20} more`);
            }
          }
          console.log("OK");
        });

      cmd
        .command("benchmark-status")
        .description("Show benchmark/evaluation harness status, benchmark packs, and latest run summary")
        .action(async () => {
          const status = await runBenchmarkStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            evalStoreDir: orchestrator.config.evalStoreDir,
            evalHarnessEnabled: orchestrator.config.evalHarnessEnabled,
            evalShadowModeEnabled: orchestrator.config.evalShadowModeEnabled,
            memoryRedTeamBenchEnabled: orchestrator.config.memoryRedTeamBenchEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("benchmark-validate")
        .description("Validate a benchmark manifest file or pack directory without importing it")
        .argument("<path>", "Path to a benchmark manifest JSON file or a directory with manifest.json")
        .action(async (...args: unknown[]) => {
          const inputPath = args[0];
          const summary = await runBenchmarkValidateCliCommand({
            path: typeof inputPath === "string" ? inputPath : "",
            memoryRedTeamBenchEnabled: orchestrator.config.memoryRedTeamBenchEnabled,
          });
          console.log(JSON.stringify(summary, null, 2));
          console.log("OK");
        });

      cmd
        .command("benchmark-import")
        .description("Validate and import a benchmark manifest file or pack directory into Engram's eval store")
        .argument("<path>", "Path to a benchmark manifest JSON file or a directory with manifest.json")
        .option("--force", "Replace an existing imported benchmark pack with the same benchmarkId")
        .action(async (...args: unknown[]) => {
          const inputPath = args[0];
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const summary = await runBenchmarkImportCliCommand({
            path: typeof inputPath === "string" ? inputPath : "",
            memoryDir: orchestrator.config.memoryDir,
            evalStoreDir: orchestrator.config.evalStoreDir,
            force: options.force === true,
            memoryRedTeamBenchEnabled: orchestrator.config.memoryRedTeamBenchEnabled,
          });
          console.log(JSON.stringify(summary, null, 2));
          console.log("OK");
        });

      cmd
        .command("benchmark-ci-gate")
        .description("Compare two eval stores and fail when the candidate regresses benchmark outcomes")
        .requiredOption("--base <path>", "Path to the base eval store directory")
        .requiredOption("--candidate <path>", "Path to the candidate eval store directory")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const summary = await runBenchmarkCiGateCliCommand({
            baseEvalStoreDir: typeof options.base === "string" ? options.base : "",
            candidateEvalStoreDir: typeof options.candidate === "string" ? options.candidate : "",
          });
          console.log(JSON.stringify(summary, null, 2));
          if (!summary.passed) {
            throw new Error("benchmark CI gate detected regressions");
          }
          console.log("OK");
        });

      cmd
        .command("objective-state-status")
        .description("Show objective-state store status, snapshot counts, and latest stored snapshot")
        .action(async () => {
          const status = await runObjectiveStateStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            objectiveStateStoreDir: orchestrator.config.objectiveStateStoreDir,
            objectiveStateMemoryEnabled: orchestrator.config.objectiveStateMemoryEnabled,
            objectiveStateSnapshotWritesEnabled: orchestrator.config.objectiveStateSnapshotWritesEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("causal-trajectory-status")
        .description("Show causal-trajectory store status, record counts, and latest stored chain")
        .action(async () => {
          const status = await runCausalTrajectoryStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            causalTrajectoryStoreDir: orchestrator.config.causalTrajectoryStoreDir,
            causalTrajectoryMemoryEnabled: orchestrator.config.causalTrajectoryMemoryEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("trust-zone-status")
        .description("Show trust-zone store status, zoned record counts, and latest stored record")
        .action(async () => {
          const status = await runTrustZoneStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            trustZoneStoreDir: orchestrator.config.trustZoneStoreDir,
            trustZonesEnabled: orchestrator.config.trustZonesEnabled,
            quarantinePromotionEnabled: orchestrator.config.quarantinePromotionEnabled,
            memoryPoisoningDefenseEnabled: orchestrator.config.memoryPoisoningDefenseEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("abstraction-node-status")
        .description("Show abstraction-node store status, abstraction counts, and latest stored node")
        .action(async () => {
          const status = await runAbstractionNodeStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            abstractionNodeStoreDir: orchestrator.config.abstractionNodeStoreDir,
            harmonicRetrievalEnabled: orchestrator.config.harmonicRetrievalEnabled,
            abstractionAnchorsEnabled: orchestrator.config.abstractionAnchorsEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("cue-anchor-status")
        .description("Show cue-anchor index status, anchor counts, and the latest stored cue anchor")
        .action(async () => {
          const status = await runCueAnchorStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            abstractionNodeStoreDir: orchestrator.config.abstractionNodeStoreDir,
            harmonicRetrievalEnabled: orchestrator.config.harmonicRetrievalEnabled,
            abstractionAnchorsEnabled: orchestrator.config.abstractionAnchorsEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("harmonic-search")
        .description("Preview harmonic retrieval blending over abstraction nodes and cue anchors")
        .argument("<query>", "Prompt-like query to evaluate against harmonic retrieval storage")
        .option("--max-results <count>", "Maximum number of blended results to return", "3")
        .option("--session-key <sessionKey>", "Optional session key for same-session tie-breaking")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const maxResults = typeof options.maxResults === "string"
            ? Number.parseInt(options.maxResults, 10)
            : 3;
          const results = await runHarmonicSearchCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            abstractionNodeStoreDir: orchestrator.config.abstractionNodeStoreDir,
            harmonicRetrievalEnabled: orchestrator.config.harmonicRetrievalEnabled,
            abstractionAnchorsEnabled: orchestrator.config.abstractionAnchorsEnabled,
            query,
            maxResults: Number.isFinite(maxResults) ? maxResults : 3,
            sessionKey: typeof options.sessionKey === "string" ? options.sessionKey : undefined,
          });
          console.log(JSON.stringify(results, null, 2));
          console.log("OK");
        });

      cmd
        .command("commitment-status")
        .description("Show commitment ledger status, entry counts, and the latest recorded commitment")
        .action(async () => {
          const status = await runCommitmentStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            commitmentLedgerEnabled: orchestrator.config.commitmentLedgerEnabled,
            commitmentLifecycleEnabled: orchestrator.config.commitmentLifecycleEnabled,
            commitmentStaleDays: orchestrator.config.commitmentStaleDays,
            commitmentDecayDays: orchestrator.config.commitmentDecayDays,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("commitment-record")
        .description("Record a commitment ledger entry when commitment memory is enabled")
        .requiredOption("--entry-id <entryId>", "Commitment entry id")
        .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the entry")
        .requiredOption("--session-key <sessionKey>", "Session key that owns the commitment")
        .requiredOption("--source <source>", "Entry source (tool_result|cli|system|manual)")
        .requiredOption("--kind <kind>", "Entry kind (promise|follow_up|deadline|deliverable)")
        .requiredOption("--state <state>", "Entry state (open|fulfilled|cancelled|expired)")
        .requiredOption("--scope <scope>", "Primary scope or identifier for the commitment")
        .requiredOption("--summary <summary>", "Human-readable summary of the commitment")
        .option("--due-at <dueAt>", "Optional due timestamp for the commitment")
        .option("--tag <tag...>", "Tags to attach to the commitment entry")
        .option("--entity-ref <entityRef...>", "Entity refs to attach to the commitment entry")
        .option(
          "--work-product-entry-ref <workProductEntryRef...>",
          "Work-product ledger refs that this commitment depends on",
        )
        .option(
          "--objective-state-snapshot-ref <objectiveStateSnapshotRef...>",
          "Objective-state snapshot refs to link to this commitment",
        )
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const filePath = await runCommitmentRecordCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            commitmentLedgerEnabled: orchestrator.config.commitmentLedgerEnabled,
            entry: {
              schemaVersion: 1,
              entryId: String(options.entryId ?? ""),
              recordedAt: String(options.recordedAt ?? ""),
              sessionKey: String(options.sessionKey ?? ""),
              source: String(options.source ?? "") as CommitmentLedgerEntry["source"],
              kind: String(options.kind ?? "") as CommitmentLedgerEntry["kind"],
              state: String(options.state ?? "") as CommitmentLedgerEntry["state"],
              scope: String(options.scope ?? ""),
              summary: String(options.summary ?? ""),
              dueAt: typeof options.dueAt === "string" ? options.dueAt : undefined,
              tags: Array.isArray(options.tag) ? options.tag.map(String) : undefined,
              entityRefs: Array.isArray(options.entityRef) ? options.entityRef.map(String) : undefined,
              workProductEntryRefs: Array.isArray(options.workProductEntryRef)
                ? options.workProductEntryRef.map(String)
                : undefined,
              objectiveStateSnapshotRefs: Array.isArray(options.objectiveStateSnapshotRef)
                ? options.objectiveStateSnapshotRef.map(String)
                : undefined,
            },
          });
          console.log(JSON.stringify({ wrote: filePath !== null, filePath }, null, 2));
          console.log("OK");
        });

      cmd
        .command("commitment-set-state")
        .description("Transition an existing commitment ledger entry when commitment lifecycle is enabled")
        .requiredOption("--entry-id <entryId>", "Commitment entry id")
        .requiredOption("--state <state>", "Next state (open|fulfilled|cancelled|expired)")
        .requiredOption("--changed-at <changedAt>", "ISO timestamp for the lifecycle transition")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const entry = await runCommitmentSetStateCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            commitmentLedgerEnabled: orchestrator.config.commitmentLedgerEnabled,
            commitmentLifecycleEnabled: orchestrator.config.commitmentLifecycleEnabled,
            entryId: String(options.entryId ?? ""),
            nextState: String(options.state ?? "") as CommitmentLedgerEntry["state"],
            changedAt: String(options.changedAt ?? ""),
          });
          console.log(JSON.stringify({ updated: entry !== null, entry }, null, 2));
          console.log("OK");
        });

      cmd
        .command("commitment-lifecycle-run")
        .description("Apply overdue-expiry and resolved-entry cleanup to the commitment ledger")
        .option("--now <now>", "Override the lifecycle timestamp for testing or backfills")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runCommitmentLifecycleCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            commitmentLedgerDir: orchestrator.config.commitmentLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            commitmentLedgerEnabled: orchestrator.config.commitmentLedgerEnabled,
            commitmentLifecycleEnabled: orchestrator.config.commitmentLifecycleEnabled,
            commitmentDecayDays: orchestrator.config.commitmentDecayDays,
            now: typeof options.now === "string" ? options.now : undefined,
          });
          console.log(JSON.stringify({ applied: result !== null, result }, null, 2));
          console.log("OK");
        });

      cmd
        .command("work-product-status")
        .description("Show work-product ledger status, entry counts, and the latest recorded work product")
        .action(async () => {
          const status = await runWorkProductStatusCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            workProductLedgerDir: orchestrator.config.workProductLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("work-product-record")
        .description("Record a work-product ledger entry when creation-memory is enabled")
        .requiredOption("--entry-id <entryId>", "Ledger entry id")
        .requiredOption("--recorded-at <recordedAt>", "ISO timestamp for the entry")
        .requiredOption("--session-key <sessionKey>", "Session key that created the work product")
        .requiredOption("--source <source>", "Entry source (tool_result|cli|system|manual)")
        .requiredOption("--kind <kind>", "Entry kind (artifact|file|record|report|workspace)")
        .requiredOption(
          "--entry-action <entryAction>",
          "Entry action (created|updated|deleted|referenced|published)",
        )
        .requiredOption("--scope <scope>", "Primary scope or identifier for the created work product")
        .requiredOption("--summary <summary>", "Human-readable summary of the work product")
        .option("--artifact-path <artifactPath>", "Optional path to the created artifact")
        .option("--tag <tag...>", "Tags to attach to the work-product entry")
        .option("--entity-ref <entityRef...>", "Entity refs to attach to the work-product entry")
        .option(
          "--objective-state-snapshot-ref <objectiveStateSnapshotRef...>",
          "Objective-state snapshot refs to link to this work product",
        )
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const filePath = await runWorkProductRecordCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            workProductLedgerDir: orchestrator.config.workProductLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            entry: {
              schemaVersion: 1,
              entryId: String(options.entryId ?? ""),
              recordedAt: String(options.recordedAt ?? ""),
              sessionKey: String(options.sessionKey ?? ""),
              source: String(options.source ?? "") as WorkProductLedgerEntry["source"],
              kind: String(options.kind ?? "") as WorkProductLedgerEntry["kind"],
              action: String(options.entryAction ?? "") as WorkProductLedgerEntry["action"],
              scope: String(options.scope ?? ""),
              summary: String(options.summary ?? ""),
              artifactPath: typeof options.artifactPath === "string" ? options.artifactPath : undefined,
              tags: Array.isArray(options.tag) ? options.tag.map(String) : undefined,
              entityRefs: Array.isArray(options.entityRef) ? options.entityRef.map(String) : undefined,
              objectiveStateSnapshotRefs: Array.isArray(options.objectiveStateSnapshotRef)
                ? options.objectiveStateSnapshotRef.map(String)
                : undefined,
            },
          });
          console.log(JSON.stringify({ wrote: filePath !== null, filePath }, null, 2));
          console.log("OK");
        });

      cmd
        .command("work-product-recall-search")
        .description("Preview work-product recovery candidates when creation-memory recall is enabled")
        .argument("<query>", "Prompt-like query to evaluate against the work-product ledger")
        .option("--max-results <count>", "Maximum number of work-product results to return", "3")
        .option("--session-key <sessionKey>", "Optional session key to boost same-session work products")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const maxResults = typeof options.maxResults === "string"
            ? Number.parseInt(options.maxResults, 10)
            : 3;
          const results = await runWorkProductRecallSearchCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            workProductLedgerDir: orchestrator.config.workProductLedgerDir,
            creationMemoryEnabled: orchestrator.config.creationMemoryEnabled,
            workProductRecallEnabled: orchestrator.config.workProductRecallEnabled,
            query,
            maxResults: Number.isFinite(maxResults) ? maxResults : 3,
            sessionKey: typeof options.sessionKey === "string" ? options.sessionKey : undefined,
          });
          console.log(JSON.stringify(results, null, 2));
          console.log("OK");
        });

      cmd
        .command("trust-zone-promote")
        .description("Dry-run or apply a trust-zone promotion with provenance enforcement")
        .requiredOption("--record-id <recordId>", "Source trust-zone record id")
        .requiredOption("--target-zone <targetZone>", "Promotion target zone (working|trusted)")
        .requiredOption("--reason <reason>", "Human-readable promotion reason")
        .option("--recorded-at <isoTimestamp>", "Promotion timestamp (defaults to now)")
        .option("--summary <summary>", "Optional replacement summary for the promoted record")
        .option("--dry-run", "Show the promotion plan without writing the promoted record")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runTrustZonePromoteCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            trustZoneStoreDir: orchestrator.config.trustZoneStoreDir,
            trustZonesEnabled: orchestrator.config.trustZonesEnabled,
            quarantinePromotionEnabled: orchestrator.config.quarantinePromotionEnabled,
            memoryPoisoningDefenseEnabled: orchestrator.config.memoryPoisoningDefenseEnabled,
            sourceRecordId: String(options.recordId ?? ""),
            targetZone: String(options.targetZone ?? "") as TrustZoneName,
            promotionReason: String(options.reason ?? ""),
            recordedAt: typeof options.recordedAt === "string" ? options.recordedAt : undefined,
            summary: typeof options.summary === "string" ? options.summary : undefined,
            dryRun: options.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("verified-recall-search")
        .description("Preview verified episodic recall over recent memory boxes")
        .argument("<query>", "Prompt-like query to evaluate against verified episodic recall")
        .option("--max-results <count>", "Maximum number of verified episodic results to return", "3")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const maxResults = typeof options.maxResults === "string"
            ? Number.parseInt(options.maxResults, 10)
            : 3;
          const results = await runVerifiedRecallSearchCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            verifiedRecallEnabled: orchestrator.config.verifiedRecallEnabled,
            query,
            maxResults: Number.isFinite(maxResults) ? maxResults : 3,
            boxRecallDays: orchestrator.config.boxRecallDays,
          });
          console.log(JSON.stringify(results, null, 2));
          console.log("OK");
        });

      cmd
        .command("semantic-rule-promote")
        .description("Promote an explicit IF/THEN rule from a verified episodic memory")
        .requiredOption("--memory-id <memoryId>", "Verified episodic memory id to promote from")
        .option("--dry-run", "Preview the promoted semantic rule without writing it")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runSemanticRulePromoteCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            semanticRulePromotionEnabled: orchestrator.config.semanticRulePromotionEnabled,
            sourceMemoryId: String(options.memoryId ?? ""),
            dryRun: options.dryRun === true,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("semantic-rule-verify")
        .description("Preview verified semantic-rule recall with provenance-aware confidence downgrades")
        .argument("<query>", "Prompt-like query to evaluate against verified semantic-rule recall")
        .option("--max-results <count>", "Maximum number of verified semantic rules to return", "3")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const maxResults = typeof options.maxResults === "string"
            ? Number.parseInt(options.maxResults, 10)
            : 3;
          const results = await runSemanticRuleVerifyCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            semanticRuleVerificationEnabled: orchestrator.config.semanticRuleVerificationEnabled,
            query,
            maxResults: Number.isFinite(maxResults) ? maxResults : 3,
          });
          console.log(JSON.stringify(results, null, 2));
          console.log("OK");
        });

      cmd
        .command("conversation-index-health")
        .description("Show conversation index backend health and index stats")
        .action(async () => {
          const health = await runConversationIndexHealthCliCommand(orchestrator);
          console.log(JSON.stringify(health, null, 2));
          console.log("OK");
        });

      cmd
        .command("graph-health")
        .description("Show graph edge-file integrity, node coverage, and corruption counts")
        .option("--repair-guidance", "Include non-destructive repair guidance")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const report = await runGraphHealthCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            entityGraphEnabled: orchestrator.config.entityGraphEnabled,
            timeGraphEnabled: orchestrator.config.timeGraphEnabled,
            causalGraphEnabled: orchestrator.config.causalGraphEnabled,
            includeRepairGuidance: options.repairGuidance === true,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("session-check")
        .description("Analyze transcript/checkpoint continuity integrity without mutating files")
        .action(async () => {
          const report = await runSessionCheckCliCommand({
            memoryDir: orchestrator.config.memoryDir,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("session-repair")
        .description("Generate/apply bounded Engram session integrity repairs (dry-run by default)")
        .option("--apply", "Apply repairs (default: dry-run)")
        .option("--dry-run", "Force dry-run output")
        .option("--allow-session-file-repair", "Allow explicit OpenClaw session-file repair path (still no automatic rewiring)")
        .option("--session-files-dir <path>", "Optional OpenClaw session files directory for guarded repair workflow")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runSessionRepairCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            apply: options.apply === true,
            dryRun: options.dryRun === true,
            allowSessionFileRepair: options.allowSessionFileRepair === true,
            sessionFilesDir:
              typeof options.sessionFilesDir === "string" && options.sessionFilesDir.trim().length > 0
                ? options.sessionFilesDir.trim()
                : undefined,
          });
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("tier-status")
        .description("Show tier migration telemetry and last-cycle summary")
        .action(async () => {
          const status = await runTierStatusCliCommand(orchestrator);
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("tier-migrate")
        .description("Run one tier migration pass (dry-run by default)")
        .option("--dry-run", "Evaluate and report moves without writing")
        .option("--write", "Apply migration writes (default: dry-run)")
        .option("--limit <n>", "Override migration move limit for this run")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const limitRaw = parseInt(String(options.limit ?? ""), 10);
          const explicitDryRun = options.dryRun === true;
          const summary = await runTierMigrateCliCommand(orchestrator, {
            dryRun: explicitDryRun || options.write !== true,
            limit: Number.isFinite(limitRaw) ? Math.max(0, limitRaw) : undefined,
          });
          console.log(JSON.stringify(summary, null, 2));
          console.log("OK");
        });

      cmd
        .command("policy-status")
        .description("Show runtime behavior-loop policy status and top contributing signals")
        .action(async () => {
          const status = await runPolicyStatusCliCommand(orchestrator);
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("policy-diff")
        .description("Show runtime policy deltas and evidence since a relative duration (default: 7d)")
        .option("--since <window>", "Relative duration window like 30m, 12h, 7d", "7d")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const since = typeof options.since === "string" ? options.since : "7d";
          const report = await runPolicyDiffCliCommand(orchestrator, { since });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("policy-rollback")
        .description("Roll back runtime behavior policy to the previous snapshot")
        .action(async () => {
          const report = await runPolicyRollbackCliCommand(orchestrator);
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      const migrateCmd = cmd
        .command("migrate")
        .description("Run memory migration helpers (dry-run by default)");

      migrateCmd
        .command("normalize-frontmatter")
        .description("Normalize memory frontmatter serialization")
        .option("--write", "Apply frontmatter rewrites (default: dry-run)")
        .option("--limit <n>", "Maximum memories to scan", "200")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const limitRaw = parseInt(String(options.limit ?? "200"), 10);
          const report = await runMigrateNormalizeFrontmatterCliCommand(orchestrator, {
            write: options.write === true,
            limit: Number.isFinite(limitRaw) ? limitRaw : 200,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      migrateCmd
        .command("rescore-importance")
        .description("Recompute memory importance scores using current local heuristics")
        .option("--write", "Apply frontmatter updates (default: dry-run)")
        .option("--limit <n>", "Maximum memories to scan", "200")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const limitRaw = parseInt(String(options.limit ?? "200"), 10);
          const report = await runMigrateRescoreImportanceCliCommand(orchestrator, {
            write: options.write === true,
            limit: Number.isFinite(limitRaw) ? limitRaw : 200,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      migrateCmd
        .command("rechunk")
        .description("Rebuild chunk files from current chunking heuristics")
        .option("--write", "Apply chunk rewrites (default: dry-run)")
        .option("--limit <n>", "Maximum parent memories to scan", "200")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const limitRaw = parseInt(String(options.limit ?? "200"), 10);
          const report = await runMigrateRechunkCliCommand(orchestrator, {
            write: options.write === true,
            limit: Number.isFinite(limitRaw) ? limitRaw : 200,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      migrateCmd
        .command("reextract")
        .description("Queue bounded memory re-extraction jobs for an explicit model")
        .option("--model <id>", "Model id used for re-extraction request")
        .option("--write", "Queue re-extraction jobs (default: dry-run)")
        .option("--limit <n>", "Maximum memories to queue", "100")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const model = typeof options.model === "string" ? options.model : "";
          const limitRaw = parseInt(String(options.limit ?? "100"), 10);
          const report = await runMigrateReextractCliCommand(orchestrator, {
            model,
            write: options.write === true,
            limit: Number.isFinite(limitRaw) ? limitRaw : 100,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("action-audit")
        .description("Show namespace-aware memory action policy outcomes")
        .option("--namespace <name>", "Filter to a single namespace")
        .option("--limit <n>", "Max events to read per namespace", "200")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const limitRaw = parseInt(String(options.limit ?? "200"), 10);
          const report = await runMemoryActionAuditCliCommand(orchestrator, {
            namespace:
              typeof options.namespace === "string" && options.namespace.trim().length > 0
                ? options.namespace.trim()
                : undefined,
            limit: Number.isFinite(limitRaw) ? Math.max(0, limitRaw) : 200,
          });
          console.log(JSON.stringify(report, null, 2));
          console.log("OK");
        });

      cmd
        .command("tailscale-status")
        .description("Show Tailscale availability and daemon status")
        .option("--timeout-ms <n>", "Command timeout in milliseconds", "10000")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const timeoutMsRaw = parseInt(String(options.timeoutMs ?? "10000"), 10);
          const status = await runTailscaleStatusCliCommand({
            timeoutMs: Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 10_000,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("tailscale-sync")
        .description("Sync a local memory directory to a Tailscale destination using rsync")
        .option("--source-dir <path>", "Source directory to sync")
        .option("--destination <target>", "Rsync destination (for example host:/path)")
        .option("--delete", "Delete destination entries that do not exist in source")
        .option("--dry-run", "Show what would change without writing")
        .option("--extra-args <csv>", "Additional rsync args as comma-separated values")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const sourceDir = typeof options.sourceDir === "string" ? options.sourceDir.trim() : "";
          const destination = typeof options.destination === "string" ? options.destination.trim() : "";
          if (!sourceDir) {
            throw new Error("missing --source-dir");
          }
          if (!destination) {
            throw new Error("missing --destination");
          }
          const extraArgs = typeof options.extraArgs === "string"
            ? options.extraArgs
                .split(",")
                .map((value) => value.trim())
                .filter((value) => value.length > 0)
            : undefined;

          await runTailscaleSyncCliCommand({
            sourceDir,
            destination,
            delete: options.delete === true,
            dryRun: options.dryRun === true,
            extraArgs,
          });
          console.log("OK");
        });

      cmd
        .command("webdav-serve")
        .description("Start local WebDAV service for allowlisted directories")
        .option("--allowlist <csv>", "Comma-separated directories to expose")
        .option("--host <host>", "Bind host", "127.0.0.1")
        .option("--port <n>", "Bind port", "8080")
        .option("--username <username>", "Optional basic auth username")
        .option("--password <password>", "Optional basic auth password")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const allowlistRaw = typeof options.allowlist === "string" ? options.allowlist : "";
          const allowlistDirs = allowlistRaw
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
          if (allowlistDirs.length === 0) {
            throw new Error("missing --allowlist");
          }
          const portRaw = parseInt(String(options.port ?? "8080"), 10);
          const status = await runWebDavServeCliCommand({
            allowlistDirs,
            host: typeof options.host === "string" ? options.host : "127.0.0.1",
            port: Number.isFinite(portRaw) ? portRaw : 8080,
            authUsername: typeof options.username === "string" ? options.username : undefined,
            authPassword: typeof options.password === "string" ? options.password : undefined,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      cmd
        .command("webdav-stop")
        .description("Stop the in-process WebDAV service")
        .action(async () => {
          const result = await runWebDavStopCliCommand();
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      const dashboardCmd = cmd
        .command("dashboard")
        .description("Manage live graph dashboard service");

      dashboardCmd
        .command("start")
        .description("Start dashboard server (localhost by default)")
        .option("--host <host>", "Bind host", "127.0.0.1")
        .option("--port <n>", "Bind port", "4319")
        .option("--public-dir <path>", "Override static dashboard assets path")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const portRaw = parseInt(String(options.port ?? "4319"), 10);
          const status = await runDashboardStartCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            host: typeof options.host === "string" ? options.host : "127.0.0.1",
            port: Number.isFinite(portRaw) ? portRaw : 4319,
            publicDir: typeof options.publicDir === "string" ? options.publicDir : undefined,
          });
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      dashboardCmd
        .command("stop")
        .description("Stop dashboard server")
        .action(async () => {
          const result = await runDashboardStopCliCommand();
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      dashboardCmd
        .command("status")
        .description("Show dashboard server status")
        .action(async () => {
          const status = await runDashboardStatusCliCommand();
          console.log(JSON.stringify(status, null, 2));
          console.log("OK");
        });

      const routeCmd = cmd
        .command("route")
        .description("Manage custom memory routing rules");

      routeCmd
        .command("list")
        .description("List configured routing rules")
        .action(async () => {
          const rules = await runRouteCliCommand({
            action: "list",
            memoryDir: orchestrator.config.memoryDir,
            stateFile: orchestrator.config.routingRulesStateFile,
          }) as RouteRule[];

          if (rules.length === 0) {
            console.log("No routing rules configured.");
            return;
          }
          for (const rule of rules) {
            const targetParts = [
              rule.target.category ? `category=${rule.target.category}` : "",
              rule.target.namespace ? `namespace=${rule.target.namespace}` : "",
            ].filter((value) => value.length > 0);
            console.log(
              `${rule.id} type=${rule.patternType} priority=${rule.priority} pattern="${rule.pattern}" target=${targetParts.join(",")}`,
            );
          }
        });

      routeCmd
        .command("add")
        .description("Add or update a routing rule")
        .argument("<pattern>", "Keyword or regex pattern")
        .argument("<target>", "Target (JSON or category=<cat>,namespace=<ns>)")
        .option("--type <type>", "Pattern type: keyword|regex", "keyword")
        .option("--priority <n>", "Rule priority", "0")
        .option("--id <id>", "Optional stable rule id")
        .action(async (...args: unknown[]) => {
          const pattern = typeof args[0] === "string" ? args[0] : "";
          const targetRaw = typeof args[1] === "string" ? args[1] : "";
          const options = (args[2] ?? {}) as Record<string, unknown>;
          const patternTypeRaw = typeof options.type === "string" ? options.type.trim().toLowerCase() : "keyword";
          if (!isRoutePatternType(patternTypeRaw)) {
            throw new Error(`invalid route pattern type: ${patternTypeRaw}`);
          }
          const priorityInput = String(options.priority ?? "0").trim();
          if (!/^-?\d+$/.test(priorityInput)) {
            throw new Error(`invalid route priority: ${priorityInput}`);
          }
          const priorityRaw = Number(priorityInput);
          const updated = await runRouteCliCommand({
            action: "add",
            memoryDir: orchestrator.config.memoryDir,
            stateFile: orchestrator.config.routingRulesStateFile,
            pattern,
            patternType: patternTypeRaw,
            priority: priorityRaw,
            targetRaw,
            id: typeof options.id === "string" ? options.id : undefined,
          }) as RouteRule[];
          console.log(`OK (${updated.length} rules)`);
        });

      routeCmd
        .command("remove")
        .description("Remove routing rules by exact pattern")
        .argument("<pattern>", "Pattern to remove")
        .action(async (...args: unknown[]) => {
          const pattern = typeof args[0] === "string" ? args[0] : "";
          const next = await runRouteCliCommand({
            action: "remove",
            memoryDir: orchestrator.config.memoryDir,
            stateFile: orchestrator.config.routingRulesStateFile,
            pattern,
          }) as RouteRule[];
          console.log(`OK (${next.length} rules remain)`);
        });

      routeCmd
        .command("test")
        .description("Test routing rule match for input text")
        .argument("<text>", "Text to evaluate")
        .action(async (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : "";
          const selection = await runRouteCliCommand({
            action: "test",
            memoryDir: orchestrator.config.memoryDir,
            stateFile: orchestrator.config.routingRulesStateFile,
            text,
          }) as { rule: RouteRule; target: RouteTarget } | null;
          if (!selection) {
            console.log("No route match.");
            return;
          }
          const targetParts = [
            selection.target.category ? `category=${selection.target.category}` : "",
            selection.target.namespace ? `namespace=${selection.target.namespace}` : "",
          ].filter((value) => value.length > 0);
          console.log(
            `Matched ${selection.rule.id} type=${selection.rule.patternType} priority=${selection.rule.priority} target=${targetParts.join(",")}`,
          );
        });

      cmd
        .command("archive-observations")
        .description("Archive aged observation artifacts (dry-run by default)")
        .option("--retention-days <n>", "Archive files older than N days", "30")
        .option("--write", "Apply archive mutations (default: dry-run)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const retentionDays = parseInt(String(options.retentionDays ?? "30"), 10);
          const result = await runArchiveObservationsCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            retentionDays: Number.isFinite(retentionDays) ? retentionDays : 30,
            write: options.write === true,
          });

          console.log(`Dry run: ${result.dryRun ? "yes" : "no"}`);
          console.log(`Retention days: ${result.retentionDays}`);
          console.log(`Scanned files: ${result.scannedFiles}`);
          console.log(`Archived files: ${result.archivedFiles}`);
          console.log(`Archived bytes: ${result.archivedBytes}`);
          if (result.archivedRelativePaths.length > 0) {
            console.log("Archived paths:");
            for (const relPath of result.archivedRelativePaths.slice(0, 20)) {
              console.log(`  - ${relPath}`);
            }
            if (result.archivedRelativePaths.length > 20) {
              console.log(`  ... and ${result.archivedRelativePaths.length - 20} more`);
            }
          }
          console.log("OK");
        });

      cmd
        .command("rebuild-observations")
        .description("Rebuild observation ledger from transcript history (dry-run by default)")
        .option("--write", "Write rebuilt ledger (default: dry-run)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runRebuildObservationsCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            write: options.write === true,
          });

          console.log(`Dry run: ${result.dryRun ? "yes" : "no"}`);
          console.log(`Scanned transcript files: ${result.scannedFiles}`);
          console.log(`Parsed turns: ${result.parsedTurns}`);
          console.log(`Malformed lines: ${result.malformedLines}`);
          console.log(`Rebuilt rows: ${result.rebuiltRows}`);
          console.log(`Output path: ${result.outputPath}`);
          if (result.backupPath) console.log(`Backup path: ${result.backupPath}`);
          console.log("OK");
        });

      cmd
        .command("migrate-observations")
        .description("Migrate legacy observation ledgers into rebuilt format (dry-run by default)")
        .option("--write", "Write migrated ledger (default: dry-run)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const result = await runMigrateObservationsCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            write: options.write === true,
          });

          console.log(`Dry run: ${result.dryRun ? "yes" : "no"}`);
          console.log(`Scanned legacy files: ${result.scannedFiles}`);
          console.log(`Parsed rows: ${result.parsedRows}`);
          console.log(`Malformed lines: ${result.malformedLines}`);
          console.log(`Migrated rows: ${result.migratedRows}`);
          if (result.sourceRelativePaths.length > 0) {
            console.log("Source files:");
            for (const relPath of result.sourceRelativePaths) {
              console.log(`  - ${relPath}`);
            }
          }
          console.log(`Output path: ${result.outputPath}`);
          if (result.backupPath) console.log(`Backup path: ${result.backupPath}`);
          console.log("OK");
        });

      cmd
        .command("task")
        .description("Manage work tasks")
        .argument("<action>", "create|get|list|update|transition|delete|link")
        .option("--id <id>", "Task ID")
        .option("--title <title>", "Task title")
        .option("--description <description>", "Task description")
        .option("--status <status>", "Task status")
        .option("--priority <priority>", "Task priority")
        .option("--owner <owner>", "Task owner")
        .option("--assignee <assignee>", "Task assignee")
        .option("--project-id <projectId>", "Project ID")
        .option("--tags <csv>", "Comma-separated tags")
        .option("--due-at <iso>", "Due timestamp (ISO)")
        .action(async (...args: unknown[]) => {
          const actionRaw = typeof args[0] === "string" ? args[0].trim().toLowerCase() : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const statusOptRaw = typeof options.status === "string" ? options.status.trim().toLowerCase() : undefined;
          const priorityOptRaw = typeof options.priority === "string" ? options.priority.trim().toLowerCase() : undefined;
          if (statusOptRaw !== undefined && !isWorkTaskStatus(statusOptRaw)) {
            throw new Error(`invalid task status: ${statusOptRaw}`);
          }
          if (priorityOptRaw !== undefined && !isWorkTaskPriority(priorityOptRaw)) {
            throw new Error(`invalid task priority: ${priorityOptRaw}`);
          }

          const patch: WorkTaskPatchInput = {};
          if (typeof options.title === "string") patch.title = options.title.trim();
          if (typeof options.description === "string") patch.description = options.description.trim();
          if (statusOptRaw !== undefined) patch.status = statusOptRaw;
          if (priorityOptRaw !== undefined) patch.priority = priorityOptRaw;
          if (typeof options.owner === "string") patch.owner = normalizeNullableCliValue(options.owner) ?? null;
          if (typeof options.assignee === "string") patch.assignee = normalizeNullableCliValue(options.assignee) ?? null;
          if (typeof options.projectId === "string") patch.projectId = normalizeNullableCliValue(options.projectId) ?? null;
          if (typeof options.tags === "string") {
            patch.tags = parseTagsCsv(options.tags, true);
          }
          if (typeof options.dueAt === "string") patch.dueAt = normalizeNullableCliValue(options.dueAt) ?? null;

          const result = await runWorkTaskCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            action: actionRaw as WorkTaskCliCommandOptions["action"],
            id: typeof options.id === "string" ? options.id : undefined,
            title: typeof options.title === "string" ? options.title : undefined,
            description: typeof options.description === "string" ? options.description : undefined,
            status: statusOptRaw,
            priority: priorityOptRaw,
            owner: typeof options.owner === "string" ? options.owner : undefined,
            assignee: typeof options.assignee === "string" ? options.assignee : undefined,
            projectId: typeof options.projectId === "string" ? options.projectId : undefined,
            tags: typeof options.tags === "string"
              ? parseTagsCsv(options.tags, true)
              : undefined,
            dueAt: typeof options.dueAt === "string" ? options.dueAt : undefined,
            patch,
          });

          if (Array.isArray(result)) {
            console.log(`Count: ${result.length}`);
          }
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("project")
        .description("Manage work projects")
        .argument("<action>", "create|get|list|update|delete")
        .option("--id <id>", "Project ID")
        .option("--name <name>", "Project name")
        .option("--description <description>", "Project description")
        .option("--status <status>", "Project status")
        .option("--owner <owner>", "Project owner")
        .option("--tags <csv>", "Comma-separated tags")
        .action(async (...args: unknown[]) => {
          const actionRaw = typeof args[0] === "string" ? args[0].trim().toLowerCase() : "";
          const options = (args[1] ?? {}) as Record<string, unknown>;
          const statusOptRaw = typeof options.status === "string" ? options.status.trim().toLowerCase() : undefined;
          if (statusOptRaw !== undefined && !isWorkProjectStatus(statusOptRaw)) {
            throw new Error(`invalid project status: ${statusOptRaw}`);
          }

          const patch: WorkProjectPatchInput = {};
          if (typeof options.name === "string") patch.name = options.name.trim();
          if (typeof options.description === "string") patch.description = options.description.trim();
          if (statusOptRaw !== undefined) patch.status = statusOptRaw;
          if (typeof options.owner === "string") patch.owner = normalizeNullableCliValue(options.owner) ?? null;
          if (typeof options.tags === "string") {
            patch.tags = parseTagsCsv(options.tags, true);
          }

          const result = await runWorkProjectCliCommand({
            memoryDir: orchestrator.config.memoryDir,
            action: actionRaw as WorkProjectCliCommandOptions["action"],
            id: typeof options.id === "string" ? options.id : undefined,
            name: typeof options.name === "string" ? options.name : undefined,
            description: typeof options.description === "string" ? options.description : undefined,
            status: statusOptRaw,
            owner: typeof options.owner === "string" ? options.owner : undefined,
            tags: typeof options.tags === "string"
              ? parseTagsCsv(options.tags, true)
              : undefined,
            patch,
          });

          if (Array.isArray(result)) {
            console.log(`Count: ${result.length}`);
          }
          console.log(JSON.stringify(result, null, 2));
          console.log("OK");
        });

      cmd
        .command("dedupe-exact")
        .description("Delete exact duplicate memory entries (same body text), keeping highest-confidence/newest copy")
        .option("--dry-run", "Show what would be deleted without deleting files")
        .option("--namespace <ns>", "Namespace to dedupe (v3.0+, default: config defaultNamespace)", "")
        .option("--qmd-sync", "Run QMD update/embed after deletions (default: off)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const dryRun = options.dryRun === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          const qmdSync = options.qmdSync === true;

          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);
          const memories = await readAllMemoryFiles(memoryDir);
          const plan = planExactDuplicateDeletions(memories);

          console.log(`Scanned ${memories.length} memory files in ${memoryDir}`);
          console.log(`Duplicate groups: ${plan.groups}`);
          console.log(`Duplicate files to delete: ${plan.deletePaths.length}`);

          if (plan.deletePaths.length === 0) {
            console.log("No exact duplicates found.");
            return;
          }

          if (dryRun) {
            console.log("Dry run enabled. No files deleted.");
            for (const filePath of plan.deletePaths.slice(0, 50)) {
              console.log(`  - ${filePath}`);
            }
            if (plan.deletePaths.length > 50) {
              console.log(`  ... and ${plan.deletePaths.length - 50} more`);
            }
            return;
          }

          let deleted = 0;
          for (const filePath of plan.deletePaths) {
            try {
              await unlink(filePath);
              deleted += 1;
            } catch (err) {
              console.log(`  failed to delete ${filePath}: ${String(err)}`);
            }
          }
          console.log(`Deleted ${deleted}/${plan.deletePaths.length} duplicate files.`);

          if (qmdSync) {
            await orchestrator.qmd.probe();
            if (orchestrator.qmd.isAvailable()) {
              await orchestrator.qmd.update();
              await orchestrator.qmd.embed();
              console.log("QMD sync complete.");
            } else {
              console.log(`QMD unavailable in this process; skipped sync. Status: ${orchestrator.qmd.debugStatus()}`);
            }
          }
        });

      cmd
        .command("dedupe-aggressive")
        .description(
          "Delete aggressively-normalized duplicate memory entries (formatting/case/punctuation-insensitive)",
        )
        .option("--dry-run", "Show what would be deleted without deleting files")
        .option("--namespace <ns>", "Namespace to dedupe (v3.0+, default: config defaultNamespace)", "")
        .option("--qmd-sync", "Run QMD update/embed after deletions (default: off)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const dryRun = options.dryRun === true;
          const namespace = options.namespace ? String(options.namespace) : "";
          const qmdSync = options.qmdSync === true;

          const memoryDir = await resolveMemoryDirForNamespace(orchestrator, namespace);
          const memories = await readAllMemoryFiles(memoryDir);
          const plan = planAggressiveDuplicateDeletions(memories);

          console.log(`Scanned ${memories.length} memory files in ${memoryDir}`);
          console.log(`Duplicate groups: ${plan.groups}`);
          console.log(`Duplicate files to delete: ${plan.deletePaths.length}`);

          if (plan.deletePaths.length === 0) {
            console.log("No aggressive duplicates found.");
            return;
          }

          if (dryRun) {
            console.log("Dry run enabled. No files deleted.");
            for (const filePath of plan.deletePaths.slice(0, 50)) {
              console.log(`  - ${filePath}`);
            }
            if (plan.deletePaths.length > 50) {
              console.log(`  ... and ${plan.deletePaths.length - 50} more`);
            }
            return;
          }

          let deleted = 0;
          for (const filePath of plan.deletePaths) {
            try {
              await unlink(filePath);
              deleted += 1;
            } catch (err) {
              console.log(`  failed to delete ${filePath}: ${String(err)}`);
            }
          }
          console.log(`Deleted ${deleted}/${plan.deletePaths.length} duplicate files.`);

          if (qmdSync) {
            await orchestrator.qmd.probe();
            if (orchestrator.qmd.isAvailable()) {
              await orchestrator.qmd.update();
              await orchestrator.qmd.embed();
              console.log("QMD sync complete.");
            } else {
              console.log(`QMD unavailable in this process; skipped sync. Status: ${orchestrator.qmd.debugStatus()}`);
            }
          }
        });

      cmd
        .command("search")
        .argument("<query>", "Search query")
        .option("-n, --max-results <number>", "Max results", "8")
        .description("Search memories via QMD")
        .action(async (...args: unknown[]) => {
          const query = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
          const options = (args[1] ?? {}) as Record<string, string>;
          const maxResults = parseInt(options.maxResults ?? "8", 10);
          if (!query) {
            console.log("Missing query. Usage: openclaw engram search <query>");
            return;
          }

          // Probe in this CLI process before availability check.
          await orchestrator.qmd.probe();

          if (orchestrator.qmd.isAvailable()) {
            const results = await orchestrator.qmd.search(
              query,
              undefined,
              maxResults,
            );
            if (results.length === 0) {
              console.log(`No results for: "${query}"`);
              return;
            }
            console.log(`\n=== Memory Search: "${query}" ===\n`);
            for (const r of results) {
              console.log(`  ${r.path} (score: ${r.score.toFixed(3)})`);
              if (r.snippet) {
                console.log(
                  `    ${r.snippet.slice(0, 150).replace(/\n/g, " ")}`,
                );
              }
              console.log();
            }
          } else {
            // Fallback: search filenames
            const memories = await orchestrator.storage.readAllMemories();
            const lowerQuery = query.toLowerCase();
            const matches = memories.filter(
              (m) =>
                m.content.toLowerCase().includes(lowerQuery) ||
                m.frontmatter.tags.some((t) => t.includes(lowerQuery)),
            );
            const qmdStatus = orchestrator.qmd.debugStatus();
            if (matches.length === 0) {
              console.log(
                `No results for: "${query}" (QMD unavailable in this CLI process; text search fallback).`,
              );
              console.log(`QMD status: ${qmdStatus}`);
              return;
            }
            console.log(`\n=== Text Search Fallback: "${query}" (${matches.length} results) ===\n`);
            console.log(`QMD status: ${qmdStatus}\n`);
            for (const m of matches.slice(0, maxResults)) {
              console.log(`  [${m.frontmatter.category}] ${m.content.slice(0, 120)}`);
            }
          }
        });

      cmd
        .command("profile")
        .description("Show current user profile")
        .action(async () => {
          const profile = await orchestrator.storage.readProfile();
          if (!profile) {
            console.log("No profile built yet.");
            return;
          }
          console.log(profile);
        });

      cmd
        .command("entities")
        .description("List all tracked entities")
        .action(async () => {
          const entities = await orchestrator.storage.readEntities();
          if (entities.length === 0) {
            console.log("No entities tracked yet.");
            return;
          }
          console.log(`=== Entities (${entities.length}) ===\n`);
          for (const e of entities) {
            console.log(`  - ${e}`);
          }
        });

      cmd
        .command("extract")
        .description("Force extraction of buffered turns")
        .action(async () => {
          await orchestrator.buffer.load();
          const turns = orchestrator.buffer.getTurns();
          if (turns.length === 0) {
            console.log("Buffer is empty. Nothing to extract.");
            return;
          }
          console.log(`Extracting ${turns.length} buffered turns...`);
          // Trigger extraction by processing a dummy turn that forces extraction
          // Actually we need to call the internal extraction method
          // For now, inform the user
          console.log(
            "Use the memory system in conversation to trigger extraction, or wait for the buffer threshold.",
          );
        });

      cmd
        .command("bootstrap")
        .description("Scan transcript history and seed memory from high-signal past turns")
        .option("--dry-run", "Scan and report without writing memories")
        .option("--sessions-dir <path>", "Override transcript sessions directory")
        .option("--limit <number>", "Maximum sessions to process")
        .option("--since <date>", "Only process turns after date (YYYY-MM-DD or ISO)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const dryRun = options.dryRun === true;
          const sessionsDir = options.sessionsDir ? String(options.sessionsDir) : undefined;
          const limitRaw = options.limit ? Number(options.limit) : undefined;
          const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.floor(limitRaw)
            : undefined;

          let since: Date | undefined;
          if (options.since) {
            const parsed = new Date(String(options.since));
            if (Number.isNaN(parsed.getTime())) {
              console.log(`Invalid --since value: ${String(options.since)}`);
              return;
            }
            since = parsed;
          }

          console.log("Running bootstrap scan...");
          const result = await orchestrator.runBootstrap({
            dryRun,
            sessionsDir,
            limit,
            since,
          });
          console.log(
            `Bootstrap complete. sessions=${result.sessionsScanned}, turns=${result.turnsProcessed}, highSignal=${result.highSignalTurns}, created=${result.memoriesCreated}, skipped=${result.skipped}`,
          );
        });

      cmd
        .command("consolidate")
        .description("Run memory consolidation immediately")
        .option("--verbose", "Show detailed consolidation stats")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const verbose = options.verbose === true;
          console.log("Running consolidation...");
          const stats = await orchestrator.runConsolidationNow();
          if (verbose) {
            console.log(
              `Consolidation complete. memoriesProcessed=${stats.memoriesProcessed}, merged=${stats.merged}, invalidated=${stats.invalidated}`,
            );
          } else {
            console.log(`Consolidation complete. merged=${stats.merged}, invalidated=${stats.invalidated}`);
          }
        });

      cmd
        .command("questions")
        .description("List open questions from memory extraction")
        .option("-a, --all", "Show all questions including resolved")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const showAll = options.all === true;
          const questions = await orchestrator.storage.readQuestions({ unresolvedOnly: !showAll });
          if (questions.length === 0) {
            console.log(showAll ? "No questions found." : "No unresolved questions.");
            return;
          }
          console.log(`\n=== Questions (${questions.length}) ===\n`);
          for (const q of questions) {
            const status = q.resolved ? "[RESOLVED]" : `[priority: ${q.priority.toFixed(2)}]`;
            console.log(`  ${q.id} ${status}`);
            console.log(`    ${q.question}`);
            console.log(`    Context: ${q.context}`);
            console.log();
          }
        });

      cmd
        .command("identity")
        .description("Show agent identity reflections")
        .action(async () => {
          const workspaceDir = path.join(process.env.HOME ?? "~", ".openclaw", "workspace");
          const identity = await orchestrator.storage.readIdentity(workspaceDir);
          if (!identity) {
            console.log("No identity file found.");
            return;
          }
          console.log(identity);
        });

      const continuityCmd = cmd
        .command("continuity")
        .description("Identity continuity incident workflow commands");

      continuityCmd
        .command("incidents")
        .description("List continuity incidents")
        .option("--state <state>", "Filter by state: open|closed|all", "open")
        .option("--limit <number>", "Maximum incidents to list", "25")
        .action(async (...args: unknown[]) => {
          if (!orchestrator.config.identityContinuityEnabled) {
            console.log("Identity continuity is disabled.");
            return;
          }
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const stateRaw = String(options.state ?? "open").toLowerCase();
          const state: "open" | "closed" | "all" =
            stateRaw === "closed" || stateRaw === "all" ? stateRaw : "open";
          const limit = Math.max(1, Math.min(200, parseInt(String(options.limit ?? "25"), 10) || 25));
          const filtered = await orchestrator.storage.readContinuityIncidents(limit, state);
          if (filtered.length === 0) {
            console.log(`No continuity incidents found for state=${state}.`);
            return;
          }
          console.log(`=== Continuity Incidents (${filtered.length}, state=${state}) ===\n`);
          for (const incident of filtered) {
            console.log(formatContinuityIncidentCli(incident));
            console.log();
          }
        });

      continuityCmd
        .command("incident-open")
        .description("Open a continuity incident")
        .option("--symptom <text>", "Required symptom description")
        .option("--trigger-window <window>", "Optional incident trigger window")
        .option("--suspected-cause <text>", "Optional suspected cause")
        .action(async (...args: unknown[]) => {
          if (!orchestrator.config.identityContinuityEnabled) {
            console.log("Identity continuity is disabled.");
            return;
          }
          if (!orchestrator.config.continuityIncidentLoggingEnabled) {
            console.log("Continuity incident logging is disabled.");
            return;
          }
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const symptom = String(options.symptom ?? "").trim();
          if (!symptom) {
            console.log("Missing required --symptom.");
            return;
          }
          const created = await orchestrator.storage.appendContinuityIncident({
            symptom,
            triggerWindow: options.triggerWindow ? String(options.triggerWindow) : undefined,
            suspectedCause: options.suspectedCause ? String(options.suspectedCause) : undefined,
          });
          console.log("Opened continuity incident:\n");
          console.log(formatContinuityIncidentCli(created));
        });

      continuityCmd
        .command("incident-close")
        .description("Close a continuity incident")
        .option("--id <id>", "Required incident ID")
        .option("--fix-applied <text>", "Required fix description")
        .option("--verification-result <text>", "Required verification result")
        .option("--preventive-rule <text>", "Optional preventive rule")
        .action(async (...args: unknown[]) => {
          if (!orchestrator.config.identityContinuityEnabled) {
            console.log("Identity continuity is disabled.");
            return;
          }
          if (!orchestrator.config.continuityIncidentLoggingEnabled) {
            console.log("Continuity incident logging is disabled.");
            return;
          }
          const options = (args[0] ?? {}) as Record<string, unknown>;
          const id = String(options.id ?? "").trim();
          const fixApplied = String(options.fixApplied ?? "").trim();
          const verificationResult = String(options.verificationResult ?? "").trim();
          const preventiveRule = options.preventiveRule ? String(options.preventiveRule).trim() : undefined;

          if (!id) {
            console.log("Missing required --id.");
            return;
          }
          if (!fixApplied) {
            console.log("Missing required --fix-applied.");
            return;
          }
          if (!verificationResult) {
            console.log("Missing required --verification-result.");
            return;
          }

          const closed = await orchestrator.storage.closeContinuityIncident(id, {
            fixApplied,
            verificationResult,
            preventiveRule,
          });
          if (!closed) {
            console.log(`Incident not found: ${id}`);
            return;
          }
          console.log("Closed continuity incident:\n");
          console.log(formatContinuityIncidentCli(closed));
        });

      cmd
        .command("access")
        .description("Show memory access statistics")
        .option("-n, --top <number>", "Show top N most accessed", "20")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const top = parseInt(options.top ?? "20", 10);

          const memories = await orchestrator.storage.readAllMemories();
          const withAccess = memories.filter((m) => m.frontmatter.accessCount && m.frontmatter.accessCount > 0);

          if (withAccess.length === 0) {
            console.log("No access tracking data yet. Memories will be tracked as they are retrieved.");
            return;
          }

          // Sort by access count descending
          const sorted = withAccess.sort(
            (a, b) => (b.frontmatter.accessCount ?? 0) - (a.frontmatter.accessCount ?? 0),
          );

          console.log(`\n=== Top ${Math.min(top, sorted.length)} Most Accessed Memories ===\n`);
          for (const m of sorted.slice(0, top)) {
            const lastAccessed = m.frontmatter.lastAccessed
              ? new Date(m.frontmatter.lastAccessed).toLocaleDateString()
              : "unknown";
            console.log(`  ${m.frontmatter.accessCount}x  [${m.frontmatter.category}] ${m.content.slice(0, 80)}`);
            console.log(`       Last accessed: ${lastAccessed}  ID: ${m.frontmatter.id}`);
            console.log();
          }

          // Summary stats
          const totalAccess = withAccess.reduce((sum, m) => sum + (m.frontmatter.accessCount ?? 0), 0);
          console.log(`Total accesses tracked: ${totalAccess}`);
          console.log(`Memories with access data: ${withAccess.length} / ${memories.length}`);
        });

      cmd
        .command("flush-access")
        .description("Flush pending access tracking updates to disk")
        .action(async () => {
          await orchestrator.flushAccessTracking();
          console.log("Access tracking buffer flushed.");
        });

      cmd
        .command("importance")
        .description("Show importance score distribution across memories")
        .option("-l, --level <level>", "Filter by importance level (critical, high, normal, low, trivial)")
        .option("-n, --top <number>", "Show top N memories by importance", "15")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const filterLevel = options.level;
          const top = parseInt(options.top ?? "15", 10);

          const memories = await orchestrator.storage.readAllMemories();
          const withImportance = memories.filter((m) => m.frontmatter.importance);

          if (withImportance.length === 0) {
            console.log("No importance data yet. Importance is scored during extraction.");
            return;
          }

          // Count by level
          const levelCounts: Record<string, number> = {
            critical: 0,
            high: 0,
            normal: 0,
            low: 0,
            trivial: 0,
          };
          for (const m of withImportance) {
            const level = m.frontmatter.importance?.level ?? "normal";
            levelCounts[level] = (levelCounts[level] ?? 0) + 1;
          }

          console.log("\n=== Importance Distribution ===\n");
          for (const [level, count] of Object.entries(levelCounts)) {
            const bar = "█".repeat(Math.min(count, 50));
            console.log(`  ${level.padEnd(10)} ${count.toString().padStart(4)} ${bar}`);
          }
          console.log(`\n  Total scored: ${withImportance.length} / ${memories.length} memories\n`);

          // Filter by level if specified
          let filtered = withImportance;
          if (filterLevel) {
            filtered = withImportance.filter(
              (m) => m.frontmatter.importance?.level === filterLevel,
            );
            if (filtered.length === 0) {
              console.log(`No memories with importance level: ${filterLevel}`);
              return;
            }
          }

          // Sort by importance score descending
          const sorted = filtered.sort(
            (a, b) =>
              (b.frontmatter.importance?.score ?? 0) -
              (a.frontmatter.importance?.score ?? 0),
          );

          const heading = filterLevel
            ? `Top ${Math.min(top, sorted.length)} "${filterLevel}" Importance Memories`
            : `Top ${Math.min(top, sorted.length)} Most Important Memories`;
          console.log(`=== ${heading} ===\n`);

          for (const m of sorted.slice(0, top)) {
            const imp = m.frontmatter.importance!;
            console.log(
              `  ${imp.score.toFixed(2)} [${imp.level}] [${m.frontmatter.category}]`,
            );
            console.log(`    ${m.content.slice(0, 100)}`);
            if (imp.keywords.length > 0) {
              console.log(`    Keywords: ${imp.keywords.join(", ")}`);
            }
            console.log();
          }
        });
      cmd
        .command("topics")
        .description("Show extracted topics from memory corpus")
        .option("-n, --top <number>", "Show top N topics", "20")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const top = parseInt(options.top ?? "20", 10);

          const { topics, updatedAt } = await orchestrator.storage.loadTopics();

          if (topics.length === 0) {
            console.log("No topics extracted yet. Topics are extracted during consolidation.");
            return;
          }

          console.log(`\n=== Top ${Math.min(top, topics.length)} Topics ===`);
          console.log(`Last updated: ${updatedAt ?? "unknown"}\n`);

          for (const topic of topics.slice(0, top)) {
            const bar = "█".repeat(Math.min(Math.round(topic.score * 10), 30));
            console.log(`  ${topic.term.padEnd(20)} ${topic.score.toFixed(3)} (${topic.count}x) ${bar}`);
          }
        });

      cmd
        .command("summaries")
        .description("Show memory summaries")
        .option("-n, --top <number>", "Show top N most recent summaries", "5")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const top = parseInt(options.top ?? "5", 10);

          const summaries = await orchestrator.storage.readSummaries();

          if (summaries.length === 0) {
            console.log("No summaries yet. Summaries are created during consolidation when memory count exceeds threshold.");
            return;
          }

          // Sort by createdAt desc
          const sorted = summaries.sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          );

          console.log(`\n=== Memory Summaries (${Math.min(top, sorted.length)} of ${sorted.length}) ===\n`);

          for (const summary of sorted.slice(0, top)) {
            console.log(`  ${summary.id}`);
            console.log(`    Created: ${summary.createdAt}`);
            console.log(`    Time range: ${summary.timeRangeStart.slice(0, 10)} to ${summary.timeRangeEnd.slice(0, 10)}`);
            console.log(`    Source memories: ${summary.sourceEpisodeIds.length}`);
            console.log(`    Key facts: ${summary.keyFacts.length}`);
            console.log(`\n    Summary: ${summary.summaryText.slice(0, 200)}...`);
            console.log();
          }
        });

      cmd
        .command("threads")
        .description("Show conversation threads")
        .option("-n, --top <number>", "Show top N most recent threads", "10")
        .option("-t, --thread <id>", "Show details for a specific thread")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const threadId = options.thread;
          const top = parseInt(options.top ?? "10", 10);

          const memoryDir = path.join(process.env.HOME ?? "~", ".openclaw", "workspace", "memory", "local");
          const threading = new ThreadingManager(path.join(memoryDir, "threads"));

          if (threadId) {
            const thread = await threading.loadThread(threadId);
            if (!thread) {
              console.log(`Thread not found: ${threadId}`);
              return;
            }

            console.log(`\n=== Thread: ${thread.title} ===\n`);
            console.log(`  ID: ${thread.id}`);
            console.log(`  Created: ${thread.createdAt}`);
            console.log(`  Updated: ${thread.updatedAt}`);
            console.log(`  Session: ${thread.sessionKey ?? "(none)"}`);
            console.log(`  Episodes: ${thread.episodeIds.length}`);

            if (thread.episodeIds.length > 0) {
              console.log("\n  Episode IDs:");
              for (const id of thread.episodeIds.slice(0, 20)) {
                console.log(`    - ${id}`);
              }
              if (thread.episodeIds.length > 20) {
                console.log(`    ... and ${thread.episodeIds.length - 20} more`);
              }
            }

            if (thread.linkedThreadIds.length > 0) {
              console.log("\n  Linked threads:");
              for (const id of thread.linkedThreadIds) {
                console.log(`    - ${id}`);
              }
            }
            return;
          }

          const threads = await threading.getAllThreads();

          if (threads.length === 0) {
            console.log("No conversation threads yet. Enable threading with threadingEnabled: true");
            return;
          }

          console.log(`\n=== Conversation Threads (${Math.min(top, threads.length)} of ${threads.length}) ===\n`);
          for (const thread of threads.slice(0, top)) {
            const updated = new Date(thread.updatedAt).toLocaleString();
            console.log(`  ${thread.title}`);
            console.log(`    ID: ${thread.id}`);
            console.log(`    Episodes: ${thread.episodeIds.length} | Updated: ${updated}`);
            console.log();
          }
        });

      cmd
        .command("chunks")
        .description("Show chunking statistics and orphaned chunks")
        .option("-p, --parent <id>", "Show chunks for a specific parent memory ID")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const parentId = options.parent;

          const memories = await orchestrator.storage.readAllMemories();

          if (parentId) {
            // Show chunks for specific parent
            const chunks = memories
              .filter((m) => m.frontmatter.parentId === parentId)
              .sort((a, b) => (a.frontmatter.chunkIndex ?? 0) - (b.frontmatter.chunkIndex ?? 0));

            if (chunks.length === 0) {
              console.log(`No chunks found for parent: ${parentId}`);
              return;
            }

            const parent = memories.find((m) => m.frontmatter.id === parentId);
            console.log(`\n=== Chunks for ${parentId} ===\n`);
            if (parent) {
              console.log(`Parent: ${parent.content.slice(0, 100)}...`);
              console.log();
            }

            for (const chunk of chunks) {
              console.log(
                `  [${(chunk.frontmatter.chunkIndex ?? 0) + 1}/${chunk.frontmatter.chunkTotal}] ${chunk.content.slice(0, 80)}...`,
              );
            }
            return;
          }

          // Show overall chunking stats
          const chunked = memories.filter((m) => m.frontmatter.tags?.includes("chunked"));
          const chunks = memories.filter((m) => m.frontmatter.parentId);

          // Find orphaned chunks (parent no longer exists)
          const parentIds = new Set(chunked.map((m) => m.frontmatter.id));
          const orphans = chunks.filter((m) => !parentIds.has(m.frontmatter.parentId!));

          console.log("\n=== Chunking Statistics ===\n");
          console.log(`  Chunked memories (parents): ${chunked.length}`);
          console.log(`  Total chunks: ${chunks.length}`);
          console.log(`  Orphaned chunks: ${orphans.length}`);

          if (chunked.length > 0) {
            // Calculate average chunks per parent
            const avgChunks = chunks.length / chunked.length;
            console.log(`  Average chunks per parent: ${avgChunks.toFixed(1)}`);
          }

          if (orphans.length > 0) {
            console.log("\n  Orphaned chunk IDs:");
            for (const orphan of orphans.slice(0, 10)) {
              console.log(`    - ${orphan.frontmatter.id}`);
            }
            if (orphans.length > 10) {
              console.log(`    ... and ${orphans.length - 10} more`);
            }
          }
        });

      // Transcript commands
      cmd
        .command("transcript")
        .description("View conversation transcripts")
        .option("--date <date>", "View transcript for specific date (YYYY-MM-DD)")
        .option("--recent <duration>", "View recent transcript (e.g., 12h, 30m)")
        .option("--channel <key>", "Filter by channel/session key")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const date = options.date;
          const recent = options.recent;
          let channel = options.channel;

          // Expand shorthand channel names to full sessionKey patterns
          if (channel && !channel.includes(":")) {
            // Convert "main" -> "agent:generalist:main"
            // Convert "discord" -> "agent:generalist:discord" (will match all discord channels)
            // Convert "cron" -> "agent:generalist:cron" (will match all cron jobs)
            if (channel === "main") {
              channel = "agent:generalist:main";
            } else if (["discord", "slack", "cron", "telegram"].includes(channel)) {
              channel = `agent:generalist:${channel}`;
            }
          }

          if (date) {
            // Read specific date
            const entries = await orchestrator.transcript.readRange(
              `${date}T00:00:00Z`,
              `${date}T23:59:59Z`,
              channel,
            );
            console.log(formatTranscript(entries));
          } else if (recent) {
            // Parse duration (e.g., "12h", "30m")
            const hours = parseDuration(recent);
            const entries = await orchestrator.transcript.readRecent(hours, channel);
            console.log(formatTranscript(entries));
          } else {
            // Default: show today's transcript
            const today = new Date().toISOString().slice(0, 10);
            const entries = await orchestrator.transcript.readRange(
              `${today}T00:00:00Z`,
              `${today}T23:59:59Z`,
              channel,
            );
            console.log(formatTranscript(entries));
          }
        });

      // Checkpoint command
      cmd
        .command("checkpoint")
        .description("View current compaction checkpoint (if any)")
        .action(async () => {
          const checkpoint = await orchestrator.transcript.loadCheckpoint();
          if (!checkpoint) {
            console.log("No active checkpoint found.");
            return;
          }
          console.log(`Checkpoint for session: ${checkpoint.sessionKey}`);
          console.log(`Captured at: ${checkpoint.capturedAt}`);
          console.log(`Expires at: ${checkpoint.ttl}`);
          console.log(`Turns: ${checkpoint.turns.length}`);
          console.log("\n---\n");
          console.log(orchestrator.transcript.formatForRecall(checkpoint.turns, 2000));
        });

      // Summaries command
      cmd
        .command("hourly")
        .description("View hourly summaries")
        .option("--channel <key>", "Filter by channel/session key")
        .option("--recent <hours>", "Show recent summaries (hours)")
        .action(async (...args: unknown[]) => {
          const options = (args[0] ?? {}) as Record<string, string>;
          const channel = options.channel ?? "default";
          const recentHours = options.recent ? parseInt(options.recent, 10) : 24;

          const summaries = await orchestrator.summarizer.readRecent(channel, recentHours);
          if (summaries.length === 0) {
            console.log(`No summaries found for channel: ${channel}`);
            return;
          }

          console.log(orchestrator.summarizer.formatForRecall(summaries, summaries.length));
        });
    },
    { commands: ["engram"] },
  );
}

function formatTranscript(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return "No transcript entries found.";

  return entries
    .map((e) => {
      const time = e.timestamp.slice(11, 16); // HH:MM
      return `[${time}] ${e.role}: ${e.content.slice(0, 200)}${e.content.length > 200 ? "..." : ""}`;
    })
    .join("\n");
}

function parseDuration(duration: string): number {
  // Parse strings like "12h", "30m", "2h30m"
  const hours = duration.match(/(\d+)h/);
  const minutes = duration.match(/(\d+)m/);
  let total = 0;
  if (hours) total += parseInt(hours[1], 10);
  if (minutes) total += parseInt(minutes[1], 10) / 60;
  return total || 12; // Default to 12 hours
}
