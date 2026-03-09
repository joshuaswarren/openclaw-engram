import { log } from "./logger.js";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { SmartBuffer } from "./buffer.js";
import { chunkContent, type ChunkingConfig } from "./chunking.js";
import { ExtractionEngine } from "./extraction.js";
import { scoreImportance } from "./importance.js";
import { findUnresolvedEntityRefs } from "./reconstruct.js";
import type { SearchBackend } from "./search/port.js";
import { createSearchBackend, createConversationIndexRuntime } from "./search/factory.js";
import { NoopSearchBackend } from "./search/noop-backend.js";
import { StorageManager, ContentHashIndex, normalizeEntityName } from "./storage.js";
import { ThreadingManager } from "./threading.js";
import { extractTopics } from "./topics.js";
import { TranscriptManager } from "./transcript.js";
import { HourlySummarizer } from "./summarizer.js";
import { LocalLlmClient } from "./local-llm.js";
import { ModelRegistry } from "./model-registry.js";
import { applyRuntimeRetrievalPolicy, expandQuery } from "./retrieval.js";
import { RerankCache, rerankLocalOrNoop } from "./rerank.js";
import { RelevanceStore } from "./relevance.js";
import { NegativeExampleStore } from "./negative.js";
import {
  LastRecallStore,
  TierMigrationStatusStore,
  clampGraphRecallExpandedEntries,
  type GraphRecallExpandedEntry,
  type LastRecallSnapshot,
  type TierMigrationCycleSummary,
  type TierMigrationStatusSnapshot,
} from "./recall-state.js";
import { recordEvalShadowRecall, type EvalShadowRecallRecord } from "./evals.js";
import { SessionObserverState } from "./session-observer-state.js";
import { isDisagreementPrompt } from "./signal.js";
import { lintWorkspaceFiles, rotateMarkdownFileToArchive } from "./hygiene.js";
import { EmbeddingFallback } from "./embedding-fallback.js";
import { BootstrapEngine } from "./bootstrap.js";
import {
  hasBroadGraphIntent,
  inferIntentFromText,
  intentCompatibilityScore,
  planRecallMode,
} from "./intent.js";
import { buildRecallQueryPolicy } from "./recall-query-policy.js";
import { parseMemoryActionEligibilityContext } from "./schemas.js";
import { evaluateMemoryActionPolicy } from "./memory-action-policy.js";
import {
  buildCompressionGuidelinesMarkdown as buildCompressionGuidelinesMarkdownV2,
  computeCompressionGuidelineCandidate,
  refineCompressionGuidelineCandidateSemantically,
  renderCompressionGuidelinesMarkdown,
} from "./compression-optimizer.js";
import { BoxBuilder, type BoxFrontmatter } from "./boxes.js";
import { classifyMemoryKind } from "./himem.js";
import { TmtBuilder } from "./tmt.js";
import { decideLifecycleTransition, resolveLifecycleState, type LifecycleSignals } from "./lifecycle.js";
import {
  indexMemoriesBatch,
  clearIndexes,
  indexesExist,
  deindexMemory,
  queryByDateRangeAsync,
  queryByTagsAsync,
  isTemporalQuery,
  recencyWindowFromPrompt,
  extractTagsFromPrompt,
  resolvePromptTagPrefilterAsync,
} from "./temporal-index.js";
import { GraphIndex } from "./graph.js";
import { searchCausalTrajectories, type CausalTrajectorySearchResult } from "./causal-trajectory.js";
import { searchObjectiveStateSnapshots, type ObjectiveStateSearchResult } from "./objective-state.js";
import { searchTrustZoneRecords, type TrustZoneSearchResult } from "./trust-zones.js";
import { searchHarmonicRetrieval, type HarmonicRetrievalResult } from "./harmonic-retrieval.js";
import { searchVerifiedEpisodes, type VerifiedEpisodeResult } from "./verified-recall.js";
import { searchVerifiedSemanticRules, type VerifiedSemanticRuleResult } from "./semantic-rule-verifier.js";
import { applyCommitmentLedgerLifecycle } from "./commitment-ledger.js";
import { searchWorkProductLedgerEntries, type WorkProductLedgerSearchResult } from "./work-product-ledger.js";
import {
  collectNativeKnowledgeChunks,
  formatNativeKnowledgeSection,
  searchNativeKnowledge,
} from "./native-knowledge.js";
import { normalizeReplaySessionKey, type ReplayTurn } from "./replay/types.js";
import type { MemorySummary } from "./types.js";
import { shouldSkipImplicitExtraction } from "./explicit-capture.js";
import { chunkTranscriptEntries } from "./conversation-index/chunker.js";
import { writeConversationChunks } from "./conversation-index/indexer.js";
import { cleanupConversationChunks } from "./conversation-index/cleanup.js";
import {
  type ConversationIndexBackend,
  type ConversationIndexBackendInspection,
  type ConversationQmdRuntime,
} from "./conversation-index/backend.js";
import { NamespaceStorageRouter } from "./namespaces/storage.js";
import {
  defaultNamespaceForPrincipal,
  recallNamespacesForPrincipal,
  resolvePrincipal,
} from "./namespaces/principal.js";
import { NamespaceSearchRouter } from "./namespaces/search.js";
import { SharedContextManager } from "./shared-context/manager.js";
import {
  CompoundingEngine,
  defaultTierMigrationCycleBudget,
} from "./compounding/engine.js";
import { TierMigrationExecutor } from "./tier-migration.js";
import { decideTierTransition, type MemoryTier } from "./tier-routing.js";
import { selectRouteRule, type RouteRule, type RoutingEngineOptions } from "./routing/engine.js";
import { RoutingRulesStore } from "./routing/store.js";
import { PolicyRuntimeManager, type RuntimePolicyValues } from "./policy-runtime.js";
import {
  applyUtilityPromotionRuntimePolicy,
  applyUtilityRankingRuntimeDelta,
  loadUtilityRuntimeValues,
  type UtilityRuntimeValues,
} from "./utility-runtime.js";
import {
  buildBehaviorSignalsForMemory,
  dedupeBehaviorSignalsByMemoryAndHash,
} from "./behavior-signals.js";
import type {
  AccessTrackingEntry,
  BehaviorLoopPolicyState,
  BehaviorSignalEvent,
  BootstrapOptions,
  BootstrapResult,
  BufferTurn,
  ContinuityIncidentRecord,
  EngramTraceEvent,
  ExtractionResult,
  IdentityInjectionMode,
  LifecycleState,
  MemoryActionEvent,
  MemoryActionType,
  MemoryLink,
  MemoryFile,
  MemoryFrontmatter,
  PluginConfig,
  QmdSearchResult,
  RecallPlanMode,
  RecallSectionConfig,
} from "./types.js";

export interface GraphRecallSnapshot {
  recordedAt: string;
  mode: RecallPlanMode | string;
  queryHash: string;
  queryLength: number;
  namespaces: string[];
  seedCount: number;
  expandedCount: number;
  seeds: string[];
  expanded: GraphRecallExpandedEntry[];
}

type QueryAwarePrefilter = {
  candidatePaths: Set<string> | null;
  temporalFromDate: string | null;
  matchedTags: string[];
  expandedTags: string[];
  combination: "none" | "temporal" | "tag" | "intersection" | "union";
  filteredToFullSearch: boolean;
};

/** Maximum age (ms) before a compaction-reset signal file is considered stale and removed. */
const COMPACTION_SIGNAL_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/** Default workspace directory when no per-agent or config workspace is available. */
export function defaultWorkspaceDir(): string {
  return path.join(os.homedir(), ".openclaw", "workspace");
}

/**
 * Produce a collision-resistant, filesystem-safe identifier from a session key.
 *
 * Session keys follow colon-delimited forms (e.g., `agent:gpucodebot:main`).
 * A naive replace (`:` → `_`) is lossy: different keys like `agent:alpha` and
 * `agent/alpha` would collide. Instead we append a short SHA-256 hash of the
 * original key to the human-readable sanitized prefix, guaranteeing uniqueness
 * while keeping filenames debuggable.
 *
 * Format: `<sanitized>-<12-char-hex-hash>`
 * Example: `agent:gpucodebot:main` → `agent_gpucodebot_main-a1b2c3d4e5f6`
 */
export function sanitizeSessionKeyForFilename(sessionKey: string): string {
  const readable = sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_");
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
  return `${readable}-${hash}`;
}

export function isArtifactMemoryPath(filePath: string): boolean {
  return /(?:^|[\\/])artifacts(?:[\\/]|$)/i.test(filePath);
}

export function deriveTopicsFromExtraction(result: ExtractionResult): string[] {
  const topics = new Set<string>();
  for (const fact of result.facts ?? []) {
    for (const tag of fact.tags ?? []) {
      if (tag && tag.length >= 2) topics.add(tag.toLowerCase());
    }
    if (fact.entityRef) topics.add(fact.entityRef.toLowerCase());
    if (fact.category) topics.add(fact.category);
  }
  for (const entity of (result as any).entities ?? []) {
    if (typeof entity.name === "string" && entity.name.length >= 2) {
      topics.add(entity.name.toLowerCase());
    }
  }
  return [...topics].slice(0, 16);
}

export function buildCompressionGuidelinesMarkdown(
  events: MemoryActionEvent[],
  generatedAtIso: string = new Date().toISOString(),
): string {
  return buildCompressionGuidelinesMarkdownV2(events, generatedAtIso);
}

export function formatCompressionGuidelinesForRecall(raw: string, maxLines: number = 5): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const sectionMatch = raw.match(/## Suggested Guidelines\s*\n([\s\S]*?)(?:\n##\s+|\s*$)/i);
  if (!sectionMatch) return null;

  const lines = sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, Math.max(1, Math.floor(maxLines)));
  if (lines.length === 0) return null;

  return lines.join("\n");
}

export function filterRecallCandidates(
  candidates: QmdSearchResult[],
  options: {
    namespacesEnabled: boolean;
    recallNamespaces: string[];
    resolveNamespace: (path: string) => string;
    limit: number;
  },
): QmdSearchResult[] {
  const scopedByNamespace = options.namespacesEnabled
    ? candidates.filter((r) => options.recallNamespaces.includes(options.resolveNamespace(r.path)))
    : candidates;
  return scopedByNamespace
    .filter((r) => !isArtifactMemoryPath(r.path))
    .slice(0, Math.max(0, options.limit));
}

function applyQueryAwareCandidateFilter(
  candidates: QmdSearchResult[],
  candidatePaths: Set<string> | null,
): QmdSearchResult[] {
  if (!candidatePaths || candidatePaths.size === 0) return candidates;
  const filtered = candidates.filter((candidate) => candidatePaths.has(candidate.path));
  return filtered.length > 0 ? filtered : candidates;
}

function tokenizeRecallQuery(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function hasLifecycleMetadata(frontmatter: MemoryFrontmatter): boolean {
  return (
    frontmatter.lifecycleState !== undefined ||
    frontmatter.verificationState !== undefined ||
    frontmatter.policyClass !== undefined ||
    frontmatter.lastValidatedAt !== undefined ||
    frontmatter.decayScore !== undefined ||
    frontmatter.heatScore !== undefined
  );
}

export function shouldFilterLifecycleRecallCandidate(
  frontmatter: MemoryFrontmatter,
  options: {
    lifecyclePolicyEnabled: boolean;
    lifecycleFilterStaleEnabled: boolean;
  },
): boolean {
  if (!options.lifecyclePolicyEnabled || !options.lifecycleFilterStaleEnabled) return false;
  if (!hasLifecycleMetadata(frontmatter)) return false;
  const lifecycleState = resolveLifecycleState(frontmatter);
  return lifecycleState === "stale" || lifecycleState === "archived";
}

export function lifecycleRecallScoreAdjustment(
  frontmatter: MemoryFrontmatter,
  options: {
    lifecyclePolicyEnabled: boolean;
  },
): number {
  if (!options.lifecyclePolicyEnabled) return 0;
  if (!hasLifecycleMetadata(frontmatter)) return 0;

  let delta = 0;
  const lifecycleState = resolveLifecycleState(frontmatter);
  switch (lifecycleState) {
    case "active":
      delta += 0.05;
      break;
    case "validated":
      delta += 0.03;
      break;
    case "candidate":
      delta -= 0.01;
      break;
    case "stale":
      delta -= 0.06;
      break;
    case "archived":
      delta -= 0.08;
      break;
  }
  if (frontmatter.verificationState === "disputed") {
    delta -= 0.12;
  }
  return delta;
}

export function computeArtifactRecallLimit(
  recallMode: RecallPlanMode,
  recallResultLimit: number,
  verbatimArtifactsMaxRecall: number,
): number {
  if (recallMode === "no_recall") return 0;
  if (Math.max(0, recallResultLimit) === 0) return 0;
  const base = Math.max(0, verbatimArtifactsMaxRecall);
  if (recallMode === "minimal") {
    return Math.min(base, Math.max(0, recallResultLimit));
  }
  return base;
}

export function resolveEffectiveRecallMode(options: {
  plannerEnabled: boolean;
  graphRecallEnabled: boolean;
  multiGraphMemoryEnabled: boolean;
  graphExpandedIntentEnabled?: boolean;
  prompt: string;
}): RecallPlanMode {
  let plannedMode: RecallPlanMode = options.plannerEnabled
    ? planRecallMode(options.prompt)
    : "full";
  if (
    plannedMode !== "graph_mode" &&
    options.plannerEnabled &&
    options.graphExpandedIntentEnabled === true &&
    hasBroadGraphIntent(options.prompt)
  ) {
    plannedMode = "graph_mode";
  }
  if (
    plannedMode === "graph_mode" &&
    (!options.graphRecallEnabled || !options.multiGraphMemoryEnabled)
  ) {
    return "full";
  }
  return plannedMode;
}

export function hasIdentityRecoveryIntent(prompt: string): boolean {
  const text = typeof prompt === "string" ? prompt.toLowerCase() : "";
  if (!text) return false;
  return /\b(identity|continuity|recover(?:y|ing|ed)?|incident|drift|restore|regress(?:ion|ed|ing)?)\b/i.test(
    text,
  );
}

export function resolveEffectiveIdentityInjectionMode(options: {
  configuredMode: IdentityInjectionMode;
  recallMode: RecallPlanMode;
  prompt: string;
}): { mode: IdentityInjectionMode; shouldInject: boolean } {
  if (options.configuredMode === "recovery_only" && !hasIdentityRecoveryIntent(options.prompt)) {
    return { mode: "recovery_only", shouldInject: false };
  }
  if (options.recallMode === "minimal" && options.configuredMode === "full") {
    return { mode: "minimal", shouldInject: true };
  }
  return { mode: options.configuredMode, shouldInject: true };
}

export function computeArtifactCandidateFetchLimit(targetCount: number): number {
  const cappedTarget = Math.max(0, targetCount);
  if (cappedTarget === 0) return 0;
  const headroom = Math.max(8, cappedTarget * 4);
  return Math.min(200, cappedTarget + headroom);
}

export function computeQmdHybridFetchLimit(
  recallFetchLimit: number,
  artifactsEnabled: boolean,
  maxArtifactRecall: number,
): number {
  const cappedRecallLimit = Math.max(0, recallFetchLimit);
  if (cappedRecallLimit === 0) return 0;
  if (!artifactsEnabled) return cappedRecallLimit;
  // Overscan when artifacts are enabled, then filter artifact paths before
  // re-applying the recall cap to avoid artifact-dominated top-N starvation.
  const artifactHeadroom = Math.max(20, Math.max(0, maxArtifactRecall) * 8);
  return Math.min(400, cappedRecallLimit + artifactHeadroom);
}

export function mergeGraphExpandedResults(
  primary: QmdSearchResult[],
  expanded: QmdSearchResult[],
): QmdSearchResult[] {
  const mergedByPath = new Map<string, QmdSearchResult>();
  for (const item of [...primary, ...expanded]) {
    const prev = mergedByPath.get(item.path);
    if (!prev) {
      mergedByPath.set(item.path, item);
      continue;
    }
    const better = item.score > prev.score ? item : prev;
    const snippet = prev.snippet || item.snippet;
    mergedByPath.set(item.path, { ...better, snippet });
  }
  return Array.from(mergedByPath.values());
}

export function graphPathRelativeToStorage(storageDir: string, candidatePath: string): string | null {
  const absolutePath = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(storageDir, candidatePath);
  const rel = path.relative(storageDir, absolutePath);
  if (!rel || rel === ".") return null;
  if (rel.startsWith("..")) return null;
  return rel.split(path.sep).join("/");
}

function normalizeGraphActivationScore(score: number): number {
  const bounded = Number.isFinite(score) && score > 0 ? score : 0;
  return bounded / (1 + bounded);
}

export function blendGraphExpandedRecallScore(options: {
  graphActivationScore: number;
  seedRecallScore: number;
  activationWeight: number;
  blendMin: number;
  blendMax: number;
}): number {
  const graphNorm = normalizeGraphActivationScore(options.graphActivationScore);
  const seedScore = Number.isFinite(options.seedRecallScore)
    ? Math.min(1, Math.max(0, options.seedRecallScore))
    : 0;
  const weight = Math.min(1, Math.max(0, options.activationWeight));
  const rawMin = Math.min(1, Math.max(0, options.blendMin));
  const rawMax = Math.min(1, Math.max(0, options.blendMax));
  const minBound = Math.min(rawMin, rawMax);
  const maxBound = Math.max(rawMin, rawMax);
  const blended = (graphNorm * weight) + (seedScore * (1 - weight));
  return Math.max(minBound, Math.min(maxBound, blended));
}

export function summarizeGraphShadowComparison(
  baseline: QmdSearchResult[],
  merged: QmdSearchResult[],
  topN: number,
): {
  baselineCount: number;
  graphCount: number;
  overlapCount: number;
  overlapRatio: number;
  averageOverlapDelta: number;
} {
  const limit = Math.max(0, Math.floor(topN));
  const baselineTop = limit > 0 ? baseline.slice(0, limit) : [];
  const graphTop = limit > 0 ? merged.slice(0, limit) : [];
  const baselineByPath = new Map(baselineTop.map((item) => [item.path, item.score]));
  const graphByPath = new Map(graphTop.map((item) => [item.path, item.score]));

  let overlapCount = 0;
  let overlapDeltaSum = 0;
  for (const [p, baselineScore] of baselineByPath.entries()) {
    const graphScore = graphByPath.get(p);
    if (typeof graphScore !== "number") continue;
    overlapCount += 1;
    overlapDeltaSum += graphScore - baselineScore;
  }

  const baselineCount = baselineTop.length;
  return {
    baselineCount,
    graphCount: graphTop.length,
    overlapCount,
    overlapRatio: baselineCount > 0 ? overlapCount / baselineCount : 0,
    averageOverlapDelta: overlapCount > 0 ? overlapDeltaSum / overlapCount : 0,
  };
}

export function mergeArtifactRecallCandidates(
  candidatesByNamespace: MemoryFile[][],
  limit: number,
): MemoryFile[] {
  const cappedLimit = Math.max(0, limit);
  if (cappedLimit === 0) return [];

  const out: MemoryFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (out.length < cappedLimit) {
    let hasAnyCandidateAtOffset = false;
    for (const list of candidatesByNamespace) {
      if (offset >= list.length) continue;
      hasAnyCandidateAtOffset = true;
      const item = list[offset];
      const dedupeKey = `${item.frontmatter.id}:${item.frontmatter.sourceMemoryId ?? ""}:${item.content}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(item);
      if (out.length >= cappedLimit) break;
    }
    if (!hasAnyCandidateAtOffset) break;
    offset += 1;
  }
  return out;
}

export function resolveRecentThreadMemoryPaths(options: {
  threadEpisodeIds: string[];
  currentMemoryId: string;
  allMemsForGraph: MemoryFile[] | null | undefined;
  pathById?: Map<string, string>;
  storageDir: string;
  maxRecent: number;
}): string[] {
  const maxRecent = Math.max(0, options.maxRecent);
  if (options.threadEpisodeIds.length === 0 || maxRecent === 0) return [];
  const pathById = options.pathById ?? buildMemoryPathById(options.allMemsForGraph, options.storageDir);
  if (pathById.size === 0) return [];

  return options.threadEpisodeIds
    .filter((id) => id !== options.currentMemoryId)
    .slice(-maxRecent)
    .map((id) => pathById.get(id))
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

export function buildMemoryPathById(
  allMemsForGraph: MemoryFile[] | null | undefined,
  storageDir: string,
): Map<string, string> {
  const pathById = new Map<string, string>();
  for (const mem of allMemsForGraph ?? []) {
    const id = mem.frontmatter.id;
    if (!id) continue;
    pathById.set(id, path.relative(storageDir, mem.path));
  }
  return pathById;
}

export function appendMemoryToGraphContext(options: {
  allMemsForGraph: MemoryFile[] | null | undefined;
  storageDir: string;
  memoryRelPath: string;
  memoryId: string;
  category: MemoryFile["frontmatter"]["category"];
  content: string;
  entityRef: string | undefined;
}): void {
  if (!Array.isArray(options.allMemsForGraph)) return;

  const nowIso = new Date().toISOString();
  options.allMemsForGraph.push({
    path: path.join(options.storageDir, options.memoryRelPath),
    content: options.content,
    frontmatter: {
      id: options.memoryId,
      category: options.category,
      created: nowIso,
      updated: nowIso,
      source: "extraction",
      confidence: 0.8,
      confidenceTier: "implied",
      tags: [],
      entityRef: options.entityRef,
      status: "active",
    },
  });
}

export function resolvePersistedMemoryRelativePath(options: {
  memoryId: string;
  pathById: Map<string, string>;
  category: string;
}): string {
  const persisted = options.pathById.get(options.memoryId);
  if (persisted) return persisted;
  if (options.category === "correction") {
    return path.join("corrections", `${options.memoryId}.md`);
  }
  const idParts = options.memoryId.split("-");
  const maybeTimestamp = Number(idParts[1]);
  if (Number.isFinite(maybeTimestamp) && maybeTimestamp > 0) {
    const day = new Date(maybeTimestamp).toISOString().slice(0, 10);
    return path.join("facts", day, `${options.memoryId}.md`);
  }
  return path.join("facts", `${options.memoryId}.md`);
}

/**
 * Synapse-inspired confidence gate.
 * Returns true if the top recall result score is below the threshold,
 * indicating retrieval is too uncertain to inject.
 */
export function shouldRejectLowConfidenceRecall(
  results: Array<{ score: number }>,
  threshold: number,
): boolean {
  if (results.length === 0) return false;
  const topScore = Math.max(...results.map((r) => r.score));
  return topScore < threshold;
}

export class Orchestrator {
  readonly storage: StorageManager;
  private readonly storageRouter: NamespaceStorageRouter;
  private readonly namespaceSearchRouter: NamespaceSearchRouter;
  qmd: SearchBackend;
  private readonly conversationQmd?: ConversationQmdRuntime;
  private readonly conversationFaiss?: ReturnType<typeof createConversationIndexRuntime>["faiss"];
  private readonly conversationIndexBackend?: ConversationIndexBackend;
  readonly sharedContext?: SharedContextManager;
  readonly compounding?: CompoundingEngine;
  readonly buffer: SmartBuffer;
  readonly transcript: TranscriptManager;
  readonly sessionObserver: SessionObserverState;
  readonly summarizer: HourlySummarizer;
  readonly localLlm: LocalLlmClient;
  readonly fastLlm: LocalLlmClient;
  readonly modelRegistry: ModelRegistry;
  readonly relevance: RelevanceStore;
  readonly negatives: NegativeExampleStore;
  readonly lastRecall: LastRecallStore;
  readonly tierMigrationStatus: TierMigrationStatusStore;
  readonly embeddingFallback: EmbeddingFallback;
  private readonly conversationIndexDir: string;
  private readonly extraction: ExtractionEngine;
  readonly config: PluginConfig;
  private readonly threading: ThreadingManager;
  /** v8.2: Per-namespace multi-graph memory indexes (entity/time/causal edges) */
  private readonly graphIndexes = new Map<string, GraphIndex>();
  /** Per-namespace BoxBuilders, keyed by the namespace root directory path. */
  private readonly boxBuilders = new Map<string, BoxBuilder>();
  /** Temporal Memory Tree builder — builds hour/day/week/persona summary nodes. */
  private readonly tmtBuilder: TmtBuilder;
  private readonly rerankCache = new RerankCache();
  /**
   * Per-session workspace overrides keyed by sessionKey.
   * Set by the before_agent_start hook so recall() uses the correct
   * agent workspace for BOOT.md injection. Cleared after each recall.
   * Using a Map prevents concurrent sessions from overwriting each other.
   */
  private _recallWorkspaceOverrides = new Map<string, string>();
  private routingRulesStore: RoutingRulesStore | null = null;
  private contentHashIndex: ContentHashIndex | null = null;
  private readonly artifactSourceStatusCache = new WeakMap<
    StorageManager,
    {
      loadedAtMs: number;
      statusVersion: number;
      statuses: Map<string, "active" | "superseded" | "archived" | "missing">;
    }
  >();
  private static readonly ARTIFACT_STATUS_CACHE_TTL_MS = 60_000;

  // Access tracking buffer (Phase 1A)
  // Maps memoryId -> {count, lastAccessed} for batched updates
  private accessTrackingBuffer: Map<string, { count: number; lastAccessed: string }> =
    new Map();

  // Background serial queue for extractions (agent_end optimization)
  // Queue stores promises that resolve when extraction should run
  private extractionQueue: Array<() => Promise<void>> = [];
  private queueProcessing = false;
  private heartbeatObserverChains = new Map<string, Promise<void>>();
  private recentExtractionFingerprints = new Map<string, number>();
  private nonZeroExtractionsSinceConsolidation = 0;
  private lastConsolidationRunAtMs = 0;
  private consolidationInFlight = false;
  private qmdMaintenanceTimer: NodeJS.Timeout | null = null;
  private qmdMaintenancePending = false;
  private qmdMaintenanceInFlight = false;
  private lastQmdEmbedAtMs = 0;
  private tierMigrationInFlight = false;
  private lastTierMigrationRunAtMs = 0;
  private readonly conversationIndexLastUpdateAtMs = new Map<string, number>();
  private lastFileHygieneRunAtMs = 0;
  private lastRecallFailureLogAtMs = 0;
  private lastRecallFailureAtMs = 0;
  private suppressedRecallFailures = 0;
  private readonly policyRuntime: PolicyRuntimeManager;
  private runtimePolicyValues: RuntimePolicyValues | null = null;
  private utilityRuntimeValues: UtilityRuntimeValues | null = null;
  private evalShadowWriteChain: Promise<void> = Promise.resolve();

  // Initialization gate: recall() awaits this before proceeding
  private initPromise: Promise<void> | null = null;
  private resolveInit: (() => void) | null = null;

  /** Set per-session workspace for the next recall() call (compaction reset). @internal */
  setRecallWorkspaceOverride(sessionKey: string, dir: string): void {
    this._recallWorkspaceOverrides.set(sessionKey, dir);
  }

  /** Remove a per-session workspace override (cleanup on error or early return). @internal */
  clearRecallWorkspaceOverride(sessionKey: string): void {
    this._recallWorkspaceOverrides.delete(sessionKey);
  }

  resolvePrincipal(sessionKey?: string): string {
    return resolvePrincipal(sessionKey, this.config);
  }

  resolveSelfNamespace(sessionKey?: string): string {
    return defaultNamespaceForPrincipal(this.resolvePrincipal(sessionKey), this.config);
  }

  async getStorageForNamespace(namespace?: string): Promise<StorageManager> {
    const ns = typeof namespace === "string" && namespace.trim().length > 0
      ? namespace.trim()
      : this.config.defaultNamespace;
    return this.storageRouter.storageFor(ns);
  }

  private configuredNamespaces(): string[] {
    return Array.from(
      new Set([
        this.config.defaultNamespace,
        this.config.sharedNamespace,
        ...this.config.namespacePolicies.map((policy) => policy.name),
      ].map((value) => value.trim()).filter(Boolean)),
    );
  }

  async searchAcrossNamespaces(options: {
    query: string;
    namespaces?: string[];
    maxResults?: number;
    mode?: "search" | "hybrid" | "bm25" | "vector";
  }): Promise<QmdSearchResult[]> {
    const namespaces = this.config.namespacesEnabled
      ? Array.from(
        new Set(
          (options.namespaces?.length ? options.namespaces : this.configuredNamespaces())
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      )
      : [this.config.defaultNamespace];

    if (!this.config.namespacesEnabled) {
      switch (options.mode) {
        case "hybrid":
          return await this.qmd.hybridSearch(options.query, undefined, options.maxResults);
        case "bm25":
          return await this.qmd.bm25Search(options.query, undefined, options.maxResults);
        case "vector":
          return await this.qmd.vectorSearch(options.query, undefined, options.maxResults);
        default:
          return await this.qmd.search(options.query, undefined, options.maxResults);
      }
    }

    return await this.namespaceSearchRouter.searchAcrossNamespaces({
      query: options.query,
      namespaces,
      maxResults: options.maxResults,
      mode: options.mode,
    });
  }

  private isSearchAvailableForNamespaceRouting(): boolean {
    if (this.config.namespacesEnabled) return true;
    return this.qmd.isAvailable();
  }

  constructor(config: PluginConfig) {
    this.config = config;
    this.storageRouter = new NamespaceStorageRouter(config);
    this.namespaceSearchRouter = new NamespaceSearchRouter(config, this.storageRouter);
    this.storage = new StorageManager(config.memoryDir);
    this.qmd = createSearchBackend(config);
    const conversationIndexRuntime = createConversationIndexRuntime(config, {
      getQmd: () => this.conversationQmd,
      getFaiss: () => this.conversationFaiss,
    });
    this.conversationQmd = conversationIndexRuntime.qmd;
    this.conversationFaiss = conversationIndexRuntime.faiss;
    this.conversationIndexBackend = conversationIndexRuntime.backend;
    this.sharedContext = config.sharedContextEnabled ? new SharedContextManager(config) : undefined;
    this.compounding = config.compoundingEnabled ? new CompoundingEngine(config) : undefined;
    this.buffer = new SmartBuffer(config, this.storage);
    this.transcript = new TranscriptManager(config);
    this.conversationIndexDir = path.join(config.memoryDir, "conversation-index", "chunks");
    this.modelRegistry = new ModelRegistry(config.memoryDir);
    this.relevance = new RelevanceStore(config.memoryDir);
    this.negatives = new NegativeExampleStore(config.memoryDir);
    this.lastRecall = new LastRecallStore(config.memoryDir);
    this.tierMigrationStatus = new TierMigrationStatusStore(config.memoryDir);
    this.sessionObserver = new SessionObserverState({
      memoryDir: config.memoryDir,
      debounceMs: config.sessionObserverDebounceMs ?? 120_000,
      bands: config.sessionObserverBands ?? [],
    });
    this.embeddingFallback = new EmbeddingFallback(config);
    this.policyRuntime = new PolicyRuntimeManager(config.memoryDir, config);
    this.summarizer = new HourlySummarizer(config, config.gatewayConfig, this.modelRegistry, this.transcript);
    this.localLlm = new LocalLlmClient(config, this.modelRegistry);
    this.fastLlm = config.localLlmFastEnabled
      ? (() => {
          const client = new LocalLlmClient(
            { ...config, localLlmModel: config.localLlmFastModel || config.localLlmModel, localLlmUrl: config.localLlmFastUrl, localLlmTimeoutMs: config.localLlmFastTimeoutMs },
            this.modelRegistry,
          );
          client.disableThinking = true;
          return client;
        })()
      : this.localLlm;
    this.extraction = new ExtractionEngine(config, this.localLlm, config.gatewayConfig, this.modelRegistry);
    this.threading = new ThreadingManager(
      path.join(config.memoryDir, "threads"),
      config.threadingGapMinutes,
    );
    // BoxBuilders are created per-namespace on first use in runExtraction().

    // Temporal Memory Tree (v8.2) — lazy build during consolidation
    this.tmtBuilder = new TmtBuilder(config.memoryDir, {
      temporalMemoryTreeEnabled: config.temporalMemoryTreeEnabled,
      tmtHourlyMinMemories: config.tmtHourlyMinMemories,
      tmtSummaryMaxTokens: config.tmtSummaryMaxTokens,
    });

    // Create init gate — recall() will await this before proceeding
    this.initPromise = new Promise<void>((resolve) => {
      this.resolveInit = resolve;
    });
  }

  /** Get or create a BoxBuilder for the given namespace storage root (namespace-isolated). */
  private boxBuilderFor(storage: StorageManager): BoxBuilder {
    const dir = storage.dir;
    if (!this.boxBuilders.has(dir)) {
      this.boxBuilders.set(dir, new BoxBuilder(dir, {
        memoryBoxesEnabled: this.config.memoryBoxesEnabled,
        traceWeaverEnabled: this.config.traceWeaverEnabled,
        boxTopicShiftThreshold: this.config.boxTopicShiftThreshold,
        boxTimeGapMs: this.config.boxTimeGapMs,
        boxMaxMemories: this.config.boxMaxMemories,
        traceWeaverLookbackDays: this.config.traceWeaverLookbackDays,
        traceWeaverOverlapThreshold: this.config.traceWeaverOverlapThreshold,
      }));
    }
    return this.boxBuilders.get(dir)!;
  }

  private effectiveRecencyWeight(): number {
    return applyRuntimeRetrievalPolicy(
      { recencyWeight: this.config.recencyWeight },
      this.runtimePolicyValues,
    ).recencyWeight;
  }

  private effectiveCronRecallInstructionHeavyTokenCap(): number {
    return this.runtimePolicyValues?.cronRecallInstructionHeavyTokenCap ??
      this.config.cronRecallInstructionHeavyTokenCap;
  }

  private currentPolicyVersion(): string {
    const thresholds = this.effectiveLifecycleThresholds();
    const payload = {
      recencyWeight: this.effectiveRecencyWeight(),
      lifecyclePromoteHeatThreshold: thresholds.promoteHeatThreshold,
      lifecycleStaleDecayThreshold: thresholds.staleDecayThreshold,
      cronRecallInstructionHeavyTokenCap: this.effectiveCronRecallInstructionHeavyTokenCap(),
      utilityRankingBoostMultiplier: this.utilityRuntimeValues?.rankingBoostMultiplier ?? 1,
      utilityRankingSuppressMultiplier: this.utilityRuntimeValues?.rankingSuppressMultiplier ?? 1,
      utilityPromoteThresholdDelta: this.utilityRuntimeValues?.promoteThresholdDelta ?? 0,
      utilityDemoteThresholdDelta: this.utilityRuntimeValues?.demoteThresholdDelta ?? 0,
    };
    return createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
      .slice(0, 12);
  }

  private effectiveLifecycleThresholds(): {
    promoteHeatThreshold: number;
    staleDecayThreshold: number;
    archiveDecayThreshold: number;
  } {
    const archiveDecayThreshold = this.config.lifecycleArchiveDecayThreshold;
    const staleDecayThreshold = Math.min(
      this.runtimePolicyValues?.lifecycleStaleDecayThreshold ??
        this.config.lifecycleStaleDecayThreshold,
      archiveDecayThreshold,
    );
    return {
      promoteHeatThreshold:
        this.runtimePolicyValues?.lifecyclePromoteHeatThreshold ??
        this.config.lifecyclePromoteHeatThreshold,
      staleDecayThreshold,
      archiveDecayThreshold,
    };
  }

  private routeEngineOptions(): RoutingEngineOptions {
    const allowedNamespaces = this.config.namespacesEnabled
      ? Array.from(
          new Set([
            this.config.defaultNamespace,
            this.config.sharedNamespace,
            ...this.config.namespacePolicies.map((policy) => policy.name),
          ]),
        )
      : [this.config.defaultNamespace];
    return { allowedNamespaces };
  }

  private getRoutingRulesStore(): RoutingRulesStore {
    if (!this.routingRulesStore) {
      this.routingRulesStore = new RoutingRulesStore(
        this.config.memoryDir,
        this.config.routingRulesStateFile,
      );
    }
    return this.routingRulesStore;
  }

  private async loadRoutingRules(): Promise<RouteRule[]> {
    if (!this.config.routingRulesEnabled) return [];
    try {
      return await this.getRoutingRulesStore().read(this.routeEngineOptions());
    } catch (err) {
      log.warn(`routing rules unavailable; fail-open to default writes: ${err}`);
      return [];
    }
  }

  private async resolveArtifactSourceStatuses(
    storage: StorageManager,
    sourceIds: string[],
  ): Promise<Map<string, "active" | "superseded" | "archived" | "missing">> {
    const currentStatusVersion = storage.getMemoryStatusVersion();
    const cached = this.artifactSourceStatusCache.get(storage);
    let snapshot = cached;
    const isFresh =
      snapshot !== undefined &&
      Date.now() - snapshot.loadedAtMs <= Orchestrator.ARTIFACT_STATUS_CACHE_TTL_MS &&
      snapshot.statusVersion === currentStatusVersion;

    const rebuildSnapshot = async () => {
      const MAX_STABLE_READ_ATTEMPTS = 3;
      let latestStatuses = new Map<string, "active" | "superseded" | "archived" | "missing">();
      let latestVersionAfter = storage.getMemoryStatusVersion();

      for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
        const versionBefore = storage.getMemoryStatusVersion();
        const allMemories = await storage.readAllMemories();
        const versionAfter = storage.getMemoryStatusVersion();
        latestVersionAfter = versionAfter;
        latestStatuses = new Map(
          allMemories.map((m) => [
            m.frontmatter.id,
            (m.frontmatter.status ?? "active") as "active" | "superseded" | "archived" | "missing",
          ]),
        );

        if (versionAfter === versionBefore) {
          const rebuilt = {
            loadedAtMs: Date.now(),
            statusVersion: versionAfter,
            statuses: latestStatuses,
          };
          this.artifactSourceStatusCache.set(storage, rebuilt);
          return rebuilt;
        }
      }

      // Sustained write churn: return latest read without caching a potentially torn snapshot.
      return {
        loadedAtMs: Date.now(),
        statusVersion: latestVersionAfter,
        statuses: latestStatuses,
      };
    };

    if (!isFresh) {
      snapshot = await rebuildSnapshot();
    } else {
      // Warm cache may miss brand-new sourceMemoryId values created after snapshot build.
      // Refresh once on-demand when unseen IDs are requested.
      const hasUnknownSourceIds = sourceIds.some((id) => !snapshot?.statuses.has(id));
      if (hasUnknownSourceIds) {
        snapshot = await rebuildSnapshot();
      }
    }

    // Persist negative lookups in the cached snapshot so stale source IDs do not
    // trigger repeated full snapshot rebuilds on every matching recall.
    for (const id of sourceIds) {
      if (!snapshot?.statuses.has(id)) {
        snapshot?.statuses.set(id, "missing");
      }
    }

    const statuses = new Map<string, "active" | "superseded" | "archived" | "missing">();
    for (const id of sourceIds) {
      const status = snapshot?.statuses.get(id);
      if (status) {
        statuses.set(id, status);
      } else {
        statuses.set(id, "missing");
      }
    }
    return statuses;
  }

  async initialize(): Promise<void> {
    await this.storage.ensureDirectories();
    await this.storage.loadAliases();
    if (this.config.namespacesEnabled) {
      const namespaces = new Set<string>([
        this.config.defaultNamespace,
        this.config.sharedNamespace,
        ...this.config.namespacePolicies.map((p) => p.name),
      ]);
      for (const ns of namespaces) {
        const sm = await this.storageRouter.storageFor(ns);
        await sm.ensureDirectories();
        await sm.loadAliases().catch(() => undefined);
      }
    }
    await this.relevance.load();
    await this.negatives.load();
    await this.lastRecall.load();
    await this.tierMigrationStatus.load();
    await this.sessionObserver.load();
    this.runtimePolicyValues = await this.policyRuntime.loadRuntimeValues();
    this.utilityRuntimeValues = await loadUtilityRuntimeValues({
      memoryDir: this.config.memoryDir,
      memoryUtilityLearningEnabled: this.config.memoryUtilityLearningEnabled,
      promotionByOutcomeEnabled: this.config.promotionByOutcomeEnabled,
    });

    // Initialize content-hash dedup index
    if (this.config.factDeduplicationEnabled) {
      const stateDir = path.join(this.config.memoryDir, "state");
      this.contentHashIndex = new ContentHashIndex(stateDir);
      await this.contentHashIndex.load();
      log.info(`content-hash dedup: loaded ${this.contentHashIndex.size} hashes`);
    }
    await this.transcript.initialize();
    await this.summarizer.initialize();
    if (this.sharedContext) {
      await this.sharedContext.ensureStructure();
    }
    if (this.compounding) {
      await this.compounding.ensureDirs();
    }

    {
      const available = await this.qmd.probe();
      if (available) {
        log.info(`Search backend: available ${this.qmd.debugStatus()}`);
        const namespaces = this.config.namespacesEnabled
          ? this.configuredNamespaces()
          : [this.config.defaultNamespace];
        const states = await Promise.all(
          namespaces.map(async (namespace) => ({
            namespace,
            state: this.config.namespacesEnabled
              ? await this.namespaceSearchRouter.ensureNamespaceCollection(namespace)
              : await this.qmd.ensureCollection(this.config.memoryDir),
          })),
        );
        const defaultState = states.find((entry) => entry.namespace === this.config.defaultNamespace)?.state ?? "unknown";
        if (defaultState === "missing") {
          this.qmd = new NoopSearchBackend();
          log.warn(
            "Search collection missing for Engram memory store; disabling search retrieval for this runtime (fallback retrieval remains enabled)",
          );
        } else if (defaultState === "unknown") {
          log.warn("Search collection check unavailable; keeping search retrieval enabled for fail-open behavior");
        } else if (defaultState === "skipped") {
          log.debug("Search collection check skipped (remote or daemon-only mode)");
        }
        for (const entry of states) {
          if (entry.namespace === this.config.defaultNamespace) continue;
          if (entry.state === "missing") {
            log.warn(`Search collection missing for namespace '${entry.namespace}'; namespace retrieval will fail open to non-search paths`);
          }
        }
      } else if (this.qmd instanceof NoopSearchBackend) {
        log.debug(`Search backend: noop (search intentionally disabled)`);
      } else {
        log.warn(`Search backend: not available ${this.qmd.debugStatus()}`);
      }
    }

    if (this.config.conversationIndexEnabled && this.conversationIndexBackend) {
      const init = await this.conversationIndexBackend.initialize();
      if (!init.enabled) {
        this.config.conversationIndexEnabled = false;
      }
      if (init.logLevel === "info") {
        log.info(init.message);
      } else if (init.logLevel === "warn") {
        log.warn(init.message);
      } else {
        log.debug(init.message);
      }
    }

    await this.buffer.load();

    // Validate local LLM model configuration
    if (this.config.localLlmEnabled) {
      await this.validateLocalLlmModel();
    }

    // Sweep stale compaction-reset signal files (>1 hour old).
    // This prevents orphaned signals from persisting when agents are removed
    // or sessions never call recall() again after a compaction.
    // NOTE: This sweep only covers the config-level workspace. Per-agent signals
    // (written to ctx.workspaceDir) are cleaned up by recall() on each session
    // start, with a 1-hour TTL enforced at read time. Agent-specific workspaces
    // are not known at initialize() time.
    if (this.config.compactionResetEnabled) {
      try {
        const wsDir = this.config.workspaceDir || defaultWorkspaceDir();
        const files = await readdir(wsDir).catch(() => [] as string[]);
        for (const f of files) {
          if (!f.startsWith(".compaction-reset-signal-")) continue;
          const fp = path.join(wsDir, f);
          const s = await stat(fp).catch(() => null);
          if (s && Date.now() - s.mtimeMs >= COMPACTION_SIGNAL_MAX_AGE_MS) {
            await unlink(fp).catch(() => {});
            log.debug(`initialize: removed stale compaction signal ${f}`);
          }
        }
      } catch (err) {
        log.debug("initialize: stale signal sweep failed:", err);
      }
    }

    log.info("orchestrator initialized");

    // Open the init gate — any recall() calls waiting on this will proceed
    if (this.resolveInit) {
      this.resolveInit();
      this.resolveInit = null;
    }
  }

  async applyBehaviorRuntimePolicy(
    state: BehaviorLoopPolicyState,
  ): Promise<{ applied: boolean; rolledBack: boolean; values: RuntimePolicyValues | null; reason: string }> {
    const result = await this.policyRuntime.applyFromBehaviorState(state);
    this.runtimePolicyValues = await this.policyRuntime.loadRuntimeValues();
    return result;
  }

  async rollbackBehaviorRuntimePolicy(): Promise<boolean> {
    const rolledBack = await this.policyRuntime.rollback();
    this.runtimePolicyValues = await this.policyRuntime.loadRuntimeValues();
    return rolledBack;
  }

  async maybeRunFileHygiene(): Promise<void> {
    const hygiene = this.config.fileHygiene;
    if (!hygiene?.enabled) return;

    const now = Date.now();
    if (now - this.lastFileHygieneRunAtMs < hygiene.runMinIntervalMs) return;
    this.lastFileHygieneRunAtMs = now;

    // Rotation first (keeps bootstrap files small).
    if (hygiene.rotateEnabled) {
      for (const rel of hygiene.rotatePaths) {
        const abs = path.isAbsolute(rel) ? rel : path.join(this.config.workspaceDir, rel);
        try {
          const raw = await readFile(abs, "utf-8");
          if (raw.length > hygiene.rotateMaxBytes) {
            const archiveDir = path.join(this.config.workspaceDir, hygiene.archiveDir);
            const base = path.basename(abs);
            const prefix =
              base.toUpperCase().replace(/\.MD$/i, "").replace(/[^A-Z0-9]+/g, "-") || "FILE";
            const { newContent } = await rotateMarkdownFileToArchive({
              filePath: abs,
              archiveDir,
              archivePrefix: prefix,
              keepTailChars: hygiene.rotateKeepTailChars,
            });
            await writeFile(abs, newContent, "utf-8");
          }
        } catch {
          // ignore missing/unreadable targets
        }
      }
    }

    // Lint (warn before truncation risk).
    if (hygiene.lintEnabled) {
      const warnings = await lintWorkspaceFiles({
        workspaceDir: this.config.workspaceDir,
        paths: hygiene.lintPaths,
        budgetBytes: hygiene.lintBudgetBytes,
        warnRatio: hygiene.lintWarnRatio,
      });
      for (const w of warnings) {
        log.warn(w.message);
      }

      if (hygiene.warningsLogEnabled && warnings.length > 0) {
        const fp = path.join(this.config.memoryDir, hygiene.warningsLogPath);
        await mkdir(path.dirname(fp), { recursive: true });
        const stamp = new Date().toISOString();
        const block =
          `\n\n## ${stamp}\n\n` +
          warnings.map((w) => `- ${w.message}`).join("\n") +
          "\n";
        let existing = "";
        try {
          existing = await readFile(fp, "utf-8");
        } catch {
          existing = "# Engram File Hygiene Warnings\n";
        }
        await writeFile(fp, existing + block, "utf-8");
      }
    }
  }

  async runBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
    const engine = new BootstrapEngine(this.config, this);
    return engine.run(options);
  }

  async runConsolidationNow(): Promise<{ memoriesProcessed: number; merged: number; invalidated: number }> {
    return this.runConsolidation();
  }

  async waitForExtractionIdle(timeoutMs: number = 60_000): Promise<boolean> {
    const started = Date.now();
    while (this.queueProcessing || this.extractionQueue.length > 0) {
      if (Date.now() - started > timeoutMs) {
        log.warn(`waitForExtractionIdle timed out after ${timeoutMs}ms`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  async waitForConsolidationIdle(timeoutMs: number = 60_000): Promise<boolean> {
    const started = Date.now();
    while (this.consolidationInFlight) {
      if (Date.now() - started > timeoutMs) {
        log.warn(`waitForConsolidationIdle timed out after ${timeoutMs}ms`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  async getStorage(namespace?: string): Promise<StorageManager> {
    const ns = namespace && namespace.length > 0 ? namespace : this.config.defaultNamespace;
    return this.storageRouter.storageFor(ns);
  }

  previewMemoryActionEvent(
    event: Omit<MemoryActionEvent, "timestamp"> & { timestamp?: string },
  ): MemoryActionEvent {
    const namespace =
      typeof event.namespace === "string" && event.namespace.length > 0
        ? event.namespace
        : this.config.defaultNamespace;
    const eligibility = parseMemoryActionEligibilityContext(event.policyEligibility);
    const policy = evaluateMemoryActionPolicy({
      action: event.action,
      eligibility,
      options: {
        actionsEnabled: this.config.contextCompressionActionsEnabled,
        maxCompressionTokensPerHour: this.config.maxCompressionTokensPerHour,
      },
    });

    const normalizedOutcome =
      policy.decision === "allow"
        ? event.outcome
        : event.outcome === "failed"
          ? "failed"
          : "skipped";

    const reasonParts = [event.reason, `policy:${policy.decision}`, policy.rationale].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );

    return {
      ...event,
      outcome: normalizedOutcome,
      reason: reasonParts.join(" | "),
      namespace,
      timestamp:
        typeof event.timestamp === "string" && event.timestamp.length > 0
          ? event.timestamp
          : new Date().toISOString(),
      policyDecision: policy.decision,
      policyRationale: policy.rationale,
      policyEligibility: eligibility,
    };
  }

  async appendMemoryActionEvent(
    event: Omit<MemoryActionEvent, "timestamp"> & { timestamp?: string },
  ): Promise<boolean> {
    try {
      const toWrite = this.previewMemoryActionEvent(event);
      const storage = await this.getStorage(toWrite.namespace);
      await storage.appendMemoryActionEvents([toWrite]);
      return true;
    } catch (err) {
      log.warn(`appendMemoryActionEvent failed (non-fatal): ${err}`);
      return false;
    }
  }

  async getLastGraphRecallSnapshot(namespace?: string): Promise<GraphRecallSnapshot | null> {
    const storage = await this.getStorage(namespace);
    const snapshotPath = path.join(storage.dir, "state", "last_graph_recall.json");
    try {
      const raw = await readFile(snapshotPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<GraphRecallSnapshot>;
      if (!parsed || typeof parsed !== "object") return null;
      return {
        recordedAt: typeof parsed.recordedAt === "string" ? parsed.recordedAt : "",
        mode: typeof parsed.mode === "string" ? parsed.mode : "full",
        queryHash: typeof parsed.queryHash === "string" ? parsed.queryHash : "",
        queryLength: typeof parsed.queryLength === "number" ? parsed.queryLength : 0,
        namespaces: Array.isArray(parsed.namespaces)
          ? parsed.namespaces.filter((v): v is string => typeof v === "string")
          : [],
        seedCount: typeof parsed.seedCount === "number" ? parsed.seedCount : 0,
        expandedCount: typeof parsed.expandedCount === "number" ? parsed.expandedCount : 0,
        seeds: Array.isArray(parsed.seeds)
          ? parsed.seeds.filter((v): v is string => typeof v === "string")
          : [],
        expanded: clampGraphRecallExpandedEntries(parsed.expanded, 64),
      };
    } catch {
      return null;
    }
  }

  async explainLastGraphRecall(options?: {
    namespace?: string;
    maxExpanded?: number;
  }): Promise<string> {
    const snapshot = await this.getLastGraphRecallSnapshot(options?.namespace);
    if (!snapshot) return "No graph-recall snapshot found yet.";
    const maxExpanded = Math.max(1, Math.min(50, options?.maxExpanded ?? 10));
    const expanded = snapshot.expanded.slice(0, maxExpanded);
    return [
      "## Last Graph Recall",
      "",
      `Recorded at: ${snapshot.recordedAt || "unknown"}`,
      `Mode: ${snapshot.mode}`,
      `Query hash: ${snapshot.queryHash || "unknown"} (len=${snapshot.queryLength})`,
      `Namespaces: ${snapshot.namespaces.length > 0 ? snapshot.namespaces.join(", ") : "none"}`,
      `Seed paths (${snapshot.seedCount}):`,
      ...snapshot.seeds.map((p) => `- ${p}`),
      `Expanded paths (${snapshot.expandedCount}, showing ${expanded.length}):`,
      ...expanded.map(
        (e) =>
          `- ${e.path} (score=${e.score.toFixed(3)}, ns=${e.namespace}, seed=${e.seed || "unknown"}, hop=${e.hopDepth}, w=${e.decayedWeight.toFixed(3)}, type=${e.graphType})`,
      ),
    ].join("\n");
  }

  private async searchConversationRecallResults(
    retrievalQuery: string,
    topK: number,
  ): Promise<Array<{ path: string; snippet: string; score: number }>> {
    if (this.conversationIndexBackend) {
      return this.conversationIndexBackend.search(retrievalQuery, topK);
    }
    return [];
  }

  private formatConversationRecallSection(
    results: Array<{ path: string; snippet: string; score: number }>,
    maxChars: number,
  ): string | null {
    if (!Array.isArray(results) || results.length === 0) return null;
    const lines: string[] = ["## Semantic Recall (Past Conversations)", ""];
    let used = 0;
    for (const r of results) {
      if (!r?.snippet) continue;
      const chunk =
        `### ${r.path}\n` +
        `Score: ${r.score.toFixed(3)}\n\n` +
        `${r.snippet.trim()}\n`;
      if (used + chunk.length > maxChars) break;
      lines.push(chunk);
      used += chunk.length;
    }
    return used > 0 ? lines.join("\n") : null;
  }

  private async countConversationChunkDocs(dir: string): Promise<number> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          total += await this.countConversationChunkDocs(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".md")) {
          total += 1;
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  private async buildConversationIndexChunks(
    sessionKey?: string,
    hours: number = 24,
  ): Promise<ReturnType<typeof chunkTranscriptEntries>> {
    const entries = await this.transcript.readRecent(hours, sessionKey);
    const effectiveSessionKey = sessionKey ?? "all-sessions";
    return chunkTranscriptEntries(effectiveSessionKey, entries, {
      maxChars: this.config.conversationRecallMaxChars * 2,
      maxTurns: Math.max(10, this.config.hourlySummariesMaxTurnsPerRun),
    });
  }

  async getConversationIndexHealth(): Promise<{
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
  }> {
    const chunkDocCount = await this.countConversationChunkDocs(this.conversationIndexDir);
    const lastUpdateAtMs = Math.max(0, ...this.conversationIndexLastUpdateAtMs.values());
    const lastUpdateAt = lastUpdateAtMs > 0 ? new Date(lastUpdateAtMs).toISOString() : null;

    if (!this.config.conversationIndexEnabled) {
      return {
        enabled: false,
        backend: this.config.conversationIndexBackend,
        status: "disabled",
        chunkDocCount,
        lastUpdateAt,
      };
    }
    const backendHealth = this.conversationIndexBackend
      ? await this.conversationIndexBackend.health()
      : {
          backend: this.config.conversationIndexBackend,
          status: "degraded" as const,
        };
    return {
      enabled: true,
      chunkDocCount,
      lastUpdateAt,
      ...backendHealth,
    };
  }

  async inspectConversationIndex(): Promise<ConversationIndexBackendInspection & {
    enabled: boolean;
    chunkDocCount: number;
    lastUpdateAt: string | null;
  }> {
    const chunkDocCount = await this.countConversationChunkDocs(this.conversationIndexDir);
    const lastUpdateAtMs = Math.max(0, ...this.conversationIndexLastUpdateAtMs.values());
    const lastUpdateAt = lastUpdateAtMs > 0 ? new Date(lastUpdateAtMs).toISOString() : null;

    if (!this.config.conversationIndexEnabled) {
      return {
        enabled: false,
        backend: this.config.conversationIndexBackend,
        status: "disabled",
        available: false,
        indexPath: this.conversationIndexDir,
        supportsIncrementalUpdate: true,
        message: "Conversation index disabled by config",
        metadata: {
          chunkCount: chunkDocCount,
        },
        chunkDocCount,
        lastUpdateAt,
      };
    }

    const inspection = this.conversationIndexBackend
      ? await this.conversationIndexBackend.inspect()
      : {
          backend: this.config.conversationIndexBackend,
          status: "degraded" as const,
          available: false,
          indexPath: this.conversationIndexDir,
          supportsIncrementalUpdate: true,
          message: "Conversation index backend unavailable",
          metadata: {
            chunkCount: chunkDocCount,
          },
        };

    return {
      enabled: true,
      chunkDocCount,
      lastUpdateAt,
      ...inspection,
    };
  }

  async getRecoverySummary(sessionKey?: string): Promise<{
    generatedAt: string;
    sessionKey?: string;
    healthy: boolean;
    issueCount: number;
    incompleteTurns: number;
    brokenChains: number;
    checkpointHealthy: boolean;
  }> {
    return this.transcript.getRecoverySummary(sessionKey);
  }

  async updateConversationIndex(
    sessionKey: string,
    hours: number = 24,
    opts?: { embed?: boolean; enforceMinInterval?: boolean },
  ): Promise<{ chunks: number; skipped: boolean; reason?: string; retryAfterMs?: number; embedded?: boolean }> {
    if (!this.config.conversationIndexEnabled) {
      return { chunks: 0, skipped: true, reason: "disabled", embedded: false };
    }
    const enforceMinInterval = opts?.enforceMinInterval !== false;
    if (enforceMinInterval) {
      const minIntervalMs = Math.max(0, this.config.conversationIndexMinUpdateIntervalMs);
      const now = Date.now();
      const last = this.conversationIndexLastUpdateAtMs.get(sessionKey) ?? 0;
      const elapsed = now - last;
      if (minIntervalMs > 0 && elapsed < minIntervalMs) {
        return {
          chunks: 0,
          skipped: true,
          reason: "min_interval",
          retryAfterMs: minIntervalMs - elapsed,
          embedded: false,
        };
      }
    }
    const chunks = await this.buildConversationIndexChunks(sessionKey, hours);
    await writeConversationChunks(this.conversationIndexDir, chunks);
    await cleanupConversationChunks(
      this.conversationIndexDir,
      this.config.conversationIndexRetentionDays,
    );
    const shouldEmbed = opts?.embed ?? this.config.conversationIndexEmbedOnUpdate;
    let embedded = false;

    if (this.conversationIndexBackend) {
      const result = await this.conversationIndexBackend.update(chunks, { embed: shouldEmbed });
      embedded = result.embedded;
    }

    this.conversationIndexLastUpdateAtMs.set(sessionKey, Date.now());
    return { chunks: chunks.length, skipped: false, embedded };
  }

  async rebuildConversationIndex(
    sessionKey?: string,
    hours: number = 24,
    opts?: { embed?: boolean },
  ): Promise<{ chunks: number; skipped: boolean; reason?: string; embedded?: boolean; rebuilt?: boolean }> {
    if (!this.config.conversationIndexEnabled) {
      return { chunks: 0, skipped: true, reason: "disabled", embedded: false, rebuilt: false };
    }

    const chunks = await this.buildConversationIndexChunks(sessionKey, hours);
    await writeConversationChunks(this.conversationIndexDir, chunks);
    await cleanupConversationChunks(
      this.conversationIndexDir,
      this.config.conversationIndexRetentionDays,
    );

    const shouldEmbed = opts?.embed ?? this.config.conversationIndexEmbedOnUpdate;
    let embedded = false;
    let rebuilt = false;
    if (this.conversationIndexBackend) {
      const result = await this.conversationIndexBackend.rebuild(chunks, { embed: shouldEmbed });
      embedded = result.embedded;
      rebuilt = result.rebuilt;
    }

    const stamp = Date.now();
    if (sessionKey) {
      this.conversationIndexLastUpdateAtMs.set(sessionKey, stamp);
    } else {
      this.conversationIndexLastUpdateAtMs.set("__rebuild__", stamp);
    }
    return { chunks: chunks.length, skipped: false, embedded, rebuilt };
  }

  /**
   * Validate local LLM model availability and context window compatibility.
   * Warns the user if there's a mismatch.
   */
  private async validateLocalLlmModel(): Promise<void> {
    log.info("Local LLM: Validating model configuration...");
    try {
      const modelInfo = await this.localLlm.getLoadedModelInfo();
      if (!modelInfo) {
        log.warn("Local LLM validation: Could not query model info from server");
        log.warn(
          "Local LLM validation: Could not query model info. " +
          "Ensure LM Studio/Ollama is running with the model loaded."
        );
        return;
      }

      // Check for context window mismatch
      const configuredMaxContext = this.config.localLlmMaxContext;

      if (modelInfo.contextWindow) {
        log.info(
          `Local LLM: ${modelInfo.id} loaded with ${modelInfo.contextWindow.toLocaleString()} token context window`
        );

        if (configuredMaxContext && configuredMaxContext > modelInfo.contextWindow) {
          log.warn(
            `Local LLM context mismatch: engram configured for ${configuredMaxContext.toLocaleString()} tokens, ` +
            `but ${modelInfo.id} only supports ${modelInfo.contextWindow.toLocaleString()}. ` +
            `Reducing to ${modelInfo.contextWindow.toLocaleString()} to avoid errors.`
          );
          // Update the config in-memory to match actual capability
          // (This is a temporary fix - user should update their config)
          (this.config as { localLlmMaxContext?: number }).localLlmMaxContext = modelInfo.contextWindow;
        }
      } else {
        log.info(`Local LLM: ${modelInfo.id} loaded (context window not reported by server)`);

        if (!configuredMaxContext) {
          log.warn(
            "Local LLM: Server did not report context window. " +
            "If you get 'context length exceeded' errors, set localLlmMaxContext in your config. " +
            "Common defaults: LM Studio (32K), Ollama (2K-128K depending on model)."
          );
        }
      }
    } catch (err) {
      log.warn(`Local LLM validation failed: ${err}`);
    }
  }

  async recall(prompt: string, sessionKey?: string): Promise<string> {
    // Wait for initialization to complete before attempting recall.
    // Timeout after 15s in case initialize() never fires (edge case).
    if (this.initPromise) {
      const INIT_GATE_TIMEOUT_MS = 15_000;
      const gateResult = await Promise.race([
        this.initPromise.then(() => "ok" as const),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), INIT_GATE_TIMEOUT_MS)),
      ]);
      if (gateResult === "timeout") {
        log.warn("recall: init gate timed out — proceeding without full init");
      }
    }

    // Keep outer recall timeout above worst-case serialized hybrid search:
    // QMD subprocess BM25 (30s) + vector (30s) can consume ~60s under contention.
    const RECALL_TIMEOUT_MS = 75_000;
    return Promise.race([
      this.recallInternal(prompt, sessionKey),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("recall timeout")), RECALL_TIMEOUT_MS)
      ),
    ]).catch((err) => {
      this.logRecallFailure(err);
      return ""; // Return empty context on timeout/error
    });
  }

  private logRecallFailure(err: unknown): void {
    const now = Date.now();
    const errorMsg = err instanceof Error ? err.message : String(err);
    const LOG_WINDOW_MS = 60_000;
    const idleSinceLastFailureMs = now - this.lastRecallFailureAtMs;
    this.lastRecallFailureAtMs = now;
    if (idleSinceLastFailureMs >= LOG_WINDOW_MS) {
      this.suppressedRecallFailures = 0;
    }

    if (now - this.lastRecallFailureLogAtMs >= LOG_WINDOW_MS) {
      const suffix =
        this.suppressedRecallFailures > 0
          ? ` (suppressed ${this.suppressedRecallFailures} similar failures in last minute)`
          : "";
      log.warn(`recall timed out or failed: ${errorMsg}${suffix}`);
      this.lastRecallFailureLogAtMs = now;
      this.suppressedRecallFailures = 0;
      return;
    }

    this.suppressedRecallFailures += 1;
    log.debug(`recall timed out or failed (suppressed): ${errorMsg}`);
  }

  private artifactTypeForCategory(category: string): "decision" | "constraint" | "todo" | "definition" | "commitment" | "correction" | "fact" {
    if (category === "decision") return "decision";
    if (category === "commitment") return "commitment";
    if (category === "correction") return "correction";
    if (category === "principle") return "constraint";
    return "fact";
  }

  private truncateArtifactForRecall(text: string, maxChars = 280): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 1)}…`;
  }

  private async fetchActiveArtifactsForNamespace(
    namespace: string,
    prompt: string,
    targetCount: number,
  ): Promise<MemoryFile[]> {
    const storage = await this.storageRouter.storageFor(namespace);
    let fetchLimit = computeArtifactCandidateFetchLimit(targetCount);
    const maxFetchLimit = Math.min(800, Math.max(fetchLimit, targetCount * 8));
    const MAX_ATTEMPTS = 4;
    let bestFiltered: MemoryFile[] = [];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const rawResults = await storage.searchArtifacts(prompt, fetchLimit);
      const sourceIds = Array.from(
        new Set(
          rawResults
            .map((a) => a.frontmatter.sourceMemoryId)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      );
      const sourceStatus =
        sourceIds.length > 0
          ? await this.resolveArtifactSourceStatuses(storage, sourceIds)
          : new Map<string, "active" | "superseded" | "archived" | "missing">();

      const filtered: MemoryFile[] = [];
      for (const artifact of rawResults) {
        const sourceId = artifact.frontmatter.sourceMemoryId;
        if (!sourceId) {
          filtered.push(artifact);
          if (filtered.length >= targetCount) break;
          continue;
        }
        const status = sourceStatus.get(sourceId) ?? "missing";
        if (status !== "active") continue;
        filtered.push(artifact);
        if (filtered.length >= targetCount) break;
      }

      if (filtered.length >= targetCount) return filtered.slice(0, targetCount);
      if (filtered.length > bestFiltered.length) {
        bestFiltered = filtered;
      }
      if (rawResults.length === 0) return filtered;
      if (rawResults.length < fetchLimit && filtered.length > 0) return filtered;
      if (fetchLimit >= maxFetchLimit) return filtered;

      const growth = Math.max(targetCount * 2, 12);
      fetchLimit = Math.min(maxFetchLimit, fetchLimit + growth);
    }

    return bestFiltered;
  }

  private async recallArtifactsAcrossNamespaces(
    prompt: string,
    recallNamespaces: string[],
    targetCount: number,
  ): Promise<MemoryFile[]> {
    if (targetCount <= 0) return [];
    const namespaces = Array.from(new Set(recallNamespaces));
    const filteredByNamespace = await Promise.all(
      namespaces.map((namespace) => this.fetchActiveArtifactsForNamespace(namespace, prompt, targetCount)),
    );

    return mergeArtifactRecallCandidates(filteredByNamespace, targetCount);
  }

  private scopeQueryAwarePaths(
    paths: Set<string> | null,
    recallNamespaces: string[],
  ): Set<string> | null {
    if (!paths || paths.size === 0) return null;
    const scoped = new Set<string>();
    for (const memoryPath of paths) {
      if (!memoryPath || isArtifactMemoryPath(memoryPath)) continue;
      if (
        this.config.namespacesEnabled &&
        !recallNamespaces.includes(this.namespaceFromPath(memoryPath))
      ) {
        continue;
      }
      scoped.add(memoryPath);
    }
    return scoped.size > 0 ? scoped : null;
  }

  private async buildQueryAwarePrefilter(
    prompt: string,
    recallNamespaces: string[],
  ): Promise<QueryAwarePrefilter> {
    if (!this.config.queryAwareIndexingEnabled || !prompt.trim()) {
      return {
        candidatePaths: null,
        temporalFromDate: null,
        matchedTags: [],
        expandedTags: [],
        combination: "none",
        filteredToFullSearch: false,
      };
    }

    const temporalFromDate = isTemporalQuery(prompt)
      ? recencyWindowFromPrompt(prompt, Date.now())
      : null;
    const [rawTemporal, tagSignals] = await Promise.all([
      temporalFromDate
        ? queryByDateRangeAsync(this.config.memoryDir, temporalFromDate)
        : Promise.resolve<Set<string> | null>(null),
      resolvePromptTagPrefilterAsync(this.config.memoryDir, prompt).catch(() => ({
        matchedTags: extractTagsFromPrompt(prompt),
        expandedTags: extractTagsFromPrompt(prompt),
        paths: null,
      })),
    ]);

    const temporalCandidates = this.scopeQueryAwarePaths(rawTemporal, recallNamespaces);
    const tagCandidates = this.scopeQueryAwarePaths(tagSignals.paths, recallNamespaces);
    const maxCandidates = this.config.queryAwareIndexingMaxCandidates;

    let candidatePaths: Set<string> | null = null;
    let combination: QueryAwarePrefilter["combination"] = "none";
    let filteredToFullSearch = false;

    if (temporalCandidates && tagCandidates) {
      const intersection = new Set(
        Array.from(temporalCandidates).filter((memoryPath) => tagCandidates.has(memoryPath)),
      );
      if (intersection.size > 0) {
        candidatePaths = intersection;
        combination = "intersection";
      } else {
        candidatePaths = new Set([...temporalCandidates, ...tagCandidates]);
        combination = "union";
      }
    } else if (temporalCandidates) {
      candidatePaths = temporalCandidates;
      combination = "temporal";
    } else if (tagCandidates) {
      candidatePaths = tagCandidates;
      combination = "tag";
    }

    if (candidatePaths && maxCandidates > 0 && candidatePaths.size > maxCandidates) {
      filteredToFullSearch = true;
      candidatePaths = null;
    }

    return {
      candidatePaths,
      temporalFromDate,
      matchedTags: tagSignals.matchedTags,
      expandedTags: tagSignals.expandedTags,
      combination,
      filteredToFullSearch,
    };
  }

  private async searchScopedMemoryCandidates(
    candidatePaths: Set<string>,
    query: string,
    limit: number,
    options?: {
      allowArchived?: boolean;
    },
  ): Promise<QmdSearchResult[]> {
    const cappedLimit = Math.max(0, limit);
    if (cappedLimit === 0 || candidatePaths.size === 0) return [];

    const tokens = Array.from(new Set(tokenizeRecallQuery(query)));
    const memories = (
      await Promise.all(
        Array.from(candidatePaths).map(async (memoryPath) => {
          const namespace = this.config.namespacesEnabled
            ? this.namespaceFromPath(memoryPath)
            : this.config.defaultNamespace;
          const storage = await this.storageRouter.storageFor(namespace);
          return await storage.readMemoryByPath(memoryPath);
        }),
      )
    ).filter((memory): memory is MemoryFile => memory !== null);

    const results: QmdSearchResult[] = [];
    for (const memory of memories) {
      const status = memory.frontmatter.status ?? "active";
      if (!options?.allowArchived && status !== "active") continue;

      const haystack = [
        memory.content,
        memory.frontmatter.category,
        ...(memory.frontmatter.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      let hits = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) hits += 1;
      }
      const score = tokens.length > 0
        ? hits / tokens.length
        : 0.01;
      if (tokens.length > 0 && hits === 0) continue;

      results.push({
        docid: memory.frontmatter.id,
        path: memory.path,
        score,
        snippet: memory.content.slice(0, 400).replace(/\n/g, " "),
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, cappedLimit);
  }

  private async fetchQmdMemoryResultsWithArtifactTopUp(
    prompt: string,
    qmdFetchLimit: number,
    qmdHybridFetchLimit: number,
    options: {
      namespacesEnabled: boolean;
      recallNamespaces: string[];
      resolveNamespace: (path: string) => string;
      collection?: string;
      queryAwarePrefilter?: QueryAwarePrefilter;
    },
  ): Promise<QmdSearchResult[]> {
    const queryAwarePrefilter = options.queryAwarePrefilter
      ?? await this.buildQueryAwarePrefilter(prompt, options.recallNamespaces);
    const scopedSeedResults = queryAwarePrefilter.candidatePaths?.size
      ? await this.searchScopedMemoryCandidates(
        queryAwarePrefilter.candidatePaths,
        prompt,
        qmdFetchLimit,
        { allowArchived: options.collection !== undefined },
      )
      : [];

    let fetchLimit = Math.max(qmdFetchLimit, qmdHybridFetchLimit);
    const maxFetchLimit = Math.min(320, Math.max(fetchLimit, qmdFetchLimit * 5));
    const MAX_ATTEMPTS = 2;
    const QMD_RECALL_BUDGET_MS = 25_000;
    const startedAtMs = Date.now();
    let bestFiltered = filterRecallCandidates(scopedSeedResults, {
      namespacesEnabled: options.namespacesEnabled,
      recallNamespaces: options.recallNamespaces,
      resolveNamespace: options.resolveNamespace,
      limit: qmdFetchLimit,
    });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (Date.now() - startedAtMs >= QMD_RECALL_BUDGET_MS) {
        break;
      }

      const primaryResults = options.collection
        ? await this.qmd.search(prompt, options.collection, fetchLimit)
        : await this.searchAcrossNamespaces({
          query: prompt,
          namespaces: options.namespacesEnabled ? options.recallNamespaces : undefined,
          maxResults: fetchLimit,
          mode: "search",
        });
      let mergedResults = primaryResults;

      // Backfill with hybrid results only when primary retrieval underfills.
      if (
        primaryResults.length < qmdFetchLimit &&
        Date.now() - startedAtMs < QMD_RECALL_BUDGET_MS
      ) {
        const hybridResults = options.collection
          ? await this.qmd.hybridSearch(prompt, options.collection, fetchLimit)
          : await this.searchAcrossNamespaces({
            query: prompt,
            namespaces: options.namespacesEnabled ? options.recallNamespaces : undefined,
            maxResults: fetchLimit,
            mode: "hybrid",
          });
        if (hybridResults.length > 0) {
          const mergedByPath = new Map<string, QmdSearchResult>();
          for (const result of [...primaryResults, ...hybridResults]) {
            const key = result.path || result.docid;
            const existing = mergedByPath.get(key);
            if (!existing || result.score > existing.score) {
              mergedByPath.set(key, {
                ...result,
                snippet: result.snippet || existing?.snippet || "",
              });
            }
          }
          mergedResults = [...mergedByPath.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, fetchLimit);
        }
      }

      if (scopedSeedResults.length > 0) {
        const mergedByPath = new Map<string, QmdSearchResult>();
        for (const result of [...scopedSeedResults, ...mergedResults]) {
          const key = result.path || result.docid;
          const existing = mergedByPath.get(key);
          if (!existing || result.score > existing.score) {
            mergedByPath.set(key, {
              ...result,
              snippet: result.snippet || existing?.snippet || "",
            });
          }
        }
        mergedResults = [...mergedByPath.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, fetchLimit);
      }

      const filteredResults = filterRecallCandidates(mergedResults, {
        namespacesEnabled: options.namespacesEnabled,
        recallNamespaces: options.recallNamespaces,
        resolveNamespace: options.resolveNamespace,
        limit: fetchLimit,
      });

      if (filteredResults.length >= qmdFetchLimit) {
        return filteredResults.slice(0, qmdFetchLimit);
      }
      if (filteredResults.length > bestFiltered.length) {
        bestFiltered = filteredResults;
      }
      if (mergedResults.length === 0) {
        return filteredResults;
      }
      if (mergedResults.length < fetchLimit && filteredResults.length > 0) {
        return filteredResults;
      }
      if (fetchLimit >= maxFetchLimit) {
        break;
      }

      const growth = Math.max(20, Math.floor(fetchLimit / 2));
      fetchLimit = Math.min(maxFetchLimit, fetchLimit + growth);
    }

    return bestFiltered.slice(0, qmdFetchLimit);
  }

  private async expandResultsViaGraph(options: {
    memoryResults: QmdSearchResult[];
    recallNamespaces: string[];
    recallResultLimit: number;
  }): Promise<{
    merged: QmdSearchResult[];
    seedPaths: string[];
    expandedPaths: GraphRecallExpandedEntry[];
  }> {
    const byNamespace = new Map<string, QmdSearchResult[]>();
    for (const result of options.memoryResults) {
      const ns = this.namespaceFromPath(result.path);
      if (!options.recallNamespaces.includes(ns)) continue;
      const existing = byNamespace.get(ns);
      if (existing) {
        existing.push(result);
      } else {
        byNamespace.set(ns, [result]);
      }
    }

    const perNamespaceSeedCap = Math.max(3, options.recallResultLimit);
    const perNamespaceExpandedCap = Math.max(8, options.recallResultLimit * 2);
    const seedPaths: string[] = [];
    const expandedPaths: GraphRecallExpandedEntry[] = [];
    const expandedResults: QmdSearchResult[] = [];

    for (const [namespace, nsResults] of byNamespace.entries()) {
      const storage = await this.storageRouter.storageFor(namespace);
      const seedCandidates = nsResults.slice(0, perNamespaceSeedCap);
      const seedRelativePaths = seedCandidates
        .map((result) => graphPathRelativeToStorage(storage.dir, result.path))
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      if (seedRelativePaths.length === 0) continue;

      const seedRecallScore = seedCandidates.reduce((max, item) => Math.max(max, item.score), 0);
      seedPaths.push(...seedRelativePaths.map((rel) => path.join(storage.dir, rel)));
      const seedSet = new Set(seedRelativePaths);
      const expanded = await this.graphIndexFor(storage).spreadingActivation(
        seedRelativePaths,
        this.config.maxGraphTraversalSteps,
      );
      if (expanded.length === 0) continue;

      for (const candidate of expanded.slice(0, perNamespaceExpandedCap)) {
        if (seedSet.has(candidate.path)) continue;
        const memoryPath = path.resolve(storage.dir, candidate.path);
        const memory = await storage.readMemoryByPath(memoryPath);
        if (!memory) continue;
        if (isArtifactMemoryPath(memory.path)) continue;
        if (memory.frontmatter.status && memory.frontmatter.status !== "active") continue;

        const snippet = memory.content.slice(0, 400);
        const score = blendGraphExpandedRecallScore({
          graphActivationScore: candidate.score,
          seedRecallScore,
          activationWeight: this.config.graphExpansionActivationWeight,
          blendMin: this.config.graphExpansionBlendMin,
          blendMax: this.config.graphExpansionBlendMax,
        });
        expandedResults.push({
          docid: memory.frontmatter.id,
          path: memory.path,
          snippet,
          score,
        });
        expandedPaths.push({
          path: memory.path,
          score,
          namespace,
          seed: path.resolve(storage.dir, candidate.seed),
          hopDepth: candidate.hopDepth,
          decayedWeight: candidate.decayedWeight,
          graphType: candidate.graphType,
        });
      }
    }

    return {
      merged: mergeGraphExpandedResults(options.memoryResults, expandedResults),
      seedPaths,
      expandedPaths,
    };
  }

  private async recordLastGraphRecallSnapshot(options: {
    storage: StorageManager;
    prompt: string;
    recallMode: RecallPlanMode;
    recallNamespaces: string[];
    seedPaths: string[];
    expandedPaths: GraphRecallExpandedEntry[];
  }): Promise<void> {
    try {
      const snapshotPath = path.join(options.storage.dir, "state", "last_graph_recall.json");
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      const now = new Date().toISOString();
      const totalSeedCount = options.seedPaths.length;
      const totalExpandedCount = options.expandedPaths.length;
      const seeds = options.seedPaths.slice(0, 64);
      const expanded = clampGraphRecallExpandedEntries(options.expandedPaths, 64);
      const payload = {
        recordedAt: now,
        mode: options.recallMode,
        queryHash: createHash("sha256").update(options.prompt).digest("hex"),
        queryLength: options.prompt.length,
        namespaces: options.recallNamespaces,
        seedCount: totalSeedCount,
        expandedCount: totalExpandedCount,
        seeds,
        expanded,
      };
      await writeFile(snapshotPath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      log.debug(`last graph recall write failed: ${err}`);
    }
  }

  private getRecallSectionEntry(sectionId: string): RecallSectionConfig | undefined {
    const pipeline = Array.isArray(this.config.recallPipeline)
      ? this.config.recallPipeline
      : [];
    return pipeline.find((entry) => entry.id === sectionId);
  }

  private isRecallSectionEnabled(sectionId: string, defaultEnabled: boolean = true): boolean {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return defaultEnabled;
    return entry.enabled !== false;
  }

  private getRecallSectionMaxChars(sectionId: string): number | null | undefined {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return undefined;
    if (entry.maxChars === null) return null;
    if (typeof entry.maxChars !== "number") return undefined;
    return Math.max(0, Math.floor(entry.maxChars));
  }

  private getRecallSectionNumber(sectionId: string, key: keyof RecallSectionConfig): number | undefined {
    const entry = this.getRecallSectionEntry(sectionId);
    if (!entry) return undefined;
    const value = entry[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.max(0, Math.floor(value));
  }

  private appendRecallSection(
    sectionBuckets: Map<string, string[]>,
    sectionId: string,
    content: string,
  ): void {
    if (!this.isRecallSectionEnabled(sectionId)) return;
    const trimmed = content.trim();
    if (trimmed.length === 0) return;

    const maxChars = this.getRecallSectionMaxChars(sectionId);
    let finalContent = trimmed;
    if (maxChars === 0) return;
    if (typeof maxChars === "number" && finalContent.length > maxChars) {
      finalContent = `${finalContent.slice(0, maxChars)}\n\n...(trimmed)\n`;
    }

    const existing = sectionBuckets.get(sectionId) ?? [];
    existing.push(finalContent);
    sectionBuckets.set(sectionId, existing);
  }

  private assembleRecallSections(sectionBuckets: Map<string, string[]>): string[] {
    const ordered: string[] = [];
    const pipeline = Array.isArray(this.config.recallPipeline)
      ? this.config.recallPipeline
      : [];
    const orderedIds = pipeline
      .filter((entry) => entry.enabled !== false)
      .map((entry) => entry.id);
    const seen = new Set<string>();

    for (const id of orderedIds) {
      const chunks = sectionBuckets.get(id);
      if (!chunks || chunks.length === 0) continue;
      ordered.push(chunks.join("\n\n"));
      seen.add(id);
    }

    for (const [id, chunks] of sectionBuckets.entries()) {
      if (seen.has(id)) continue;
      if (chunks.length === 0) continue;
      ordered.push(chunks.join("\n\n"));
    }

    return ordered;
  }

  private async recallInternal(prompt: string, sessionKey?: string): Promise<string> {
    const recallStart = Date.now();
    const timings: Record<string, string> = {};
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const traceId = createHash("sha256")
      .update(`${sessionKey ?? "default"}:${recallStart}:${promptHash}`)
      .digest("hex")
      .slice(0, 16);
    const sectionBuckets = new Map<string, string[]>();
    const queryPolicy = buildRecallQueryPolicy(prompt, sessionKey, {
      cronRecallPolicyEnabled: this.config.cronRecallPolicyEnabled,
      cronRecallNormalizedQueryMaxChars: this.config.cronRecallNormalizedQueryMaxChars,
      cronRecallInstructionHeavyTokenCap: this.effectiveCronRecallInstructionHeavyTokenCap(),
      cronConversationRecallMode: this.config.cronConversationRecallMode,
    });
    const retrievalQuery = queryPolicy.retrievalQuery || prompt;
    const retrievalQueryHash = createHash("sha256").update(retrievalQuery).digest("hex");
    const policyVersion = this.currentPolicyVersion();
    let impressionRecorded = false;
    let recallSource: "none" | "hot_qmd" | "hot_embedding" | "cold_fallback" | "recent_scan" = "none";
    let recalledMemoryCount = 0;
    let recalledMemoryIds: string[] = [];
    let recalledMemoryPaths: string[] = [];
    let identityInjectionModeUsed: IdentityInjectionMode | "none" = "none";
    let identityInjectedChars = 0;
    let identityInjectionTruncated = false;
    timings.queryPolicy = `${queryPolicy.promptShape}/${queryPolicy.retrievalBudgetMode}${queryPolicy.skipConversationRecall ? "/skip-conv" : ""}`;
    const recallMode: RecallPlanMode = resolveEffectiveRecallMode({
      plannerEnabled: this.config.recallPlannerEnabled,
      graphRecallEnabled: this.config.graphRecallEnabled,
      multiGraphMemoryEnabled: this.config.multiGraphMemoryEnabled,
      graphExpandedIntentEnabled: this.config.graphExpandedIntentEnabled === true,
      prompt,
    });
    timings.recallPlan = recallMode;
    const plannerRecallResultLimit = recallMode === "no_recall"
      ? 0
      : recallMode === "minimal"
      ? Math.max(0, Math.min(this.config.qmdMaxResults, this.config.recallPlannerMaxQmdResultsMinimal))
      : this.config.qmdMaxResults;
    const policyMinimalLimit = Math.max(
      0,
      Math.min(this.config.qmdMaxResults, this.config.recallPlannerMaxQmdResultsMinimal),
    );
    const baseRecallResultLimit =
      recallMode !== "no_recall" && queryPolicy.retrievalBudgetMode === "minimal"
        ? Math.min(plannerRecallResultLimit, policyMinimalLimit)
        : plannerRecallResultLimit;
    const memoriesSectionEnabled = this.isRecallSectionEnabled("memories");
    const memorySectionMaxResults = this.getRecallSectionNumber("memories", "maxResults");
    const recallResultLimit = memoriesSectionEnabled
      ? memorySectionMaxResults !== undefined
        ? Math.min(baseRecallResultLimit, memorySectionMaxResults)
        : baseRecallResultLimit
      : 0;
    const recallHeadroom = this.config.verbatimArtifactsEnabled
      ? Math.max(12, this.config.verbatimArtifactsMaxRecall * 4)
      : 12;
    const computedFetchLimit = recallResultLimit === 0
      ? 0
      : Math.max(recallResultLimit, Math.min(200, recallResultLimit + recallHeadroom));
    const qmdFetchLimit = computedFetchLimit;
    const qmdHybridFetchLimit = computeQmdHybridFetchLimit(
      qmdFetchLimit,
      this.config.verbatimArtifactsEnabled,
      this.config.verbatimArtifactsMaxRecall,
    );
    const embeddingFetchLimit = computedFetchLimit;

    if (recallMode === "no_recall") {
      // Clean up workspace override before early return to prevent Map leaks.
      const earlySessionKey = sessionKey ?? "default";
      this._recallWorkspaceOverrides.delete(earlySessionKey);
      timings.total = `${Date.now() - recallStart}ms`;
      if (sessionKey) {
        this.queueEvalShadowRecall({
          traceId,
          recordedAt: new Date().toISOString(),
          sessionKey,
          promptHash,
          promptLength: prompt.length,
          retrievalQueryHash,
          retrievalQueryLength: retrievalQuery.length,
          recallMode,
          recallResultLimit,
          source: recallSource,
          recalledMemoryCount,
          injected: false,
          contextChars: 0,
          memoryIds: [],
          policyVersion,
          identityInjectionMode: identityInjectionModeUsed,
          identityInjectedChars,
          identityInjectionTruncated,
          durationMs: Date.now() - recallStart,
          timings: { ...timings },
        });
      }
      this.emitTrace({
        kind: "recall_summary",
        traceId,
        operation: "recall",
        sessionKey,
        promptHash,
        promptLength: prompt.length,
        retrievalQueryHash,
        retrievalQueryLength: retrievalQuery.length,
        recallMode,
        recallResultLimit,
        qmdEnabled: this.config.qmdEnabled,
        qmdAvailable: this.qmd.isAvailable(),
        recallNamespaces: [],
        source: recallSource,
        recalledMemoryCount,
        injected: false,
        contextChars: 0,
        policyVersion,
        identityInjectionMode: identityInjectionModeUsed,
        identityInjectedChars,
        identityInjectionTruncated,
        durationMs: Date.now() - recallStart,
        timings: { ...timings },
      });
      return "";
    }

    const principal = resolvePrincipal(sessionKey, this.config);
    const selfNamespace = defaultNamespaceForPrincipal(principal, this.config);
    const recallNamespaces = recallNamespacesForPrincipal(principal, this.config);
    const profileStorage = await this.storageRouter.storageFor(selfNamespace);

    // --- Phase 1: Launch ALL independent data fetches in parallel ---

    // 0. Shared context (v4.0, optional)
    const sharedContextPromise = (async (): Promise<string | null> => {
      if (!this.isRecallSectionEnabled("shared-context", this.config.sharedContextEnabled === true)) return null;
      if (!this.sharedContext) return null;
      const t0 = Date.now();
      const [priorities, roundtable] = await Promise.all([
        this.sharedContext.readPriorities(),
        this.sharedContext.readLatestRoundtable(),
      ]);
      const combined =
        [
          "## Shared Context",
          "",
          priorities ? "### Priorities\n\n" + priorities.trim() : "",
          roundtable ? "\n\n### Latest Roundtable\n\n" + roundtable.trim() : "",
        ]
          .filter((s) => s.trim().length > 0)
          .join("\n");

      const max = Math.max(500, this.config.sharedContextMaxInjectChars);
      const trimmed =
        combined.length > max ? combined.slice(0, max) + "\n\n...(trimmed)\n" : combined;
      timings.sharedCtx = `${Date.now() - t0}ms`;
      return trimmed.trim().length > 0 ? trimmed : null;
    })();

    // 1. Profile
    const profilePromise = (async (): Promise<string | null> => {
      if (!this.isRecallSectionEnabled("profile")) return null;
      const t0 = Date.now();
      const profile = await profileStorage.readProfile();
      timings.profile = `${Date.now() - t0}ms`;
      return profile || null;
    })();

    // 1a. Identity continuity signals (v8.4)
    const identityContinuityPromise = (async () => {
      if (!this.isRecallSectionEnabled("identity-continuity", this.config.identityContinuityEnabled === true)) return null;
      const t0 = Date.now();
      const section = await this.buildIdentityContinuitySection({
        storage: profileStorage,
        recallMode,
        prompt: retrievalQuery,
      });
      timings.identityContinuity = `${Date.now() - t0}ms`;
      return section;
    })();

    // 1b. Knowledge Index (v7.0)
    const knowledgeIndexPromise = (async (): Promise<{ result: string; cached: boolean } | null> => {
      if (!this.isRecallSectionEnabled("knowledge-index", this.config.knowledgeIndexEnabled)) return null;
      if (!this.config.knowledgeIndexEnabled) return null;
      const t0 = Date.now();
      try {
        const ki = await this.storage.buildKnowledgeIndex(this.config, {
          maxEntities: this.getRecallSectionNumber("knowledge-index", "maxEntities"),
          maxChars: this.getRecallSectionNumber("knowledge-index", "maxChars"),
        });
        timings.ki = `${Date.now() - t0}ms${ki.cached ? " (cached)" : ""}`;
        return ki.result ? ki : null;
      } catch (err) {
        timings.ki = `${Date.now() - t0}ms (err)`;
        log.warn(`Knowledge Index build failed: ${err}`);
        return null;
      }
    })();

    // 1c. Verbatim artifacts (v8.0 phase 1)
    const artifactsPromise = (async (): Promise<MemoryFile[]> => {
      if (!this.isRecallSectionEnabled("verbatim-artifacts", this.config.verbatimArtifactsEnabled === true)) return [];
      if (!this.config.verbatimArtifactsEnabled) return [];
      const t0 = Date.now();
      const targetCount = computeArtifactRecallLimit(
        recallMode,
        recallResultLimit,
        this.config.verbatimArtifactsMaxRecall,
      );
      if (targetCount <= 0) {
        timings.artifacts = "skip(limit=0)";
        return [];
      }
      const results = await this.recallArtifactsAcrossNamespaces(
        retrievalQuery,
        recallNamespaces,
        targetCount,
      );

      timings.artifacts = `${Date.now() - t0}ms`;
      return results;
    })();

    const objectiveStatePromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.objectiveStateMemoryEnabled ||
        !this.config.objectiveStateRecallEnabled ||
        !this.isRecallSectionEnabled("objective-state", this.config.objectiveStateRecallEnabled === true)
      ) {
        timings.objectiveState = "skip";
        return null;
      }
      const maxResults = this.getRecallSectionNumber("objective-state", "maxResults") ?? 4;
      if (maxResults <= 0) {
        timings.objectiveState = "skip(limit=0)";
        return null;
      }

      const results = await searchObjectiveStateSnapshots({
        memoryDir: this.config.memoryDir,
        objectiveStateStoreDir: this.config.objectiveStateStoreDir,
        query: retrievalQuery,
        maxResults,
        sessionKey,
      });

      timings.objectiveState = `${Date.now() - t0}ms`;
      return results.length > 0 ? this.formatObjectiveStateResults(results) : null;
    })();

    const causalTrajectoryPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.causalTrajectoryMemoryEnabled ||
        !this.config.causalTrajectoryRecallEnabled ||
        !this.isRecallSectionEnabled("causal-trajectories", this.config.causalTrajectoryRecallEnabled === true)
      ) {
        timings.causalTrajectories = "skip";
        return null;
      }
      const maxResults = this.getRecallSectionNumber("causal-trajectories", "maxResults") ?? 3;
      if (maxResults <= 0) {
        timings.causalTrajectories = "skip(limit=0)";
        return null;
      }

      const results = await searchCausalTrajectories({
        memoryDir: this.config.memoryDir,
        causalTrajectoryStoreDir: this.config.causalTrajectoryStoreDir,
        query: retrievalQuery,
        maxResults,
        sessionKey,
      });

      timings.causalTrajectories = `${Date.now() - t0}ms`;
      return results.length > 0 ? this.formatCausalTrajectoryResults(results) : null;
    })();

    const trustZonePromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.trustZonesEnabled ||
        !this.config.trustZoneRecallEnabled ||
        !this.isRecallSectionEnabled("trust-zones", this.config.trustZoneRecallEnabled === true)
      ) {
        timings.trustZones = "skip";
        return null;
      }
      const maxResults = this.getRecallSectionNumber("trust-zones", "maxResults") ?? 3;
      if (maxResults <= 0) {
        timings.trustZones = "skip(limit=0)";
        return null;
      }

      const results = await searchTrustZoneRecords({
        memoryDir: this.config.memoryDir,
        trustZoneStoreDir: this.config.trustZoneStoreDir,
        query: retrievalQuery,
        maxResults,
        sessionKey,
      });

      timings.trustZones = `${Date.now() - t0}ms`;
      return results.length > 0 ? this.formatTrustZoneResults(results) : null;
    })();

    const harmonicRetrievalPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.harmonicRetrievalEnabled ||
        !this.isRecallSectionEnabled("harmonic-retrieval", this.config.harmonicRetrievalEnabled === true)
      ) {
        timings.harmonicRetrieval = "skip";
        return null;
      }
      const maxResults = this.getRecallSectionNumber("harmonic-retrieval", "maxResults") ?? 3;
      if (maxResults <= 0) {
        timings.harmonicRetrieval = "skip(limit=0)";
        return null;
      }

      const results = await searchHarmonicRetrieval({
        memoryDir: this.config.memoryDir,
        abstractionNodeStoreDir: this.config.abstractionNodeStoreDir,
        query: retrievalQuery,
        maxResults,
        sessionKey,
        anchorsEnabled: this.config.abstractionAnchorsEnabled,
      });

      timings.harmonicRetrieval = `${Date.now() - t0}ms`;
      return results.length > 0 ? this.formatHarmonicRetrievalResults(results) : null;
    })();

    const verifiedRecallPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.verifiedRecallEnabled ||
        !this.isRecallSectionEnabled("verified-episodes", this.config.verifiedRecallEnabled === true)
      ) {
        timings.verifiedRecall = "skip";
        return null;
      }
      const maxResults = this.getRecallSectionNumber("verified-episodes", "maxResults") ?? 3;
      if (maxResults <= 0) {
        timings.verifiedRecall = "skip(limit=0)";
        return null;
      }

      const results = await searchVerifiedEpisodes({
        memoryDir: this.config.memoryDir,
        query: retrievalQuery,
        maxResults,
        boxRecallDays: this.config.boxRecallDays,
      });

      timings.verifiedRecall = `${Date.now() - t0}ms`;
      return results.length > 0 ? this.formatVerifiedEpisodeResults(results) : null;
    })();

    const verifiedRulesPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.semanticRuleVerificationEnabled ||
        !this.isRecallSectionEnabled("verified-rules", this.config.semanticRuleVerificationEnabled === true)
      ) {
        timings.verifiedRules = "skip";
        return null;
      }
      const maxResults = this.getRecallSectionNumber("verified-rules", "maxResults") ?? 3;
      if (maxResults <= 0) {
        timings.verifiedRules = "skip(limit=0)";
        return null;
      }

      const results = await searchVerifiedSemanticRules({
        memoryDir: this.config.memoryDir,
        query: retrievalQuery,
        maxResults,
      });

      timings.verifiedRules = `${Date.now() - t0}ms`;
      return results.length > 0 ? this.formatVerifiedSemanticRuleResults(results) : null;
    })();

    const workProductsPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.creationMemoryEnabled ||
        !this.config.workProductRecallEnabled ||
        !this.isRecallSectionEnabled("work-products", this.config.workProductRecallEnabled === true)
      ) {
        timings.workProducts = "skip";
        return null;
      }
      const maxResults = this.getRecallSectionNumber("work-products", "maxResults") ?? 3;
      if (maxResults <= 0) {
        timings.workProducts = "skip(limit=0)";
        return null;
      }

      const results = await searchWorkProductLedgerEntries({
        memoryDir: this.config.memoryDir,
        workProductLedgerDir: this.config.workProductLedgerDir,
        query: retrievalQuery,
        maxResults,
        sessionKey,
      });

      timings.workProducts = `${Date.now() - t0}ms`;
      return results.length > 0 ? this.formatWorkProductResults(results) : null;
    })();

    const queryAwarePrefilterPromise = (async (): Promise<QueryAwarePrefilter> => {
      const t0 = Date.now();
      if (!this.config.queryAwareIndexingEnabled || !prompt.trim()) {
        timings.queryAware = "skip";
        return {
          candidatePaths: null,
          temporalFromDate: null,
          matchedTags: [],
          expandedTags: [],
          combination: "none",
          filteredToFullSearch: false,
        };
      }

      const prefilter = await this.buildQueryAwarePrefilter(retrievalQuery, recallNamespaces);
      const candidateCount = prefilter.candidatePaths?.size ?? 0;
      const temporalLabel = prefilter.temporalFromDate ?? "-";
      const tagLabel = prefilter.expandedTags.length > 0 ? prefilter.expandedTags.join("|") : "-";
      const fallbackLabel = prefilter.filteredToFullSearch ? "/full-search" : "";
      timings.queryAware =
        `${Date.now() - t0}ms(${prefilter.combination}${fallbackLabel};count=${candidateCount};time=${temporalLabel};tags=${tagLabel})`;
      return prefilter;
    })();

    // 2. QMD search (the slow part — runs in parallel with preamble)
    type QmdPhaseResult = {
      memoryResultsLists: QmdSearchResult[][];
      globalResults: QmdSearchResult[];
    } | null;

    const qmdPromise = (async (): Promise<QmdPhaseResult> => {
      if (recallResultLimit <= 0) {
        timings.qmd = "skip(limit=0)";
        return null;
      }
      if (!this.qmd.isAvailable()) {
        timings.qmd = "skip";
        log.debug(`Search skip: ${this.qmd.debugStatus()}`);
        return null;
      }
      const t0 = Date.now();
      const queryAwarePrefilter = await queryAwarePrefilterPromise;
      // Hybrid search: parallel BM25 + vector, merged by path.
      // Much faster than `qmd query` (LLM expansion + reranking) which
      // takes 30-70s and causes recall timeouts.
      const filteredResults = await this.fetchQmdMemoryResultsWithArtifactTopUp(
        retrievalQuery,
        qmdFetchLimit,
        qmdHybridFetchLimit,
        {
          namespacesEnabled: this.config.namespacesEnabled,
          recallNamespaces,
          resolveNamespace: (p) => this.namespaceFromPath(p),
          queryAwarePrefilter,
        },
      );

      timings.qmd = `${Date.now() - t0}ms`;
      return { memoryResultsLists: [filteredResults], globalResults: [] };
    })();

    const transcriptPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (!this.config.transcriptEnabled || !this.isRecallSectionEnabled("transcript", true)) {
        timings.transcript = "skip";
        return null;
      }
      const transcriptMaxTokens = this.getRecallSectionNumber("transcript", "maxTokens")
        ?? this.config.maxTranscriptTokens;
      const transcriptMaxTurns = this.getRecallSectionNumber("transcript", "maxTurns")
        ?? this.config.maxTranscriptTurns;
      const transcriptLookbackHours = this.getRecallSectionNumber("transcript", "lookbackHours")
        ?? this.config.transcriptRecallHours;
      if (transcriptMaxTokens === 0 || transcriptMaxTurns === 0 || transcriptLookbackHours === 0) {
        timings.transcript = "skip(limit=0)";
        return null;
      }

      let section: string | null = null;
      // Try checkpoint first (post-compaction recovery)
      let checkpointInjected = false;
      if (this.config.checkpointEnabled) {
        const checkpoint = await this.transcript.loadCheckpoint(sessionKey);
        log.debug(`recall: checkpoint loaded, turns=${checkpoint?.turns?.length ?? 0}`);
        if (checkpoint && checkpoint.turns.length > 0) {
          const formatted = this.transcript.formatForRecall(checkpoint.turns, transcriptMaxTokens);
          if (formatted) {
            section = `## Working Context (Recovered)\n\n${formatted}`;
            checkpointInjected = true;
            // Clear checkpoint after injection
            await this.transcript.clearCheckpoint();
          }
        }
      }

      if (!checkpointInjected) {
        const entries = await this.transcript.readRecent(transcriptLookbackHours, sessionKey);
        log.debug(`recall: read ${entries.length} transcript entries for sessionKey=${sessionKey}`);

        // Apply max turns cap
        const cappedEntries = entries.slice(-transcriptMaxTurns);
        if (cappedEntries.length > 0) {
          log.debug(`recall: injecting ${cappedEntries.length} transcript entries`);
          const formatted = this.transcript.formatForRecall(cappedEntries, transcriptMaxTokens);
          if (formatted) section = formatted;
        }
      }

      timings.transcript = `${Date.now() - t0}ms`;
      return section;
    })();

    // Compaction reset runs independently of transcript — it must work even when
    // transcriptEnabled=false, since compaction recovery is a separate concern.
    const compactionPromise = (async (): Promise<string | null> => {
      // Always clean up per-session workspace overrides, even if the feature is off,
      // to prevent the Map from accumulating stale entries on long-running gateways.
      const effectiveSessionKey = sessionKey ?? "default";
      const compactionWorkspaceDir = this._recallWorkspaceOverrides.get(effectiveSessionKey);
      this._recallWorkspaceOverrides.delete(effectiveSessionKey);

      if (!this.config.compactionResetEnabled) return null;

      const workspaceDir =
        compactionWorkspaceDir ||
        this.config.workspaceDir ||
        defaultWorkspaceDir();
      const safeSessionKey = sanitizeSessionKeyForFilename(effectiveSessionKey);
      const signalPath = path.join(workspaceDir, `.compaction-reset-signal-${safeSessionKey}`);
      const bootPath = path.join(workspaceDir, "BOOT.md");

      try {
        const signalStat = await stat(signalPath).catch(() => null);
        if (!signalStat) return null;

        const signalAge = Date.now() - signalStat.mtimeMs;
        const signalData = JSON.parse(await readFile(signalPath, "utf-8"));

        // Validate signal belongs to this session (defense-in-depth: filename
        // is already per-session, but the sessionKey inside provides a second check).
        // Use strict !== so missing/null sessionKey also fails validation.
        if (signalData.sessionKey !== effectiveSessionKey) {
          log.debug(
            `recall: compaction signal is for ${signalData.sessionKey}, not ${effectiveSessionKey} — skipping`,
          );
          return null;
        }

        if (signalAge >= COMPACTION_SIGNAL_MAX_AGE_MS) {
          log.debug(
            `recall: stale compaction signal (${Math.round(signalAge / 1000)}s old), skipping`,
          );
          await unlink(signalPath).catch(() => {});
          return null;
        }

        // Signal is fresh and belongs to this session — build recovery context
        let section = "\n\n## Session Recovery (Post-Compaction)\n\n";
        section += `⚠️ A compaction occurred at ${signalData.compactedAt} and this is a fresh session.\n\n`;

        try {
          const bootContent = await readFile(bootPath, "utf-8");
          section += "### BOOT.md (working state before compaction)\n\n";
          section += bootContent + "\n";
        } catch {
          section += "### ⚠️ BOOT.md is MISSING\n\n";
          section += "The memory flush may not have written BOOT.md before compaction. ";
          section += "Ask the user what you were working on — do not guess.\n";
        }

        log.info(`recall: injected compaction reset context for ${effectiveSessionKey}`);
        await unlink(signalPath).catch(() => {});
        return section;
      } catch (err) {
        log.debug("recall: compaction signal check failed:", err);
        // Remove corrupt/unreadable signal files so they don't cause repeated
        // parse failures on every recall() until the 1-hour sweep runs.
        await unlink(signalPath).catch(() => {});
        return null;
      }
    })();

    const summariesPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (!this.config.hourlySummariesEnabled || !sessionKey || !this.isRecallSectionEnabled("summaries", true)) {
        timings.summaries = "skip";
        return null;
      }
      const summariesLookbackHours = this.getRecallSectionNumber("summaries", "lookbackHours")
        ?? this.config.summaryRecallHours;
      const summariesMaxCount = this.getRecallSectionNumber("summaries", "maxCount")
        ?? this.config.maxSummaryCount;
      if (summariesLookbackHours <= 0 || summariesMaxCount <= 0) {
        timings.summaries = "skip(limit=0)";
        return null;
      }

      const summaries = await this.summarizer.readRecent(sessionKey, summariesLookbackHours);
      const cappedSummaries = summaries.slice(0, summariesMaxCount);
      const section =
        cappedSummaries.length > 0
          ? this.summarizer.formatForRecall(cappedSummaries, summariesMaxCount)
          : null;
      timings.summaries = `${Date.now() - t0}ms`;
      return section;
    })();

    const nativeKnowledgePromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.nativeKnowledge?.enabled ||
        !this.isRecallSectionEnabled("native-knowledge", this.config.nativeKnowledge.enabled)
      ) {
        timings.nativeKnowledge = "skip";
        return null;
      }
      if (this.config.nativeKnowledge.maxResults === 0 || this.config.nativeKnowledge.maxChars === 0) {
        timings.nativeKnowledge = "skip(limit=0)";
        return null;
      }

      const chunks = await collectNativeKnowledgeChunks({
        workspaceDir: this.config.workspaceDir,
        memoryDir: this.config.memoryDir,
        config: this.config.nativeKnowledge,
        recallNamespaces: this.config.namespacesEnabled ? recallNamespaces : undefined,
        defaultNamespace: this.config.defaultNamespace,
      }).catch(() => []);
      const results = searchNativeKnowledge({
        query: retrievalQuery,
        chunks,
        maxResults:
          this.getRecallSectionNumber("native-knowledge", "maxResults")
            ?? this.config.nativeKnowledge.maxResults,
      });
      const section = formatNativeKnowledgeSection({
        results,
        maxChars:
          this.getRecallSectionNumber("native-knowledge", "maxChars")
            ?? this.config.nativeKnowledge.maxChars,
      });
      timings.nativeKnowledge = `${Date.now() - t0}ms`;
      return section;
    })();

    const conversationRecallPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (
        !this.config.conversationIndexEnabled ||
        queryPolicy.skipConversationRecall ||
        !this.isRecallSectionEnabled("conversation-recall", true)
      ) {
        timings.convRecall = "skip";
        return null;
      }

      const topKOverride = this.getRecallSectionNumber("conversation-recall", "topK");
      if (topKOverride === 0) {
        timings.convRecall = "skip(topK=0)";
        return null;
      }

      const startedAtMs = Date.now();
      const timeoutMs = Math.max(
        200,
        this.getRecallSectionNumber("conversation-recall", "timeoutMs")
          ?? this.config.conversationRecallTimeoutMs,
      );
      const topK = Math.max(
        1,
        topKOverride
          ?? this.config.conversationRecallTopK,
      );
      const maxChars = Math.max(
        400,
        this.getRecallSectionNumber("conversation-recall", "maxChars")
          ?? this.config.conversationRecallMaxChars,
      );

      const results = (await Promise.race([
        this.searchConversationRecallResults(retrievalQuery, topK),
        new Promise<[]>(resolve => setTimeout(() => resolve([]), timeoutMs)),
      ]).catch(() => [])) as Array<{ path: string; snippet: string; score: number }>;

      const durationMs = Date.now() - startedAtMs;
      if (durationMs >= timeoutMs) {
        log.debug(`conversation recall: timed out after ${timeoutMs}ms`);
      }

      const section = this.formatConversationRecallSection(results, maxChars);
      timings.convRecall = `${Date.now() - t0}ms`;
      return section;
    })();

    const compoundingPromise = (async (): Promise<string | null> => {
      const t0 = Date.now();
      if (!this.compounding || !this.config.compoundingInjectEnabled || !this.isRecallSectionEnabled("compounding", true)) {
        timings.compounding = "skip";
        return null;
      }
      const mistakes = await this.compounding.readMistakes();
      if (!mistakes || !Array.isArray(mistakes.patterns) || mistakes.patterns.length === 0) {
        timings.compounding = `${Date.now() - t0}ms`;
        return null;
      }
      const maxPatterns = this.getRecallSectionNumber("compounding", "maxPatterns") ?? 40;
      if (maxPatterns === 0) {
        timings.compounding = "skip(limit=0)";
        return null;
      }
      const lines: string[] = [
        "## Institutional Learning (Compounded)",
        "",
        "Avoid repeating these patterns:",
        ...mistakes.patterns.slice(0, maxPatterns).map((p) => `- ${p}`),
      ];
      timings.compounding = `${Date.now() - t0}ms`;
      return lines.join("\n");
    })();

    // --- Wait for all parallel work ---
    const [
      sharedCtx,
      profile,
      identityContinuity,
      kiResult,
      artifacts,
      objectiveStateSection,
      causalTrajectorySection,
      trustZoneSection,
      harmonicRetrievalSection,
      verifiedRecallSection,
      verifiedRulesSection,
      workProductsSection,
      qmdResult,
      transcriptSection,
      compactionSection,
      summariesSection,
      nativeKnowledgeSection,
      conversationRecallSection,
      compoundingSection,
    ] = await Promise.all([
      sharedContextPromise,
      profilePromise,
      identityContinuityPromise,
      knowledgeIndexPromise,
      artifactsPromise,
      objectiveStatePromise,
      causalTrajectoryPromise,
      trustZonePromise,
      harmonicRetrievalPromise,
      verifiedRecallPromise,
      verifiedRulesPromise,
      workProductsPromise,
      qmdPromise,
      transcriptPromise,
      compactionPromise,
      summariesPromise,
      nativeKnowledgePromise,
      conversationRecallPromise,
      compoundingPromise,
    ]);

    // --- Phase 2: Assemble sections in correct order ---

    // 0. Shared context
    if (sharedCtx) this.appendRecallSection(sectionBuckets, "shared-context", sharedCtx);

    // 1. Profile
    if (profile) this.appendRecallSection(sectionBuckets, "profile", `## User Profile\n\n${profile}`);

    // 1a. Identity continuity
    if (identityContinuity) {
      this.appendRecallSection(sectionBuckets, "identity-continuity", identityContinuity.section);
      identityInjectionModeUsed = identityContinuity.mode;
      identityInjectedChars = identityContinuity.injectedChars;
      identityInjectionTruncated = identityContinuity.truncated;
    }

    // 1b. Knowledge Index
    if (kiResult?.result) {
      this.appendRecallSection(sectionBuckets, "knowledge-index", kiResult.result);
      log.debug(`Knowledge Index: ${kiResult.result.split("\n").length - 4} entities, ${kiResult.result.length} chars${kiResult.cached ? " (cached)" : ""}`);
    }

    if (nativeKnowledgeSection) {
      this.appendRecallSection(sectionBuckets, "native-knowledge", nativeKnowledgeSection);
    }

    // 1c. Verbatim artifacts (quote-first anchors)
    if (artifacts.length > 0) {
      const lines = artifacts.map((a) => {
        const artifactType = a.frontmatter.artifactType ?? "fact";
        const createdRaw = typeof a.frontmatter.created === "string" ? a.frontmatter.created : "";
        const created = createdRaw ? createdRaw.slice(0, 19).replace("T", " ") : "unknown-time";
        return `- [${artifactType}] "${this.truncateArtifactForRecall(a.content)}" (${created})`;
      });
      this.appendRecallSection(sectionBuckets, "verbatim-artifacts", `## Verbatim Artifacts\n\n${lines.join("\n")}`);
    }

    // 1d. Memory Boxes (topic continuity windows, v8.0 Phase 2A)
    if (
      this.isRecallSectionEnabled("memory-boxes", this.config.memoryBoxesEnabled === true) &&
      this.config.memoryBoxesEnabled &&
      this.config.boxRecallDays > 0
    ) {
      const recentBoxes = await this.boxBuilderFor(profileStorage)
        .readRecentBoxes(this.config.boxRecallDays)
        .catch(() => []);
      if (recentBoxes.length > 0) {
        const boxLines = recentBoxes.slice(0, 5).map((b: BoxFrontmatter) => {
          const sealedDate = b.sealedAt ? b.sealedAt.slice(0, 16).replace("T", " ") : "?";
          const traceNote = b.traceId ? ` [trace: ${b.traceId.slice(0, 12)}]` : "";
          return `- [${sealedDate}${traceNote}] Topics: ${b.topics.join(", ")} (${b.memoryIds.length} memories)`;
        });
        this.appendRecallSection(sectionBuckets, "memory-boxes", `## Recent Topic Windows\n\n${boxLines.join("\n")}`);
      }
    }

    // 1e. TMT node (temporal memory tree, v8.2)
    if (
      this.isRecallSectionEnabled("temporal-memory-tree", this.config.temporalMemoryTreeEnabled === true) &&
      this.config.temporalMemoryTreeEnabled &&
      recallMode !== "minimal" &&
      (recallMode as RecallPlanMode) !== "no_recall"
    ) {
      const tmtNode = await this.tmtBuilder.getMostRelevantNode();
      if (tmtNode) {
        const levelLabel = tmtNode.level.charAt(0).toUpperCase() + tmtNode.level.slice(1);
        this.appendRecallSection(sectionBuckets, "temporal-memory-tree", `## Memory Timeline (${levelLabel})\n\n${tmtNode.summary}`);
      }
    }

    if (objectiveStateSection) {
      this.appendRecallSection(sectionBuckets, "objective-state", objectiveStateSection);
    }

    if (causalTrajectorySection) {
      this.appendRecallSection(sectionBuckets, "causal-trajectories", causalTrajectorySection);
    }

    if (trustZoneSection) {
      this.appendRecallSection(sectionBuckets, "trust-zones", trustZoneSection);
    }

    if (harmonicRetrievalSection) {
      this.appendRecallSection(sectionBuckets, "harmonic-retrieval", harmonicRetrievalSection);
    }

    if (verifiedRecallSection) {
      this.appendRecallSection(sectionBuckets, "verified-episodes", verifiedRecallSection);
    }

    if (verifiedRulesSection) {
      this.appendRecallSection(sectionBuckets, "verified-rules", verifiedRulesSection);
    }

    if (workProductsSection) {
      this.appendRecallSection(sectionBuckets, "work-products", workProductsSection);
    }

    // 2. QMD results — post-process and format
    if (qmdResult) {
      const t0 = Date.now();
      const { memoryResultsLists, globalResults } = qmdResult;

      // Merge/dedupe by path; keep the best score and first non-empty snippet.
      const memoryResultsRaw = mergeGraphExpandedResults(memoryResultsLists.flat(), []);

      let memoryResults = memoryResultsRaw;

      // Enforce namespace read policies by filtering paths.
      if (this.config.namespacesEnabled) {
        memoryResults = memoryResults.filter((r) =>
          recallNamespaces.includes(this.namespaceFromPath(r.path)),
        );
      }
      // Artifacts are injected through dedicated verbatim recall flow only.
      memoryResults = memoryResults.filter((r) => !isArtifactMemoryPath(r.path));

      const isFullModeGraphAssist =
        this.config.multiGraphMemoryEnabled &&
        this.config.graphAssistInFullModeEnabled !== false &&
        recallMode === "full" &&
        memoryResults.length >= Math.max(1, this.config.graphAssistMinSeedResults ?? 3);
      const shouldRunGraphExpansion =
        recallMode === "graph_mode" ||
        isFullModeGraphAssist;
      const graphShadowEvalEnabled =
        isFullModeGraphAssist &&
        this.config.graphAssistShadowEvalEnabled === true;
      if (shouldRunGraphExpansion) {
        const baselineMemoryResults = memoryResults;
        const {
          merged,
          seedPaths,
          expandedPaths,
        } = await this.expandResultsViaGraph({
          memoryResults,
          recallNamespaces,
          recallResultLimit,
        });
        memoryResults = graphShadowEvalEnabled ? baselineMemoryResults : merged;

        if (graphShadowEvalEnabled) {
          const comparison = summarizeGraphShadowComparison(
            baselineMemoryResults,
            merged,
            recallResultLimit,
          );
          timings.graphShadow =
            `on b=${comparison.baselineCount} g=${comparison.graphCount} ` +
            `ov=${comparison.overlapCount} (${comparison.overlapRatio.toFixed(2)}) ` +
            `avgDelta=${comparison.averageOverlapDelta.toFixed(3)}`;
        }

        await this.recordLastGraphRecallSnapshot({
          storage: profileStorage,
          prompt: retrievalQuery,
          recallMode,
          recallNamespaces,
          seedPaths,
          expandedPaths,
        });
      }

      // Apply recency and access count boosting
      memoryResults = await this.boostSearchResults(memoryResults, recallNamespaces, retrievalQuery);

      // Optional LLM reranking (default off). Fail-open if rerank fails/slow.
      if (this.config.rerankEnabled && this.config.rerankProvider === "local") {
        const ranked = await rerankLocalOrNoop({
          query: retrievalQuery,
          candidates: memoryResults.slice(0, this.config.rerankMaxCandidates).map((r) => ({
            id: r.path,
            snippet: r.snippet || r.path,
          })),
          local: this.fastLlm,
          enabled: true,
          timeoutMs: this.config.rerankTimeoutMs,
          maxCandidates: this.config.rerankMaxCandidates,
          cache: this.rerankCache,
          cacheEnabled: this.config.rerankCacheEnabled,
          cacheTtlMs: this.config.rerankCacheTtlMs,
        });
        if (ranked && ranked.length > 0) {
          const byPath = new Map(memoryResults.map((r) => [r.path, r]));
          const reordered: QmdSearchResult[] = [];
          for (const p of ranked) {
            const it = byPath.get(p);
            if (it) reordered.push(it);
          }
          // Append any unranked items in original order.
          const rankedSet = new Set(ranked);
          for (const r of memoryResults) {
            if (!rankedSet.has(r.path)) reordered.push(r);
          }
          memoryResults = reordered;
        }
      }
      if (this.config.rerankEnabled && this.config.rerankProvider === "cloud") {
        log.debug("rerankProvider=cloud is reserved/experimental in v2.2.0; skipping rerank");
      }

      // Synapse-inspired confidence gate: check scores BEFORE slicing so
      // reranking doesn't affect which score the gate evaluates.
      let confidenceGateRejected = false;
      if (
        this.config.recallConfidenceGateEnabled &&
        shouldRejectLowConfidenceRecall(memoryResults, this.config.recallConfidenceGateThreshold)
      ) {
        log.debug(`recall: confidence gate rejected ${memoryResults.length} results (top score below ${this.config.recallConfidenceGateThreshold})`);
        memoryResults = [];
        confidenceGateRejected = true;
      }

      memoryResults = memoryResults.slice(0, recallResultLimit);

      // E-Mem-inspired memory reconstruction: fill gaps for referenced entities
      if (this.config.memoryReconstructionEnabled && memoryResults.length > 0) {
        try {
          const snippets = memoryResults.map((r) => r.snippet);
          // Extract entity paths already present in recall results to avoid duplicates
          const coveredRefs = memoryResults
            .map((r) => r.path)
            .filter((p) => p.startsWith("entities/"))
            .map((p) => p.replace(/^entities\//, "").replace(/\.md$/, ""));
          const knownEntities = await profileStorage.listEntityNames();
          const missing = findUnresolvedEntityRefs(snippets, coveredRefs, knownEntities);
          if (missing.length > 0) {
            // Allow up to maxExpansions successful entity expansions
            const budget = this.config.memoryReconstructionMaxExpansions;
            let expanded = 0;
            for (const entityName of missing) {
              if (expanded >= budget) break;
              const raw = await profileStorage.readEntity(entityName);
              if (raw && raw.length > 0) {
                const snippet = raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
                memoryResults.push({
                  docid: `entity:${entityName}`,
                  path: `entities/${entityName}.md`,
                  snippet: `[Entity: ${entityName}] ${snippet}`,
                  score: 0.1,
                });
                expanded++;
              }
            }
            if (expanded > 0) {
              log.debug(`recall: reconstructed ${expanded} entity contexts`);
            }
          }
        } catch (err) {
          log.warn("recall: memory reconstruction failed (non-fatal)", err);
        }
      }

      if (memoryResults.length > 0) {
        recallSource = "hot_qmd";
        recalledMemoryCount = memoryResults.length;
        this.publishRecallResults({
          title: "Relevant Memories",
          results: memoryResults,
          sectionBuckets,
          retrievalQuery,
          sessionKey,
          identityInjection: {
            mode: identityInjectionModeUsed,
            injectedChars: identityInjectedChars,
            truncated: identityInjectionTruncated,
          },
        });
        recalledMemoryIds = this.extractMemoryIdsFromResults(memoryResults);
        recalledMemoryPaths = memoryResults.map((result) => result.path).filter(Boolean);
        impressionRecorded = true;
      } else if (!confidenceGateRejected) {
        // Only attempt fallback paths if the confidence gate did NOT fire.
        // When the gate rejects, all recall pathways are skipped to prevent
        // low-relevance results from polluting context.
        const queryAwarePrefilter = await queryAwarePrefilterPromise;
        const embeddingResults = await this.searchEmbeddingFallback(retrievalQuery, embeddingFetchLimit);
        const prefilteredEmbeddingResults = applyQueryAwareCandidateFilter(
          embeddingResults,
          queryAwarePrefilter.candidatePaths,
        );
        const scopedCandidates = filterRecallCandidates(prefilteredEmbeddingResults, {
          namespacesEnabled: this.config.namespacesEnabled,
          recallNamespaces,
          resolveNamespace: (p) => this.namespaceFromPath(p),
          limit: embeddingFetchLimit,
        });
        const scoped = (await this.boostSearchResults(scopedCandidates, recallNamespaces, retrievalQuery)).slice(
          0,
          recallResultLimit,
        );
        if (scoped.length > 0) {
          recallSource = "hot_embedding";
          recalledMemoryCount = scoped.length;
          this.publishRecallResults({
            title: "Relevant Memories",
            results: scoped,
            sectionBuckets,
            retrievalQuery,
            sessionKey,
            identityInjection: {
              mode: identityInjectionModeUsed,
              injectedChars: identityInjectedChars,
              truncated: identityInjectionTruncated,
            },
          });
          recalledMemoryIds = this.extractMemoryIdsFromResults(scoped);
          recalledMemoryPaths = scoped.map((result) => result.path).filter(Boolean);
          impressionRecorded = true;
        } else {
          const longTerm = await this.applyColdFallbackPipeline({
            prompt: retrievalQuery,
            recallNamespaces,
            recallResultLimit,
            recallMode,
            queryAwarePrefilter,
          });
          if (longTerm.length > 0) {
            recallSource = "cold_fallback";
            recalledMemoryCount = longTerm.length;
            this.publishRecallResults({
              title: "Long-Term Memories (Fallback)",
              results: longTerm,
              sectionBuckets,
              retrievalQuery,
              sessionKey,
              identityInjection: {
                mode: identityInjectionModeUsed,
                injectedChars: identityInjectedChars,
                truncated: identityInjectionTruncated,
              },
            });
            recalledMemoryIds = this.extractMemoryIdsFromResults(longTerm);
            recalledMemoryPaths = longTerm.map((result) => result.path).filter(Boolean);
            impressionRecorded = true;
          }
        }
      }

      if (globalResults.length > 0) {
        this.appendRecallSection(sectionBuckets, "workspace-context",
          this.formatQmdResults("Workspace Context", globalResults),
        );
      }

      timings.qmdPost = `${Date.now() - t0}ms`;

      // If the user is pushing back ("that's not right", "why did you say that"),
      // gently suggest an explicit workflow to inspect what was recalled and record feedback.
      // IMPORTANT: this is suggestion-only; never auto-mark negatives.
      if (isDisagreementPrompt(prompt)) {
        this.appendRecallSection(sectionBuckets, "memories",
          [
            "## Retrieval Feedback Helper",
            "",
            "The user may be disputing an answer. To debug whether retrieval misled the response:",
            "- Use tool `memory_last_recall` to see which memory IDs were injected into context.",
            "- If negative examples are enabled, you can use `memory_feedback_last_recall` to mark specific recalled IDs as not useful.",
            "",
            "Safety: do not mass-mark negatives automatically; prefer explicit IDs.",
          ].join("\n"),
        );
      }
    } else if (recallResultLimit > 0 && !this.qmd.isAvailable()) {
      // Fallback: embeddings first, then recency-only.
      const queryAwarePrefilter = await queryAwarePrefilterPromise;
      const embeddingResults = await this.searchEmbeddingFallback(retrievalQuery, embeddingFetchLimit);
      const prefilteredEmbeddingResults = applyQueryAwareCandidateFilter(
        embeddingResults,
        queryAwarePrefilter.candidatePaths,
      );
      const scopedCandidates = filterRecallCandidates(prefilteredEmbeddingResults, {
        namespacesEnabled: this.config.namespacesEnabled,
        recallNamespaces,
        resolveNamespace: (p) => this.namespaceFromPath(p),
        limit: embeddingFetchLimit,
      });
      const scoped = (await this.boostSearchResults(
        scopedCandidates,
        recallNamespaces,
        retrievalQuery,
      )).slice(0, recallResultLimit);
      if (scoped.length > 0) {
        recallSource = "hot_embedding";
        recalledMemoryCount = scoped.length;
        this.publishRecallResults({
          title: "Relevant Memories",
          results: scoped,
          sectionBuckets,
          retrievalQuery,
          sessionKey,
          identityInjection: {
            mode: identityInjectionModeUsed,
            injectedChars: identityInjectedChars,
            truncated: identityInjectionTruncated,
          },
        });
        recalledMemoryIds = this.extractMemoryIdsFromResults(scoped);
        recalledMemoryPaths = scoped.map((result) => result.path).filter(Boolean);
        impressionRecorded = true;
      } else {
        const memories = await this.readAllMemoriesForNamespaces(recallNamespaces);
        if (memories.length > 0) {
          // Filter out non-active memories
          const activeMemories = memories.filter(
            (m) =>
              (!m.frontmatter.status || m.frontmatter.status === "active") &&
              !isArtifactMemoryPath(m.path),
          );
          // Convert all active memories to QmdSearchResult with recency-based
          // baseline score, then pass through boostSearchResults so temporal/tag
          // boosts apply consistently with the primary QMD retrieval path.
          // Cap AFTER boosting so boosted-but-recency-ranked memories can surface.
          // Pass a pre-populated memoryByPath so boostSearchResults skips redundant
          // disk reads for files already loaded by readAllMemoriesForNamespaces.
          const queryAwareScopedMemories = queryAwarePrefilter.candidatePaths
            ? activeMemories.filter((memory) => queryAwarePrefilter.candidatePaths?.has(memory.path))
            : activeMemories;
          if (queryAwarePrefilter.candidatePaths && queryAwareScopedMemories.length === 0) {
            const longTerm = await this.applyColdFallbackPipeline({
              prompt: retrievalQuery,
              recallNamespaces,
              recallResultLimit,
              recallMode,
              queryAwarePrefilter,
            });
            if (longTerm.length > 0) {
              recallSource = "cold_fallback";
              recalledMemoryCount = longTerm.length;
              this.publishRecallResults({
                title: "Long-Term Memories (Fallback)",
                results: longTerm,
                sectionBuckets,
                retrievalQuery,
                sessionKey,
                identityInjection: {
                  mode: identityInjectionModeUsed,
                  injectedChars: identityInjectedChars,
                  truncated: identityInjectionTruncated,
                },
              });
              recalledMemoryIds = this.extractMemoryIdsFromResults(longTerm);
              recalledMemoryPaths = longTerm.map((result) => result.path).filter(Boolean);
              impressionRecorded = true;
            }
          } else {
            const recentSorted = queryAwareScopedMemories
              .sort(
                (a, b) =>
                  new Date(b.frontmatter.updated).getTime() -
                  new Date(a.frontmatter.updated).getTime(),
              );
            const preloadedMap = new Map<string, MemoryFile>(
              queryAwareScopedMemories.filter((m) => m.path).map((m) => [m.path, m]),
            );
            const recentAsResults: QmdSearchResult[] = recentSorted.map((m, i) => ({
              docid: m.frontmatter.id,
              path: m.path,
              snippet: m.content,
              score: 1.0 - i / Math.max(recentSorted.length, 1),
            }));
            const recent = (await this.boostSearchResults(
              recentAsResults,
              recallNamespaces,
              retrievalQuery,
              preloadedMap,
            ))
              .sort((a, b) => b.score - a.score)
              .slice(0, recallResultLimit);

            if (recent.length > 0) {
              recallSource = "recent_scan";
              recalledMemoryCount = recent.length;
              this.publishRecallResults({
                title: "Recent Memories",
                results: recent,
                sectionBuckets,
                retrievalQuery,
                sessionKey,
                identityInjection: {
                  mode: identityInjectionModeUsed,
                  injectedChars: identityInjectedChars,
                  truncated: identityInjectionTruncated,
                },
              });
              recalledMemoryIds = this.extractMemoryIdsFromResults(recent);
              recalledMemoryPaths = recent.map((result) => result.path).filter(Boolean);
              impressionRecorded = true;
            } else {
              const longTerm = await this.applyColdFallbackPipeline({
                prompt: retrievalQuery,
                recallNamespaces,
                recallResultLimit,
                recallMode,
                queryAwarePrefilter,
              });
              if (longTerm.length > 0) {
                recallSource = "cold_fallback";
                recalledMemoryCount = longTerm.length;
                this.publishRecallResults({
                  title: "Long-Term Memories (Fallback)",
                  results: longTerm,
                  sectionBuckets,
                  retrievalQuery,
                  sessionKey,
                  identityInjection: {
                    mode: identityInjectionModeUsed,
                    injectedChars: identityInjectedChars,
                    truncated: identityInjectionTruncated,
                  },
                });
                recalledMemoryIds = this.extractMemoryIdsFromResults(longTerm);
                recalledMemoryPaths = longTerm.map((result) => result.path).filter(Boolean);
                impressionRecorded = true;
              }
            }
          }
        } else {
          const longTerm = await this.applyColdFallbackPipeline({
            prompt: retrievalQuery,
            recallNamespaces,
            recallResultLimit,
            recallMode,
            queryAwarePrefilter,
          });
          if (longTerm.length > 0) {
            recallSource = "cold_fallback";
            recalledMemoryCount = longTerm.length;
            this.publishRecallResults({
              title: "Long-Term Memories (Fallback)",
              results: longTerm,
              sectionBuckets,
              retrievalQuery,
              sessionKey,
              identityInjection: {
                mode: identityInjectionModeUsed,
                injectedChars: identityInjectedChars,
                truncated: identityInjectionTruncated,
              },
            });
            recalledMemoryIds = this.extractMemoryIdsFromResults(longTerm);
            recalledMemoryPaths = longTerm.map((result) => result.path).filter(Boolean);
            impressionRecorded = true;
          }
        }
      }

      if (isDisagreementPrompt(prompt)) {
        this.appendRecallSection(sectionBuckets, "memories",
          [
            "## Retrieval Feedback Helper",
            "",
            "The user may be disputing an answer. To debug whether retrieval misled the response:",
            "- Use tool `memory_last_recall` to see which memory IDs were injected into context.",
            "- If graph recall is enabled, use `memory_graph_explain_last_recall` to inspect seed/expanded graph paths.",
            "- If negative examples are enabled, you can use `memory_feedback_last_recall` to mark specific recalled IDs as not useful.",
            "",
            "Safety: do not mass-mark negatives automatically; prefer explicit IDs.",
          ].join("\n"),
        );
      }
    }

    // 2.5. Compression guideline recall section (v8.11 Task 5)
    if (this.isRecallSectionEnabled("compression-guidelines", this.config.compressionGuidelineLearningEnabled === true)) {
      const compressionGuidelineSection = await this.buildCompressionGuidelineRecallSection();
      if (compressionGuidelineSection) {
        this.appendRecallSection(sectionBuckets, "compression-guidelines", compressionGuidelineSection);
      }
    }

    // 3. Transcript/summaries/conversation/compounding are fetched in parallel above,
    // then assembled here according to recallPipeline order.
    if (transcriptSection) {
      this.appendRecallSection(sectionBuckets, "transcript", transcriptSection);
    }
    // Compaction reset context — independent section so it works even when transcript is disabled.
    if (compactionSection) {
      this.appendRecallSection(sectionBuckets, "compaction-reset", compactionSection);
    }
    if (summariesSection) {
      this.appendRecallSection(sectionBuckets, "summaries", summariesSection);
    }
    if (conversationRecallSection) {
      this.appendRecallSection(sectionBuckets, "conversation-recall", conversationRecallSection);
    }
    if (compoundingSection) {
      this.appendRecallSection(sectionBuckets, "compounding", compoundingSection);
    }

    // 5. Inject most relevant question (if enabled) (existing)
    if (this.config.injectQuestions && this.isRecallSectionEnabled("questions", true)) {
      const questions = await profileStorage.readQuestions({ unresolvedOnly: true });
      if (questions.length > 0) {
        // Find the most relevant question to the current prompt
        // Simple approach: use the highest-priority unresolved question
        // TODO: Could use QMD search to find the most contextually relevant one
        const topQuestion = questions[0]; // Already sorted by priority desc
        this.appendRecallSection(
          sectionBuckets,
          "questions",
          `## Open Question\n\nSomething I've been curious about: ${topQuestion.question}\n\n_Context: ${topQuestion.context}_`,
        );
      }
    }

    const finalizedQueryAwarePrefilter = await queryAwarePrefilterPromise;
    if (timings.queryAware && finalizedQueryAwarePrefilter.candidatePaths?.size) {
      const helpedCount = recalledMemoryPaths.filter((memoryPath) =>
        finalizedQueryAwarePrefilter.candidatePaths?.has(memoryPath)
      ).length;
      timings.queryAware = `${timings.queryAware};helped=${helpedCount}`;
    }

    // --- Timing summary ---
    timings.total = `${Date.now() - recallStart}ms`;
    const timingParts = Object.entries(timings).map(([k, v]) => `${k}=${v}`).join(", ");
    log.debug(`recall: ${timingParts}`);

    if (!impressionRecorded && sessionKey && this.config.recordEmptyRecallImpressions) {
      this.lastRecall
        .record({
          sessionKey,
          query: retrievalQuery,
          memoryIds: [],
          policyVersion,
          identityInjection: {
            mode: identityInjectionModeUsed,
            injectedChars: identityInjectedChars,
            truncated: identityInjectionTruncated,
          },
        })
        .catch((err) => log.debug(`last recall record failed: ${err}`));
    }

    const orderedSections = this.assembleRecallSections(sectionBuckets);
    const context = orderedSections.length === 0 ? "" : orderedSections.join("\n\n---\n\n");
    if (sessionKey) {
      this.queueEvalShadowRecall({
        traceId,
        recordedAt: new Date().toISOString(),
        sessionKey,
        promptHash,
        promptLength: prompt.length,
        retrievalQueryHash,
        retrievalQueryLength: retrievalQuery.length,
        recallMode,
        recallResultLimit,
        source: recallSource,
        recalledMemoryCount,
        injected: context.length > 0,
        contextChars: context.length,
        memoryIds: recalledMemoryIds,
        policyVersion,
        identityInjectionMode: identityInjectionModeUsed,
        identityInjectedChars,
        identityInjectionTruncated,
        durationMs: Date.now() - recallStart,
        timings: { ...timings },
      });
    }
    this.emitTrace({
      kind: "recall_summary",
      traceId,
      operation: "recall",
      sessionKey,
      promptHash,
      promptLength: prompt.length,
      retrievalQueryHash,
      retrievalQueryLength: retrievalQuery.length,
      recallMode,
      recallResultLimit,
      qmdEnabled: this.config.qmdEnabled,
      qmdAvailable: this.qmd.isAvailable(),
      recallNamespaces,
      source: recallSource,
      recalledMemoryCount,
      injected: context.length > 0,
      contextChars: context.length,
      policyVersion,
      identityInjectionMode: identityInjectionModeUsed,
      identityInjectedChars,
      identityInjectionTruncated,
      durationMs: Date.now() - recallStart,
      timings: { ...timings },
    });

    return context;
  }

  async processTurn(
    role: "user" | "assistant",
    content: string,
    sessionKey?: string,
  ): Promise<void> {
    if (role !== "user" && role !== "assistant") {
      log.debug(`processTurn: ignoring unsupported role=${String(role)}`);
      return;
    }
    if (shouldSkipImplicitExtraction(this.config)) {
      log.debug("processTurn: skipping implicit extraction because captureMode=explicit");
      return;
    }

    const turn: BufferTurn = {
      role,
      content,
      timestamp: new Date().toISOString(),
      sessionKey,
    };

    const decision = await this.buffer.addTurn(turn);

    if (decision === "keep_buffering") return;
    await this.queueBufferedExtraction(this.buffer.getTurns(), "trigger_mode");
  }

  async ingestReplayBatch(
    turns: ReplayTurn[],
    options: { deadlineMs?: number } = {},
  ): Promise<void> {
    if (!Array.isArray(turns) || turns.length === 0) return;
    if (shouldSkipImplicitExtraction(this.config)) {
      log.debug("ingestReplayBatch: skipping implicit extraction because captureMode=explicit");
      return;
    }

    const bySession = new Map<string, BufferTurn[]>();
    for (const turn of turns) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      const key = normalizeReplaySessionKey(turn.sessionKey);
      const list = bySession.get(key) ?? [];
      list.push({
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        sessionKey: key,
      });
      bySession.set(key, list);
    }

    const replayTasks: Array<Promise<void>> = [];
    for (const sessionTurns of bySession.values()) {
      if (sessionTurns.length === 0) continue;
      replayTasks.push(
        new Promise<void>((resolve, reject) => {
          void this.queueBufferedExtraction(sessionTurns, "trigger_mode", {
            skipDedupeCheck: true,
            clearBufferAfterExtraction: false,
            skipCharThreshold: true,
            extractionDeadlineMs: options.deadlineMs,
            onTaskSettled: (err) => (err ? reject(err) : resolve()),
          }).catch(reject);
        }),
      );
    }
    if (replayTasks.length > 0) {
      const settled = await Promise.allSettled(replayTasks);
      const firstRejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (firstRejected) {
        throw firstRejected.reason;
      }
    }
  }

  async observeSessionHeartbeat(sessionKey: string): Promise<void> {
    if (this.config.sessionObserverEnabled !== true) return;
    if (!sessionKey || sessionKey.length === 0) return;

    const previous = this.heartbeatObserverChains.get(sessionKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const turns = this.buffer.getTurns();
        if (turns.length === 0) return;
        const mixedSessionTurns = turns.some((turn) => turn.sessionKey !== sessionKey);
        if (mixedSessionTurns) {
          log.debug(`heartbeat observer skipped: mixed session buffer for ${sessionKey}`);
          return;
        }
        if (!this.shouldQueueExtraction(turns, { commit: false })) {
          log.debug(`heartbeat observer skipped: extraction dedupe for ${sessionKey}`);
          return;
        }
        const footprint = await this.transcript.estimateSessionFootprint(sessionKey);
        const decision = await this.sessionObserver.observe({
          sessionKey,
          totalBytes: footprint.bytes,
          totalTokens: footprint.tokens,
        });
        if (!decision.triggered) return;
        log.debug(
          `heartbeat observer trigger: session=${sessionKey} deltaBytes=${decision.deltaBytes} deltaTokens=${decision.deltaTokens}`,
        );
        await this.queueBufferedExtraction(turns, "heartbeat_observer");
      });

    this.heartbeatObserverChains.set(sessionKey, next);
    try {
      await next;
    } finally {
      if (this.heartbeatObserverChains.get(sessionKey) === next) {
        this.heartbeatObserverChains.delete(sessionKey);
      }
    }
  }

  private async queueBufferedExtraction(
    turnsToExtract: BufferTurn[],
    reason: "trigger_mode" | "heartbeat_observer",
    options: {
      skipDedupeCheck?: boolean;
      clearBufferAfterExtraction?: boolean;
      skipCharThreshold?: boolean;
      extractionDeadlineMs?: number;
      onTaskSettled?: (error?: unknown) => void;
    } = {},
  ): Promise<void> {
    if (!options.skipDedupeCheck && !this.shouldQueueExtraction(turnsToExtract)) {
      log.debug(`extraction dedupe skip: preserving buffer (${reason})`);
      options.onTaskSettled?.();
      return;
    }

    this.extractionQueue.push(async () => {
      try {
        await this.runExtraction(turnsToExtract, {
          clearBufferAfterExtraction: options.clearBufferAfterExtraction ?? true,
          skipCharThreshold: options.skipCharThreshold ?? false,
          deadlineMs: options.extractionDeadlineMs,
        });
        options.onTaskSettled?.();
      } catch (err) {
        options.onTaskSettled?.(err);
        throw err;
      }
    });

    if (!this.queueProcessing) {
      this.queueProcessing = true;
      this.processQueue().catch(err => {
        log.error("background extraction queue processor failed", err);
        this.queueProcessing = false;
      });
    }
    log.debug(`queued extraction from ${reason}`);
  }

  private shouldQueueExtraction(
    turns: BufferTurn[],
    options: { commit?: boolean } = {},
  ): boolean {
    if (!this.config.extractionDedupeEnabled) return true;
    if (!Array.isArray(turns) || turns.length === 0) return false;

    // Fingerprint only user/assistant text; tool/system noise should not produce unique runs.
    const normalized = turns
      .filter((t) => t.role === "user" || t.role === "assistant")
      .map((t) => `${t.role}:${(t.content ?? "").trim().slice(0, this.config.extractionMaxTurnChars)}`)
      .join("\n");
    if (!normalized) return false;

    const fingerprint = createHash("sha256").update(normalized).digest("hex");
    const now = Date.now();
    const seenAt = this.recentExtractionFingerprints.get(fingerprint);
    if (seenAt && now - seenAt < this.config.extractionDedupeWindowMs) {
      log.debug("extraction dedupe: skipped duplicate buffered turn set");
      return false;
    }

    if (options.commit !== false) {
      this.recentExtractionFingerprints.set(fingerprint, now);
    }
    // Keep this cache bounded to avoid unbounded growth.
    if (options.commit !== false && this.recentExtractionFingerprints.size > 200) {
      const entries = Array.from(this.recentExtractionFingerprints.entries()).sort(
        (a, b) => a[1] - b[1],
      );
      for (const [key] of entries.slice(0, entries.length - 200)) {
        this.recentExtractionFingerprints.delete(key);
      }
    }

    return true;
  }

  /**
   * Background serial queue processor.
   * Processes extractions one at a time to avoid race conditions.
   * Called automatically when items are queued.
   */
  private async processQueue(): Promise<void> {
    while (this.extractionQueue.length > 0) {
      const task = this.extractionQueue.shift();
      if (task) {
        try {
          await task();
        } catch (err) {
          log.error("background extraction task failed", err);
        }
      }
    }

    this.queueProcessing = false;
  }

  private async runExtraction(
    turns: BufferTurn[],
    options: {
      clearBufferAfterExtraction?: boolean;
      skipCharThreshold?: boolean;
      deadlineMs?: number;
    } = {},
  ): Promise<void> {
    log.debug(`running extraction on ${turns.length} turns`);
    const clearBufferAfterExtraction = options.clearBufferAfterExtraction ?? true;
    const skipCharThreshold = options.skipCharThreshold ?? false;
    const deadlineMs =
      typeof options.deadlineMs === "number" && Number.isFinite(options.deadlineMs)
        ? options.deadlineMs
        : undefined;
    const throwIfDeadlineExceeded = (stage: string): void => {
      if (typeof deadlineMs === "number" && Date.now() > deadlineMs) {
        throw new Error(`replay extraction deadline exceeded (${stage})`);
      }
    };
    const clearBuffer = async () => {
      if (clearBufferAfterExtraction) {
        await this.buffer.clearAfterExtraction();
      }
    };

    // Skip extraction for cron job sessions - these are system operations, not user conversations
    const sessionKey = turns[0]?.sessionKey ?? "";
    if (sessionKey.includes(":cron:")) {
      log.debug(`skipping extraction for cron session: ${sessionKey}`);
      await clearBuffer();
      return;
    }

    const normalizedTurns = turns
      .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      .map((t) => ({
        ...t,
        content: t.content.trim().slice(0, this.config.extractionMaxTurnChars),
      }))
      .filter((t) => t.content.length > 0);
    throwIfDeadlineExceeded("before_extract");

    const userTurns = normalizedTurns.filter((t) => t.role === "user");
    const totalChars = normalizedTurns.reduce((sum, t) => sum + t.content.length, 0);
    const belowCharThreshold = totalChars < this.config.extractionMinChars;
    const belowUserTurnThreshold = userTurns.length < this.config.extractionMinUserTurns;
    if ((!skipCharThreshold && belowCharThreshold) || belowUserTurnThreshold) {
      log.debug(
        `skipping extraction: below threshold (totalChars=${totalChars}, userTurns=${userTurns.length})`,
      );
      await clearBuffer();
      return;
    }

    const principal = resolvePrincipal(sessionKey, this.config);
    const selfNamespace = defaultNamespaceForPrincipal(principal, this.config);
    const storage = await this.storageRouter.storageFor(selfNamespace);

    // Pass existing entity names so the LLM can reuse them instead of inventing variants
    const existingEntities = await storage.listEntityNames();
    const result = await this.extraction.extract(normalizedTurns, existingEntities);
    throwIfDeadlineExceeded("before_persist");

    // Defensive: validate extraction result before processing
    if (!result) {
      log.warn("runExtraction: extraction returned null/undefined");
      await clearBuffer();
      return;
    }
    if (!Array.isArray(result.facts)) {
      log.warn("runExtraction: extraction returned invalid facts (not an array)", { factsType: typeof result.facts, resultKeys: Object.keys(result) });
      await clearBuffer();
      return;
    }
    if (
      result.facts.length === 0 &&
      result.entities.length === 0 &&
      result.questions.length === 0 &&
      result.profileUpdates.length === 0
    ) {
      log.debug("runExtraction: extraction produced no durable outputs; skipping persistence");
      await clearBuffer();
      return;
    }

    let threadIdForExtraction: string | null = null;
    if (this.config.threadingEnabled && turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      try {
        threadIdForExtraction = await this.threading.processTurn(lastTurn, []);
      } catch (err) {
        // Fail-open: threading errors must not block memory persistence.
        log.warn("[threading] processTurn failed before persistence (non-fatal)", err);
      }
    }

    const persistedIds = await this.persistExtraction(result, storage, threadIdForExtraction);
    await clearBuffer();

    // Build memory box from this extraction (v8.0 Phase 2A)
    // Topics are derived from the current extraction's facts and entities only —
    // not from readAllMemories() — so box topics accurately reflect the current
    // session window and the call is free of expensive full-corpus I/O.
    if (this.config.memoryBoxesEnabled && persistedIds.length > 0) {
      const extractionTopics = deriveTopicsFromExtraction(result);
      // Derive episodic metadata from buffer turns (REMem-inspired)
      const firstUserTurn = turns.find((t) => t.role === "user");
      const boxGoal = firstUserTurn?.content?.slice(0, 100)?.trim() || undefined;
      await this.boxBuilderFor(storage)
        .onExtraction({
          topics: extractionTopics,
          memoryIds: persistedIds,
          timestamp: new Date().toISOString(),
          goal: boxGoal,
        })
        .catch((err) => log.warn("[boxes] onExtraction failed (non-fatal)", err));
    }

    // Batch-append persisted IDs so non-fact memories (entities/questions) are
    // always attached to the thread.
    if (
      this.config.threadingEnabled &&
      threadIdForExtraction &&
      persistedIds.length > 0
    ) {
      try {
        await this.threading.appendEpisodeIds(threadIdForExtraction, persistedIds);
      } catch (err) {
        log.warn("[threading] appendEpisodeIds failed after persistence (non-fatal)", err);
      }
    }

    // Thread title update for the already-established thread context.
    if (this.config.threadingEnabled && threadIdForExtraction) {
      const conversationContent = turns.map((t) => t.content).join(" ");
      await this.threading.updateThreadTitle(threadIdForExtraction, conversationContent);
    }

    // Check if consolidation is needed (debounced + non-zero gated).
    const nonZeroExtraction =
      result.facts.length > 0 ||
      result.entities.length > 0 ||
      result.questions.length > 0 ||
      result.profileUpdates.length > 0;
    if (nonZeroExtraction) this.nonZeroExtractionsSinceConsolidation += 1;
    this.maybeScheduleConsolidation(nonZeroExtraction);

    // Update meta (safely handle potentially invalid result)
    const meta = await storage.loadMeta();
    meta.extractionCount += 1;
    meta.lastExtractionAt = new Date().toISOString();
    meta.totalMemories += Array.isArray(result?.facts) ? result.facts.length : 0;
    meta.totalEntities += Array.isArray(result?.entities) ? result.entities.length : 0;
    await storage.saveMeta(meta);

    this.requestQmdMaintenance();
    await this.runTierMigrationCycle(storage, "extraction");
  }

  private async runTierMigrationCycle(
    storage: StorageManager,
    trigger: "extraction" | "maintenance" | "manual",
    options?: {
      dryRun?: boolean;
      limitOverride?: number;
      force?: boolean;
    },
  ): Promise<TierMigrationCycleSummary> {
    const dryRun = options?.dryRun === true;
    const persistSkipped = options?.force === true || trigger === "manual";
    if (!this.config.qmdTierMigrationEnabled && options?.force !== true) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit: 0,
        dryRun,
        skipped: "tier_migration_disabled",
      };
      if (persistSkipped) await this.tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }
    if (trigger === "maintenance" && !this.config.qmdTierAutoBackfillEnabled && options?.force !== true) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit: 0,
        dryRun,
        skipped: "maintenance_backfill_disabled",
      };
      if (persistSkipped) await this.tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }
    if (this.tierMigrationInFlight) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit: 0,
        dryRun,
        skipped: "migration_in_flight",
      };
      if (persistSkipped) await this.tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }

    const budgetTrigger = trigger === "manual" ? "maintenance" : trigger;
    const budget = this.compounding?.tierMigrationCycleBudget(budgetTrigger)
      ?? defaultTierMigrationCycleBudget(this.config, budgetTrigger);
    const limit = options?.limitOverride !== undefined
      ? Math.max(0, Math.floor(options.limitOverride))
      : budget.limit;
    const nowMs = Date.now();
    if (options?.force !== true && nowMs - this.lastTierMigrationRunAtMs < budget.minIntervalMs) {
      const skipped: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit,
        dryRun,
        skipped: "min_interval",
      };
      if (persistSkipped) await this.tierMigrationStatus.recordCycle(skipped);
      return skipped;
    }

    const policy = applyUtilityPromotionRuntimePolicy({
      enabled: this.config.qmdTierMigrationEnabled,
      demotionMinAgeDays: this.config.qmdTierDemotionMinAgeDays,
      demotionValueThreshold: this.config.qmdTierDemotionValueThreshold,
      promotionValueThreshold: this.config.qmdTierPromotionValueThreshold,
    }, this.utilityRuntimeValues);

    this.tierMigrationInFlight = true;
    try {
      const coldStorage = new StorageManager(path.join(storage.dir, "cold"));
      const [hotMemories, coldMemories] = await Promise.all([
        storage.readAllMemories(),
        coldStorage.readAllMemories(),
      ]);
      const now = new Date();
      const scanLimit = Math.max(0, Math.floor(budget.scanLimit));
      const hotScanLimit = Math.min(hotMemories.length, Math.ceil(scanLimit * 0.75));
      const coldScanLimit = Math.min(coldMemories.length, Math.max(0, scanLimit - hotScanLimit));
      const toTimestamp = (memory: MemoryFile): number =>
        Date.parse(memory.frontmatter.updated ?? memory.frontmatter.created);
      const hotCandidates = hotMemories
        .map((memory) => ({ memory, tier: "hot" as MemoryTier }))
        .sort((a, b) => toTimestamp(a.memory) - toTimestamp(b.memory))
        .slice(0, hotScanLimit);
      const coldCandidates = coldMemories
        .map((memory) => ({ memory, tier: "cold" as MemoryTier }))
        .sort((a, b) => toTimestamp(b.memory) - toTimestamp(a.memory))
        .slice(0, coldScanLimit);
      const candidates = [...hotCandidates, ...coldCandidates];

      const migration = new TierMigrationExecutor({
        storage,
        qmd: this.qmd,
        hotCollection: this.config.qmdCollection,
        coldCollection: this.config.qmdColdCollection ?? `${this.config.qmdCollection}-cold`,
        autoEmbed: this.config.qmdAutoEmbedEnabled,
      });

      let migrated = 0;
      let promoted = 0;
      let demoted = 0;
      for (const candidate of candidates) {
        if (migrated >= limit) break;
        const decision = decideTierTransition(candidate.memory, candidate.tier, policy, now);
        if (!decision.changed) continue;

        if (!dryRun) {
          const res = await migration.migrateMemory({
            memory: candidate.memory,
            fromTier: candidate.tier,
            toTier: decision.nextTier,
            reason: `${trigger}:${decision.reason}`,
          });
          if (!res.changed) continue;
        }
        migrated += 1;
        if (decision.nextTier === "cold") demoted += 1;
        if (decision.nextTier === "hot") promoted += 1;
      }

      if (!dryRun) this.lastTierMigrationRunAtMs = Date.now();
      log.debug(
        `tier migration cycle completed: trigger=${trigger} scanned=${candidates.length} migrated=${migrated} limit=${limit}${dryRun ? " dryRun=true" : ""}`,
      );
      const summary: TierMigrationCycleSummary = {
        trigger,
        scanned: candidates.length,
        migrated,
        promoted,
        demoted,
        limit,
        dryRun,
      };
      const shouldPersistCycle = trigger === "manual" || migrated > 0;
      if (shouldPersistCycle) await this.tierMigrationStatus.recordCycle(summary);
      return summary;
    } catch (err) {
      this.lastTierMigrationRunAtMs = Date.now();
      log.warn(`tier migration cycle failed (${trigger}, fail-open): ${err}`);
      const failed: TierMigrationCycleSummary = {
        trigger,
        scanned: 0,
        migrated: 0,
        promoted: 0,
        demoted: 0,
        limit,
        dryRun,
        errorCount: 1,
      };
      await this.tierMigrationStatus.recordCycle(failed);
      return failed;
    } finally {
      this.tierMigrationInFlight = false;
    }
  }

  async getTierMigrationStatus(): Promise<TierMigrationStatusSnapshot> {
    return this.tierMigrationStatus.get();
  }

  async runTierMigrationNow(options?: {
    dryRun?: boolean;
    limit?: number;
  }): Promise<TierMigrationCycleSummary> {
    return this.runTierMigrationCycle(this.storage, "manual", {
      dryRun: options?.dryRun === true,
      limitOverride: options?.limit,
      force: false,
    });
  }

  private maybeScheduleConsolidation(nonZeroExtraction: boolean): void {
    if (this.config.consolidationRequireNonZeroExtraction && !nonZeroExtraction) return;
    if (this.nonZeroExtractionsSinceConsolidation < this.config.consolidateEveryN) return;

    const now = Date.now();
    if (now - this.lastConsolidationRunAtMs < this.config.consolidationMinIntervalMs) return;
    if (this.consolidationInFlight) return;

    this.consolidationInFlight = true;
    this.lastConsolidationRunAtMs = now;
    this.nonZeroExtractionsSinceConsolidation = 0;
    this.runConsolidation()
      .catch((err) => log.error("background consolidation failed", err))
      .finally(() => {
        this.consolidationInFlight = false;
      });
  }

  private requestQmdMaintenance(): void {
    if (!this.qmd.isAvailable()) return;
    if (!this.config.qmdMaintenanceEnabled) return;

    this.qmdMaintenancePending = true;
    if (this.qmdMaintenanceTimer) return;

    this.qmdMaintenanceTimer = setTimeout(() => {
      this.qmdMaintenanceTimer = null;
      this.runQmdMaintenance().catch((err) =>
        log.debug(`background qmd maintenance failed: ${err}`),
      );
    }, this.config.qmdMaintenanceDebounceMs);
  }

  /**
   * Public entrypoint for tool-driven QMD maintenance requests.
   * Routes through existing debounced/singleflight maintenance controls.
   */
  requestQmdMaintenanceForTool(reason: string): void {
    try {
      this.requestQmdMaintenance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`qmd maintenance request failed (${reason}): ${msg}`);
    }
  }

  private async runQmdMaintenance(): Promise<void> {
    if (this.qmdMaintenanceInFlight) return;
    if (!this.qmdMaintenancePending) return;
    this.qmdMaintenanceInFlight = true;
    this.qmdMaintenancePending = false;

    try {
      if (this.config.namespacesEnabled) {
        await this.namespaceSearchRouter.updateNamespaces(this.configuredNamespaces());
      } else {
        await this.qmd.update();
      }
      const now = Date.now();
      if (
        this.config.qmdAutoEmbedEnabled &&
        now - this.lastQmdEmbedAtMs >= this.config.qmdEmbedMinIntervalMs
      ) {
        if (this.config.namespacesEnabled) {
          await this.namespaceSearchRouter.embedNamespaces(this.configuredNamespaces());
        } else {
          await this.qmd.embed();
        }
        this.lastQmdEmbedAtMs = now;
      }
    } finally {
      this.qmdMaintenanceInFlight = false;
      if (this.qmdMaintenancePending) {
        this.requestQmdMaintenance();
      }
    }
  }

  private async persistExtraction(
    result: ExtractionResult,
    storage: StorageManager,
    threadIdForExtraction?: string | null,
  ): Promise<string[]> {
    const persistedIds: string[] = [];
    const persistedIdsByStorage = new Map<string, { storage: StorageManager; ids: string[] }>();
    const trackPersistedId = (targetStorage: StorageManager, id: string): void => {
      persistedIds.push(id);
      const key = targetStorage.dir;
      const existing = persistedIdsByStorage.get(key);
      if (existing) {
        existing.ids.push(id);
        return;
      }
      persistedIdsByStorage.set(key, { storage: targetStorage, ids: [id] });
    };
    let dedupedCount = 0;
    const behaviorSignalsByStorage = new Map<string, { storage: StorageManager; events: BehaviorSignalEvent[] }>();
    const trackBehaviorSignals = (targetStorage: StorageManager, events: BehaviorSignalEvent[]): void => {
      if (events.length === 0) return;
      const key = targetStorage.dir;
      const existing = behaviorSignalsByStorage.get(key);
      if (existing) {
        existing.events.push(...events);
        return;
      }
      behaviorSignalsByStorage.set(key, { storage: targetStorage, events: [...events] });
    };

    // Defensive: validate result and facts array
    if (!result || !Array.isArray(result.facts)) {
      log.warn("persistExtraction: result or result.facts is invalid, skipping", { resultType: typeof result, factsType: typeof result?.facts });
      return persistedIds;
    }

    // Chunking config from plugin settings
    const chunkingConfig: ChunkingConfig = {
      targetTokens: this.config.chunkingTargetTokens,
      minTokens: this.config.chunkingMinTokens,
      overlapSentences: this.config.chunkingOverlapSentences,
    };

    const rawEntities = Array.isArray((result as any).entities) ? (result as any).entities : [];
    const rawQuestions = Array.isArray((result as any).questions) ? (result as any).questions : [];
    const rawProfileUpdates = Array.isArray((result as any).profileUpdates)
      ? (result as any).profileUpdates
      : [];

    const facts = result.facts.slice(0, this.config.extractionMaxFactsPerRun);
    const entities = rawEntities.slice(0, this.config.extractionMaxEntitiesPerRun);
    const questions = rawQuestions.slice(0, this.config.extractionMaxQuestionsPerRun);
    const profileUpdates = rawProfileUpdates.slice(
      0,
      this.config.extractionMaxProfileUpdatesPerRun,
    );

    if (
      facts.length < result.facts.length ||
      entities.length < result.entities.length ||
      questions.length < result.questions.length ||
      profileUpdates.length < result.profileUpdates.length
    ) {
      log.warn(
        "persistExtraction: capped extraction payload to guardrails " +
          `(facts ${facts.length}/${result.facts.length}, entities ${entities.length}/${result.entities.length}, ` +
          `questions ${questions.length}/${result.questions.length}, profile ${profileUpdates.length}/${result.profileUpdates.length})`,
      );
    }

    // v8.2: pre-load all memories once for entity-sibling graph edges (avoids per-fact disk scan)
    type GraphStorageContext = {
      allMemsForGraph: Awaited<ReturnType<typeof storage.readAllMemories>> | null;
      memoryPathById: Map<string, string>;
      previousPersistedRelPath?: string;
    };
    const graphContextByStorageDir = new Map<string, GraphStorageContext>();
    const ensureGraphContext = async (targetStorage: StorageManager): Promise<GraphStorageContext> => {
      const existing = graphContextByStorageDir.get(targetStorage.dir);
      if (existing) return existing;
      const created: GraphStorageContext = {
        allMemsForGraph: null,
        memoryPathById: new Map<string, string>(),
      };
      if (this.config.multiGraphMemoryEnabled) {
        try {
          created.allMemsForGraph = await targetStorage.readAllMemories();
          for (const [id, relPath] of buildMemoryPathById(created.allMemsForGraph, targetStorage.dir)) {
            created.memoryPathById.set(id, relPath);
          }
        } catch { /* fail-open */ }
      }
      graphContextByStorageDir.set(targetStorage.dir, created);
      return created;
    };
    let threadEpisodeIdsForGraph: string[] | undefined;
    if (this.config.multiGraphMemoryEnabled && threadIdForExtraction) {
      try {
        const thread = await this.threading.loadThread(threadIdForExtraction);
        threadEpisodeIdsForGraph = thread?.episodeIds ? [...thread.episodeIds] : [];
      } catch { /* fail-open */ }
    }
    const routeRules = await this.loadRoutingRules();
    const routeOptions = this.routeEngineOptions();

    for (const fact of facts) {
      if (!fact || typeof (fact as any).content !== "string" || !(fact as any).content.trim()) {
        continue;
      }
      if (typeof (fact as any).category !== "string" || !(fact as any).category.trim()) {
        continue;
      }
      (fact as any).tags = Array.isArray((fact as any).tags)
        ? (fact as any).tags.filter((t: any) => typeof t === "string")
        : [];
      (fact as any).confidence =
        typeof (fact as any).confidence === "number" ? (fact as any).confidence : 0.7;

      // Content-hash dedup check (v6.0)
      if (this.contentHashIndex && this.contentHashIndex.has(fact.content)) {
        log.debug(`dedup: skipping duplicate fact "${fact.content.slice(0, 60)}…"`);
        dedupedCount++;
        continue;
      }

      // Score importance using local heuristics (Phase 1B)
      let writeCategory = fact.category;
      let targetStorage = storage;
      let routedRuleId: string | undefined;
      if (routeRules.length > 0) {
        try {
          const routeText = `${fact.category} ${fact.tags.join(" ")} ${fact.content}`;
          const selected = selectRouteRule(routeText, routeRules, routeOptions);
          if (selected) {
            routedRuleId = selected.rule.id;
            if (selected.target.category) {
              writeCategory = selected.target.category;
            }
            if (selected.target.namespace) {
              targetStorage = await this.storageRouter.storageFor(selected.target.namespace);
            }
          }
        } catch (err) {
          log.warn(`routing evaluation failed; fail-open to extracted category/namespace: ${err}`);
        }
      }
      const importance = scoreImportance(fact.content, writeCategory, fact.tags);
      const inferredIntent = this.config.intentRoutingEnabled
        ? inferIntentFromText(`${writeCategory} ${fact.tags.join(" ")} ${fact.content}`)
        : null;

      // Check if chunking is enabled and content should be chunked
      if (this.config.chunkingEnabled) {
        const chunkResult = chunkContent(fact.content, chunkingConfig);

        if (chunkResult.chunked && chunkResult.chunks.length > 1) {
          // Classify memory kind (v8.0 Phase 2B: HiMem episode/note dual store)
          const memoryKind = this.config.episodeNoteModeEnabled
            ? classifyMemoryKind(fact.content, fact.tags ?? [], writeCategory)
            : undefined;

          // Write the parent memory first (with full content for reference)
          const parentId = await targetStorage.writeMemory(writeCategory, fact.content, {
            confidence: fact.confidence,
            tags: [...fact.tags, "chunked"],
            entityRef: fact.entityRef,
            source: "extraction",
            importance,
            intentGoal: inferredIntent?.goal,
            intentActionType: inferredIntent?.actionType,
            intentEntityTypes: inferredIntent?.entityTypes,
            memoryKind,
          });

          // Write individual chunks with parent reference
          for (const chunk of chunkResult.chunks) {
            // Score each chunk's importance separately
            const chunkImportance = scoreImportance(chunk.content, writeCategory, fact.tags);

            await targetStorage.writeChunk(
              parentId,
              chunk.index,
              chunkResult.chunks.length,
              writeCategory,
              chunk.content,
              {
                confidence: fact.confidence,
                tags: fact.tags,
                entityRef: fact.entityRef,
                source: "chunking",
                importance: chunkImportance,
                intentGoal: inferredIntent?.goal,
                intentActionType: inferredIntent?.actionType,
                intentEntityTypes: inferredIntent?.entityTypes,
                memoryKind,
              },
            );
          }

          if (routedRuleId) {
            log.debug(
              `routing applied for chunked memory ${parentId}: rule=${routedRuleId} category=${writeCategory} storage=${targetStorage.dir}`,
            );
          }
          log.debug(`chunked memory ${parentId} into ${chunkResult.chunks.length} chunks`);
          trackPersistedId(targetStorage, parentId);
          if (threadEpisodeIdsForGraph && !threadEpisodeIdsForGraph.includes(parentId)) {
            threadEpisodeIdsForGraph.push(parentId);
          }
          await this.indexPersistedMemory(targetStorage, parentId);
          // Register chunked content in hash index too
          if (this.contentHashIndex) {
            this.contentHashIndex.add(fact.content);
          }

          for (const chunk of chunkResult.chunks) {
            const chunkId = `${parentId}-chunk-${chunk.index}`;
            // Do NOT push chunkId into persistedIds — chunk IDs must not leak
            // into boxBuilder.onExtraction() or threading.processTurn(), which
            // only expect canonical parent memory IDs.  Call indexPersistedMemory
            // directly for embedding-fallback sync of each chunk document.
            await this.indexPersistedMemory(targetStorage, chunkId);
          }
          if (
            this.config.verbatimArtifactsEnabled &&
            this.config.verbatimArtifactCategories.includes(writeCategory) &&
            fact.confidence >= this.config.verbatimArtifactsMinConfidence
          ) {
            await targetStorage.writeArtifact(fact.content, {
              confidence: fact.confidence,
              tags: [...fact.tags, "artifact", "chunked-parent"],
              artifactType: this.artifactTypeForCategory(writeCategory),
              sourceMemoryId: parentId,
              intentGoal: inferredIntent?.goal,
              intentActionType: inferredIntent?.actionType,
              intentEntityTypes: inferredIntent?.entityTypes,
            });
          }
          // v8.2: graph edge building for chunked memories
          if (this.config.multiGraphMemoryEnabled) {
            try {
              const graphContext = await ensureGraphContext(targetStorage);
              const entityRef =
                typeof (fact as any).entityRef === "string" ? (fact as any).entityRef : undefined;
              const parentRelPath = resolvePersistedMemoryRelativePath({
                memoryId: parentId,
                pathById: graphContext.memoryPathById,
                category: writeCategory,
              });
              graphContext.memoryPathById.set(parentId, parentRelPath);
              appendMemoryToGraphContext({
                allMemsForGraph: graphContext.allMemsForGraph,
                storageDir: targetStorage.dir,
                memoryRelPath: parentRelPath,
                memoryId: parentId,
                category: writeCategory,
                content: fact.content ?? "",
                entityRef,
              });
              await this.buildGraphEdge(
                targetStorage,
                parentRelPath,
                entityRef,
                parentId,
                fact.content ?? "",
                graphContext.allMemsForGraph,
                graphContext.memoryPathById,
                threadIdForExtraction ?? undefined,
                threadEpisodeIdsForGraph,
                graphContext.previousPersistedRelPath,
              );
              graphContext.previousPersistedRelPath = parentRelPath;
            } catch { /* fail-open */ }
          }
          trackBehaviorSignals(
            targetStorage,
            buildBehaviorSignalsForMemory({
              memoryId: parentId,
              category: writeCategory,
              content: fact.content,
              namespace: this.namespaceFromStorageDir(targetStorage.dir),
              confidence: fact.confidence,
              source: "extraction",
            }),
          );
          continue; // Skip the normal write below
        }
      }

      // Check for contradictions before writing (Phase 2B)
      let supersedes: string | undefined;
      let links: MemoryLink[] = [];

      if (this.config.contradictionDetectionEnabled && this.qmd.isAvailable()) {
        const targetNamespace = this.namespaceFromStorageDir(targetStorage.dir);
        const contradiction = await this.checkForContradiction(
          fact.content,
          writeCategory,
          targetNamespace,
        );
        if (contradiction) {
          supersedes = contradiction.supersededId;
          links.push({
            targetId: contradiction.supersededId,
            linkType: "contradicts",
            strength: contradiction.confidence,
            reason: contradiction.reason,
          });
          // Deindex the superseded memory so stale paths don't remain in
          // index_time.json / index_tags.json after the incremental update.
          if (this.config.queryAwareIndexingEnabled && contradiction.supersededPath) {
            deindexMemory(
              this.config.memoryDir,
              contradiction.supersededPath,
              contradiction.supersededCreated,
              contradiction.supersededTags,
            );
          }
        }
      }

      // Suggest links for this memory (Phase 3A)
      if (this.config.memoryLinkingEnabled && this.qmd.isAvailable()) {
        const targetNamespace = this.namespaceFromStorageDir(targetStorage.dir);
        const suggestedLinks = await this.suggestLinksForMemory(
          fact.content,
          writeCategory,
          targetNamespace,
        );
        if (suggestedLinks.length > 0) {
          links.push(...suggestedLinks);
        }
      }

      // Classify memory kind (v8.0 Phase 2B: HiMem episode/note dual store)
      const memoryKind = this.config.episodeNoteModeEnabled
        ? classifyMemoryKind(fact.content, fact.tags ?? [], writeCategory)
        : undefined;

      // Normal write (no chunking)
      const memoryId = await targetStorage.writeMemory(writeCategory, fact.content, {
        confidence: fact.confidence,
        tags: fact.tags,
        entityRef: typeof (fact as any).entityRef === "string" ? (fact as any).entityRef : undefined,
        source: "extraction",
        importance,
        supersedes,
        links: links.length > 0 ? links : undefined,
        intentGoal: inferredIntent?.goal,
        intentActionType: inferredIntent?.actionType,
        intentEntityTypes: inferredIntent?.entityTypes,
        memoryKind,
      });
      if (routedRuleId) {
        log.debug(
          `routing applied for memory ${memoryId}: rule=${routedRuleId} category=${writeCategory} storage=${targetStorage.dir}`,
        );
      }
      trackBehaviorSignals(
        targetStorage,
        buildBehaviorSignalsForMemory({
          memoryId,
          category: writeCategory,
          content: fact.content,
          namespace: this.namespaceFromStorageDir(targetStorage.dir),
          confidence: fact.confidence,
          source: "extraction",
        }),
      );
      trackPersistedId(targetStorage, memoryId);
      if (threadEpisodeIdsForGraph && !threadEpisodeIdsForGraph.includes(memoryId)) {
        threadEpisodeIdsForGraph.push(memoryId);
      }
      await this.indexPersistedMemory(targetStorage, memoryId);
      // v8.2: graph edge building (fail-open — errors caught inside GraphIndex)
      if (this.config.multiGraphMemoryEnabled) {
        try {
          const graphContext = await ensureGraphContext(targetStorage);
          const entityRef =
            typeof (fact as any).entityRef === "string" ? (fact as any).entityRef : undefined;
          const memoryRelPath = resolvePersistedMemoryRelativePath({
            memoryId,
            pathById: graphContext.memoryPathById,
            category: writeCategory,
          });
          graphContext.memoryPathById.set(memoryId, memoryRelPath);
          appendMemoryToGraphContext({
            allMemsForGraph: graphContext.allMemsForGraph,
            storageDir: targetStorage.dir,
            memoryRelPath: memoryRelPath,
            memoryId,
            category: writeCategory,
            content: fact.content ?? "",
            entityRef,
          });
          await this.buildGraphEdge(
            targetStorage,
            memoryRelPath,
            entityRef,
            memoryId,
            fact.content ?? "",
            graphContext.allMemsForGraph,
            graphContext.memoryPathById,
            threadIdForExtraction ?? undefined,
            threadEpisodeIdsForGraph,
            graphContext.previousPersistedRelPath,
          );
          graphContext.previousPersistedRelPath = memoryRelPath;
        } catch { /* fail-open */ }
      }
      if (
        this.config.verbatimArtifactsEnabled &&
        this.config.verbatimArtifactCategories.includes(writeCategory) &&
        fact.confidence >= this.config.verbatimArtifactsMinConfidence
      ) {
        await targetStorage.writeArtifact(fact.content, {
          confidence: fact.confidence,
          tags: [...fact.tags, "artifact"],
          artifactType: this.artifactTypeForCategory(writeCategory),
          sourceMemoryId: memoryId,
          intentGoal: inferredIntent?.goal,
          intentActionType: inferredIntent?.actionType,
          intentEntityTypes: inferredIntent?.entityTypes,
        });
      }
      // Register in content-hash index after successful write
      if (this.contentHashIndex) {
        this.contentHashIndex.add(fact.content);
      }
    }

    for (const entity of entities) {
      try {
        const name = (entity as any)?.name;
        const type = (entity as any)?.type;
        if (typeof name !== "string" || !name.trim() || typeof type !== "string" || !type.trim()) {
          continue;
        }
        const safeFacts = Array.isArray((entity as any)?.facts)
          ? (entity as any).facts.filter((f: any) => typeof f === "string")
          : [];
        const id = await storage.writeEntity(name, type, safeFacts);
        if (id) trackPersistedId(storage, id);
      } catch (err) {
        log.warn(`persistExtraction: entity write failed: ${err}`);
      }
    }

    // Persist entity relationships (v7.0)
    if (this.config.entityRelationshipsEnabled && Array.isArray(result.relationships)) {
      for (const rel of result.relationships.slice(0, 5)) {
        if (!rel.source || !rel.target || !rel.label) continue;
        try {
          // Add bidirectional relationship
          await storage.addEntityRelationship(rel.source, { target: rel.target, label: rel.label });
          await storage.addEntityRelationship(rel.target, { target: rel.source, label: `${rel.label} (reverse)` });
        } catch (err) {
          log.debug(`relationship persist failed: ${err}`);
        }
      }
    }

    // Persist entity activity (v7.0)
    if (this.config.entityActivityLogEnabled) {
      const today = new Date().toISOString().slice(0, 10);
      for (const entity of entities) {
        const name = (entity as any)?.name;
        const type = (entity as any)?.type;
        if (typeof name !== "string" || typeof type !== "string") continue;
        try {
          const normalized = normalizeEntityName(name, type);
          await storage.addEntityActivity(
            normalized,
            { date: today, note: "Mentioned in conversation" },
            this.config.entityActivityLogMaxEntries,
          );
        } catch (err) {
          log.debug(`activity persist failed: ${err}`);
        }
      }
    }

    if (profileUpdates.length > 0) {
      await storage.appendToProfile(profileUpdates);
    }

    // Persist questions
    for (const q of questions) {
      const id = await storage.writeQuestion(q.question, q.context, q.priority);
      if (id) trackPersistedId(storage, id);
    }

    // Persist identity reflection
    if (this.config.identityEnabled && result.identityReflection) {
      try {
        await storage.appendIdentityReflection(result.identityReflection);
      } catch (err) {
        log.debug(`identity reflection write failed: ${err}`);
      }
    }

    // Save content-hash index after batch
    if (this.contentHashIndex) {
      await this.contentHashIndex.save().catch((err) =>
        log.warn(`content-hash index save failed: ${err}`),
      );
    }

    for (const { storage: targetStorage, events } of behaviorSignalsByStorage.values()) {
      const dedupedSignals = dedupeBehaviorSignalsByMemoryAndHash(events);
      if (dedupedSignals.length === 0) continue;
      await targetStorage
        .appendBehaviorSignals(dedupedSignals)
        .catch((err) => log.warn(`appendBehaviorSignals failed (non-fatal): ${err}`));
    }

    const dedupSuffix = dedupedCount > 0 ? ` (${dedupedCount} deduped)` : "";
    log.info(
      `persisted: ${facts.length - dedupedCount} facts${dedupSuffix}, ${entities.length} entities, ${questions.length} questions, ${profileUpdates.length} profile updates`,
    );

    // Update temporal + tag indexes (v8.1) — fire-and-forget, fail-open
    void (async () => {
      if (persistedIdsByStorage.size === 0) {
        await this.updateTemporalTagIndexes(storage, []);
        return;
      }
      for (const entry of persistedIdsByStorage.values()) {
        await this.updateTemporalTagIndexes(entry.storage, entry.ids);
      }
    })().catch((err) => log.debug(`temporal-index update error (non-fatal): ${err}`));

    // Return the persisted fact IDs for threading
    return persistedIds;
  }

  private async indexPersistedMemory(storage: StorageManager, memoryId: string): Promise<void> {
    if (!this.config.embeddingFallbackEnabled) return;
    if (!(await this.embeddingFallback.isAvailable())) return;
    const memory = await storage.getMemoryById(memoryId);
    if (!memory) return;
    await this.embeddingFallback.indexFile(memoryId, memory.content, memory.path);
  }

  /**
   * Build a graph edge for a persisted memory (v8.2).
   * Shared helper used by both the chunked and non-chunked write paths to avoid duplication.
   * Fail-open: caller wraps in try/catch.
   */
  private async buildGraphEdge(
    storage: StorageManager,
    memoryRelPath: string,
    entityRef: string | undefined,
    memoryId: string,
    factContent: string,
    allMemsForGraph: import("./types.js").MemoryFile[] | null | undefined,
    memoryPathById: Map<string, string>,
    threadIdForEdge: string | undefined,
    threadEpisodeIdsForGraph: string[] | undefined,
    fallbackCausalPredecessor: string | undefined,
  ): Promise<void> {
    // Entity siblings: other memories sharing the same entityRef
    const entitySiblings: string[] = [];
    if (entityRef) {
      try {
        const allMems = allMemsForGraph ?? [];
        for (const m of allMems) {
          if (m.frontmatter.entityRef === entityRef) {
            const rel = path.relative(storage.dir, m.path);
            if (rel !== memoryRelPath) entitySiblings.push(rel);
          }
        }
      } catch { /* fail-open */ }
    }
    // Recent thread memories for time graph
    const recentInThread: string[] = [];
    if (threadIdForEdge && threadEpisodeIdsForGraph?.length) {
      try {
        recentInThread.push(...resolveRecentThreadMemoryPaths({
          threadEpisodeIds: threadEpisodeIdsForGraph,
          currentMemoryId: memoryId,
          allMemsForGraph,
          pathById: memoryPathById,
          storageDir: storage.dir,
          maxRecent: 3,
        }));
      } catch { /* fail-open */ }
    }
    if (
      recentInThread.length === 0 &&
      this.config.graphWriteSessionAdjacencyEnabled !== false &&
      fallbackCausalPredecessor &&
      fallbackCausalPredecessor !== memoryRelPath
    ) {
      recentInThread.push(fallbackCausalPredecessor);
    }
    const causalPredecessor = recentInThread[recentInThread.length - 1] ?? fallbackCausalPredecessor;
    await this.graphIndexFor(storage).onMemoryWritten({
      memoryPath: memoryRelPath,
      entityRef,
      content: factContent,
      created: new Date().toISOString(),
      threadId: threadIdForEdge,
      recentInThread,
      entitySiblings,
      causalPredecessor,
    });
  }

  private graphIndexFor(storage: StorageManager): GraphIndex {
    const key = storage.dir;
    const existing = this.graphIndexes.get(key);
    if (existing) return existing;
    const created = new GraphIndex(key, this.config);
    this.graphIndexes.set(key, created);
    return created;
  }

  /**
   * Batch-update temporal and tag indexes after extraction (v8.1).
   * Reads each persisted memory's path + frontmatter and adds them to
   * state/index_time.json and state/index_tags.json.
   * Fail-open: any error is logged but does not abort extraction.
   */
  private async updateTemporalTagIndexes(
    storage: StorageManager,
    persistedIds: string[],
  ): Promise<void> {
    if (!this.config.queryAwareIndexingEnabled) return;
    // Check for missing indexes BEFORE the early-return so first-time enablement
    // can bootstrap the full corpus even when this extraction turn persisted nothing.
    const needsFullRebuild = !indexesExist(this.config.memoryDir);
    if (!needsFullRebuild && persistedIds.length === 0) return;
    try {
      // Read the corpus once to avoid N separate full-corpus scans.
      // On full rebuild with namespaces enabled, span all configured namespaces so
      // memories written to other namespaces before the index existed are also captured.
      const allMemories = needsFullRebuild && this.config.namespacesEnabled
        ? await this.readAllMemoriesForNamespaces(
            Array.from(new Set<string>([
              this.config.defaultNamespace,
              this.config.sharedNamespace,
              ...this.config.namespacePolicies.map((p) => p.name),
            ])),
          )
        : await storage.readAllMemories();

      // Bootstrap: index only active (non-archived, non-superseded) memories.
      // Incremental: index only the newly persisted IDs.
      const isActive = (m: { frontmatter: { status?: string } }) =>
        !m.frontmatter.status || m.frontmatter.status === "active";
      const pool = needsFullRebuild
        ? allMemories.filter(isActive)
        : (() => {
            const idSet = new Set(persistedIds);
            return allMemories.filter((m) => idSet.has(m.frontmatter.id));
          })();

      const entries: Array<{ path: string; createdAt: string; tags: string[] }> = [];
      for (const mem of pool) {
        if (mem.path && mem.frontmatter?.created) {
          entries.push({
            path: mem.path,
            createdAt: mem.frontmatter.created,
            tags: mem.frontmatter.tags ?? [],
          });
        }
      }
      if (needsFullRebuild) {
        // Always write empty indexes on full rebuild — even when the active pool
        // is empty (e.g. store contains only archived/superseded entries).
        // This marks bootstrap completion so indexesExist() returns true and
        // subsequent extractions skip the full-corpus scan.
        clearIndexes(this.config.memoryDir);
        if (entries.length > 0) {
          indexMemoriesBatch(this.config.memoryDir, entries);
        }
        log.info(`temporal-index: bootstrapped from ${entries.length} active memories`);
      } else if (entries.length > 0) {
        indexMemoriesBatch(this.config.memoryDir, entries);
      }
    } catch (err) {
      log.debug(`temporal-index update failed (non-fatal): ${err}`);
    }
  }

  /** IDs of facts persisted in the last extraction */
  private lastPersistedIds: string[] = [];

  private async runConsolidation(): Promise<{ memoriesProcessed: number; merged: number; invalidated: number }> {
    log.info("running consolidation pass");
    let merged = 0;
    let invalidated = 0;

    // Flush access tracking buffer first
    if (this.accessTrackingBuffer.size > 0) {
      await this.flushAccessTracking();
    }

    let allMemories = await this.storage.readAllMemories();
    if (allMemories.length < 5) {
      return { memoriesProcessed: allMemories.length, merged, invalidated };
    }

    const recent = allMemories
      .sort(
        (a, b) =>
          new Date(b.frontmatter.created).getTime() -
          new Date(a.frontmatter.created).getTime(),
      )
      .slice(0, 20);

    const older = allMemories
      .sort(
        (a, b) =>
          new Date(a.frontmatter.created).getTime() -
          new Date(b.frontmatter.created).getTime(),
      );

    const profile = await this.storage.readProfile();
    const result = await this.extraction.consolidate(recent, older, profile);

    // Build a lookup map from the already-loaded corpus to avoid repeated
    // readAllMemories() scans inside getMemoryById for pre-action deindex reads.
    const memoryLookup = this.config.queryAwareIndexingEnabled
      ? new Map(allMemories.map((m) => [m.frontmatter.id, m]))
      : null;

    for (const item of result.items) {
      switch (item.action) {
        case "INVALIDATE": {
          // Capture path/frontmatter before invalidation for index cleanup
          const toInvalidate = this.config.queryAwareIndexingEnabled
            ? (memoryLookup?.get(item.existingId) ?? null)
            : null;
          if (await this.storage.invalidateMemory(item.existingId)) {
            invalidated += 1;
            await this.embeddingFallback.removeFromIndex(item.existingId);
            if (toInvalidate?.path && toInvalidate.frontmatter?.created) {
              deindexMemory(
                this.config.memoryDir,
                toInvalidate.path,
                toInvalidate.frontmatter.created,
                toInvalidate.frontmatter.tags ?? [],
              );
            }
          }
          break;
        }
        case "UPDATE":
          if (item.updatedContent) {
            await this.storage.updateMemory(item.existingId, item.updatedContent, {
              lineage: [item.existingId],
            });
            await this.indexPersistedMemory(this.storage, item.existingId);
            // updateMemory() only changes content/updated/lineage — path, created, and tags
            // are preserved, so the temporal/tag index entry is already correct; no reindex needed.
          }
          break;
        case "MERGE":
          if (item.updatedContent && item.mergeWith) {
            await this.storage.updateMemory(item.existingId, item.updatedContent, {
              supersedes: item.mergeWith,
              lineage: [item.existingId, item.mergeWith],
            });
            await this.indexPersistedMemory(this.storage, item.existingId);
            // updateMemory() only changes content/updated/supersedes/lineage — path, created, and tags
            // are preserved, so the temporal/tag index entry for the survivor is already correct.
            // Capture before invalidation for index cleanup
            const toMergeInvalidate = this.config.queryAwareIndexingEnabled
              ? (memoryLookup?.get(item.mergeWith) ?? null)
              : null;
            if (await this.storage.invalidateMemory(item.mergeWith)) {
              invalidated += 1;
              merged += 1;
              await this.embeddingFallback.removeFromIndex(item.mergeWith);
              if (toMergeInvalidate?.path && toMergeInvalidate.frontmatter?.created) {
                deindexMemory(
                  this.config.memoryDir,
                  toMergeInvalidate.path,
                  toMergeInvalidate.frontmatter.created,
                  toMergeInvalidate.frontmatter.tags ?? [],
                );
              }
            }
          }
          break;
      }
    }

    if (result.profileUpdates.length > 0) {
      await this.storage.appendToProfile(result.profileUpdates);
    }

    for (const entity of result.entityUpdates) {
      const safeFacts = Array.isArray((entity as any)?.facts)
        ? (entity as any).facts.filter((f: any) => typeof f === "string")
        : [];
      await this.storage.writeEntity(entity.name, entity.type, safeFacts);
    }

    // Merge fragmented entity files
    const entitiesMerged = await this.storage.mergeFragmentedEntities();
    if (entitiesMerged > 0) {
      log.info(`merged ${entitiesMerged} fragmented entity files`);
    }

    // Generate entity summaries (v7.0)
    if (this.config.entitySummaryEnabled) {
      try {
        const entityFiles = await this.storage.readAllEntityFiles();
        const needsSummary = entityFiles.filter(
          (e) => e.facts.length > 5 && !e.summary,
        );
        const toSummarize = needsSummary.slice(0, 5);
        let summarized = 0;
        for (const entity of toSummarize) {
          try {
            const factsText = entity.facts.slice(0, 10).join("; ");
            const prompt = `Summarize this entity in one sentence. Entity: ${entity.name} (${entity.type}). Facts: ${factsText}`;
            const response = await this.fastLlm.chatCompletion(
              [
                { role: "system", content: "Respond with a single concise sentence summarizing the entity. No JSON, just plain text." },
                { role: "user", content: prompt },
              ],
              { temperature: 0.3, maxTokens: 100, operation: "entity_summary" },
            );
            if (response?.content) {
              const summary = response.content.trim().replace(/^["']|["']$/g, "");
              if (summary.length > 10 && summary.length < 500) {
                const entityFileName = normalizeEntityName(entity.name, entity.type);
                await this.storage.updateEntitySummary(entityFileName, summary);
                summarized++;
              }
            }
          } catch (err) {
            log.debug(`entity summary generation failed for ${entity.name}: ${err}`);
          }
        }
        if (summarized > 0) {
          log.info(`generated ${summarized} entity summaries`);
        }
      } catch (err) {
        log.debug(`entity summary pass failed: ${err}`);
      }
    }

    // Clean expired commitments
    const deletedCommitments = await this.storage.cleanExpiredCommitments(this.config.commitmentDecayDays);
    if (deletedCommitments.length > 0) {
      log.info(`cleaned ${deletedCommitments.length} expired commitments`);
      if (this.config.queryAwareIndexingEnabled) {
        for (const m of deletedCommitments) {
          deindexMemory(this.config.memoryDir, m.path, m.frontmatter.created, m.frontmatter.tags ?? []);
        }
      }
    }

    if (
      this.config.creationMemoryEnabled &&
      this.config.commitmentLedgerEnabled &&
      this.config.commitmentLifecycleEnabled
    ) {
      try {
        const lifecycle = await applyCommitmentLedgerLifecycle({
          memoryDir: this.config.memoryDir,
          commitmentLedgerDir: this.config.commitmentLedgerDir,
          enabled: true,
          decayDays: this.config.commitmentDecayDays,
        });
        if (lifecycle.transitionedToExpired.length > 0 || lifecycle.deletedResolved.length > 0) {
          log.info(
            `commitment ledger lifecycle: expired ${lifecycle.transitionedToExpired.length}, cleaned ${lifecycle.deletedResolved.length}`,
          );
        }
      } catch (err) {
        log.debug(`commitment ledger lifecycle pass failed: ${err}`);
      }
    }

    // Clean memories past their TTL (speculative memories auto-expire)
    const deletedTTL = await this.storage.cleanExpiredTTL();
    if (deletedTTL.length > 0) {
      log.info(`cleaned ${deletedTTL.length} TTL-expired memories`);
      if (this.config.queryAwareIndexingEnabled) {
        for (const m of deletedTTL) {
          deindexMemory(this.config.memoryDir, m.path, m.frontmatter.created, m.frontmatter.tags ?? []);
        }
      }
    }

    // v8.3 Lifecycle policy pass — deterministic promotion/decay metadata
    if (this.config.lifecyclePolicyEnabled) {
      try {
        const lifecycleCorpus = await this.storage.readAllMemories();
        await this.runLifecyclePolicyPass(lifecycleCorpus);
      } catch (err) {
        log.warn(`lifecycle policy pass failed (ignored): ${err}`);
      }
    }

    // v8.3 Compression guideline learning pass (default off, fail-open).
    await this.runCompressionGuidelineLearningPass();

    await this.runTierMigrationCycle(this.storage, "maintenance");
    allMemories = await this.storage.readAllMemories();

    // Fact archival pass (v6.0) — move old, low-importance, rarely-accessed facts to archive/
    if (this.config.factArchivalEnabled) {
      const archived = await this.runFactArchival(allMemories);
      if (archived > 0) {
        log.info(`archived ${archived} old low-importance facts`);
      }
    }

    // Auto-consolidate IDENTITY.md if it's getting large
    if (this.config.identityEnabled) {
      await this.autoConsolidateIdentity();
    }

    // Auto-consolidate profile.md if it exceeds max lines
    const profileSection = this.getRecallSectionEntry("profile");
    const profileConsolidationTriggerLines =
      typeof profileSection?.consolidateTriggerLines === "number"
        ? Math.max(0, Math.floor(profileSection.consolidateTriggerLines))
        : undefined;
    const profileConsolidationTargetLines =
      typeof profileSection?.consolidateTargetLines === "number"
        ? Math.max(0, Math.floor(profileSection.consolidateTargetLines))
        : 50;
    if (await this.storage.profileNeedsConsolidation(profileConsolidationTriggerLines)) {
      log.info("profile.md exceeds max lines — running smart consolidation");
      const currentProfile = await this.storage.readProfile();
      if (currentProfile) {
        const profileResult = await this.extraction.consolidateProfile(
          currentProfile,
          profileConsolidationTargetLines,
        );
        if (profileResult) {
          await this.storage.writeProfile(profileResult.consolidatedProfile);
          log.info(`profile.md consolidated: removed ${profileResult.removedCount} items — ${profileResult.summary}`);
        }
      }
    }

    // Memory Summarization (Phase 4A)
    if (this.config.summarizationEnabled) {
      await this.runSummarization(allMemories);
    }

    // Topic Extraction (Phase 4B)
    if (this.config.topicExtractionEnabled) {
      await this.runTopicExtraction(allMemories);
    }

    const meta = await this.storage.loadMeta();
    meta.lastConsolidationAt = new Date().toISOString();
    await this.storage.saveMeta(meta);

    // Temporal Memory Tree (v8.2) — rebuild nodes from all memories, fail-open
    if (this.config.temporalMemoryTreeEnabled) {
      try {
        const tmtEntries = allMemories
          .filter((m) => m.frontmatter.status !== "superseded" && m.frontmatter.status !== "archived")
          .map((m) => ({
            path: m.path,
            id: m.frontmatter.id,
            created: m.frontmatter.created,
            content: m.content,
          }));
        await this.tmtBuilder.maybeRebuildNodes(tmtEntries, async (texts, level) => {
          const prompt = `You are a memory archivist. Summarize the following ${level}-level memories into 3–5 sentences, preserving key facts, decisions, and preferences.\n\n${texts.map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}`;
          const response = await this.fastLlm.chatCompletion(
            [
              { role: "system", content: "Respond with a 3–5 sentence narrative summary. No JSON, just plain prose." },
              { role: "user", content: prompt },
            ],
            {
              temperature: 0.3,
              maxTokens: this.config.tmtSummaryMaxTokens,
              operation: "tmt_summary",
            },
          );
          return response?.content?.trim() || texts.slice(0, 3).join(" ");
        });
      } catch (err) {
        log.warn(`tmt: consolidation hook failed (ignored): ${err}`);
      }
    }

    log.info("consolidation complete");
    return { memoriesProcessed: allMemories.length, merged, invalidated };
  }

  async optimizeCompressionGuidelines(options?: {
    dryRun?: boolean;
    eventLimit?: number;
  }): Promise<{
    enabled: boolean;
    dryRun: boolean;
    eventCount: number;
    previousGuidelineVersion: number | null;
    nextGuidelineVersion: number;
    changedRules: number;
    semanticRefinementApplied: boolean;
    persisted: boolean;
  }> {
    const dryRun = options?.dryRun === true;
    const eventLimit =
      typeof options?.eventLimit === "number"
        ? Math.max(0, Math.floor(options.eventLimit))
        : 500;

    const previousState = await this.storage.readCompressionGuidelineOptimizerState();

    if (!this.config.compressionGuidelineLearningEnabled) {
      return {
        enabled: false,
        dryRun,
        eventCount: 0,
        previousGuidelineVersion: previousState?.guidelineVersion ?? null,
        nextGuidelineVersion: previousState?.guidelineVersion ?? 0,
        changedRules: 0,
        semanticRefinementApplied: false,
        persisted: false,
      };
    }

    const events = await this.storage.readMemoryActionEvents(eventLimit);
    const generatedAt = new Date().toISOString();
    const candidate = computeCompressionGuidelineCandidate(events, {
      generatedAtIso: generatedAt,
      previousState,
    });
    const refinedCandidate = await refineCompressionGuidelineCandidateSemantically(candidate, {
      enabled: this.config.compressionGuidelineSemanticRefinementEnabled,
      timeoutMs: this.config.compressionGuidelineSemanticTimeoutMs,
      runRefinement: async (baseline) => {
        const prompt = [
          "You refine compression policy suggestions conservatively.",
          "Return JSON only in this shape:",
          '{"updates":[{"action":"summarize_node","delta":0.02,"confidence":"medium","note":"..."}]}',
          "Constraints:",
          "- Keep updates sparse and conservative.",
          "- delta must stay between -0.15 and 0.15.",
          "- Only include actions present in the input.",
          "Input candidate:",
          JSON.stringify(baseline),
        ].join("\n");

        const response = await this.fastLlm.chatCompletion(
          [
            { role: "system", content: "Respond with strict JSON only. No markdown." },
            { role: "user", content: prompt },
          ],
          {
            temperature: 0.1,
            maxTokens: 400,
            timeoutMs: this.config.compressionGuidelineSemanticTimeoutMs,
            operation: "compression_guideline_semantic_refinement",
          },
        );

        return this.parseCompressionSemanticRefinement(response?.content ?? "");
      },
    });

    const content = renderCompressionGuidelinesMarkdown(refinedCandidate);
    const semanticRefinementApplied =
      JSON.stringify(refinedCandidate.ruleUpdates) !== JSON.stringify(candidate.ruleUpdates);
    const changedRules = refinedCandidate.ruleUpdates.filter((rule) => rule.delta !== 0).length;

    if (!dryRun) {
      await this.storage.writeCompressionGuidelines(content);
      await this.storage.writeCompressionGuidelineOptimizerState({
        version: refinedCandidate.optimizerVersion,
        updatedAt: refinedCandidate.generatedAt,
        sourceWindow: refinedCandidate.sourceWindow,
        eventCounts: refinedCandidate.eventCounts,
        guidelineVersion: refinedCandidate.guidelineVersion,
      });
    }

    return {
      enabled: true,
      dryRun,
      eventCount: events.length,
      previousGuidelineVersion: previousState?.guidelineVersion ?? null,
      nextGuidelineVersion: refinedCandidate.guidelineVersion,
      changedRules,
      semanticRefinementApplied,
      persisted: !dryRun,
    };
  }

  private async runCompressionGuidelineLearningPass(): Promise<void> {
    if (!this.config.compressionGuidelineLearningEnabled) return;
    try {
      const result = await this.optimizeCompressionGuidelines({ dryRun: false, eventLimit: 500 });
      log.info(`compression guideline learning updated (${result.eventCount} events)`);
    } catch (err) {
      log.warn(`compression guideline learning failed (ignored): ${err}`);
    }
  }

  private async buildCompressionGuidelineRecallSection(): Promise<string | null> {
    if (!this.config.contextCompressionActionsEnabled) return null;
    if (!this.config.compressionGuidelineLearningEnabled) return null;

    const state = await this.storage.readCompressionGuidelineOptimizerState().catch(() => null);
    if (!state || state.guidelineVersion <= 0) return null;

    const raw = await this.storage.readCompressionGuidelines().catch(() => null);
    const summary = raw ? formatCompressionGuidelinesForRecall(raw, 5) : null;
    if (!summary) return null;

    return [
      "## Active Compression Guidelines",
      "",
      `Guideline version: ${state.guidelineVersion}`,
      `Updated: ${state.updatedAt}`,
      "",
      summary,
    ].join("\n");
  }

  private parseCompressionSemanticRefinement(
    raw: string,
  ): {
    updates: Array<{
      action: MemoryActionType;
      delta?: number;
      confidence?: "low" | "medium" | "high";
      note?: string;
    }>;
  } | null {
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;

    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as {
        updates?: Array<{ action?: unknown; delta?: unknown; confidence?: unknown; note?: unknown }>;
      };
      if (!Array.isArray(parsed?.updates)) return null;

      const validActions = new Set<MemoryActionType>([
        "store_episode",
        "store_note",
        "update_note",
        "create_artifact",
        "summarize_node",
        "discard",
        "link_graph",
      ]);

      const updates = parsed.updates
        .filter((item) => item && typeof item.action === "string" && validActions.has(item.action as MemoryActionType))
        .map((item) => {
          const confidence: "low" | "medium" | "high" | undefined =
            item.confidence === "low" || item.confidence === "medium" || item.confidence === "high"
              ? item.confidence
              : undefined;
          return {
            action: item.action as MemoryActionType,
            delta: typeof item.delta === "number" && Number.isFinite(item.delta) ? item.delta : undefined,
            confidence,
            note: typeof item.note === "string" ? item.note : undefined,
          };
        });

      return { updates };
    } catch {
      return null;
    }
  }

  private actionOutcomePriorDelta(event: MemoryActionEvent): number {
    if (event.outcome === "failed") return -0.3;
    if (event.policyDecision === "deny") return -0.22;
    if (event.policyDecision === "defer") return -0.14;
    if (event.outcome === "skipped") return -0.1;

    if (event.outcome !== "applied") return 0;
    switch (event.action) {
      case "store_episode":
      case "store_note":
      case "update_note":
        return 0.08;
      case "create_artifact":
      case "summarize_node":
      case "link_graph":
        return 0.04;
      case "discard":
        return -0.03;
      default:
        return 0;
    }
  }

  private async buildLifecycleActionPriors(): Promise<Map<string, number>> {
    const events = await this.storage.readMemoryActionEvents(1200);
    if (events.length === 0) return new Map<string, number>();

    const nowMs = Date.now();
    const windowMs = 14 * 24 * 60 * 60 * 1000;
    const byMemory = new Map<string, Array<{ weightedDelta: number; weight: number }>>();

    for (const event of events) {
      if (typeof event.memoryId !== "string" || event.memoryId.trim().length === 0) continue;
      const ts = Date.parse(event.timestamp);
      if (!Number.isFinite(ts)) continue;
      const ageMs = nowMs - ts;
      if (ageMs < 0 || ageMs > windowMs) continue;

      const delta = this.actionOutcomePriorDelta(event);
      if (delta === 0) continue;

      const recencyWeight = Math.max(0.2, 1 - ageMs / windowMs);
      const list = byMemory.get(event.memoryId) ?? [];
      if (list.length >= 8) list.shift();
      list.push({ weightedDelta: delta * recencyWeight, weight: recencyWeight });
      byMemory.set(event.memoryId, list);
    }

    const out = new Map<string, number>();
    for (const [memoryId, deltas] of byMemory.entries()) {
      if (deltas.length === 0) continue;
      const weightedSum = deltas.reduce((sum, item) => sum + item.weightedDelta, 0);
      const weightTotal = deltas.reduce((sum, item) => sum + item.weight, 0);
      if (weightTotal <= 0) continue;
      const score = weightedSum / weightTotal;
      out.set(memoryId, Math.max(-0.25, Math.min(0.15, score)));
    }
    return out;
  }

  private async runLifecyclePolicyPass(allMemories: MemoryFile[]): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();
    const countsByState: Record<LifecycleState, number> = {
      candidate: 0,
      validated: 0,
      active: 0,
      stale: 0,
      archived: 0,
    };
    const transitionCounts: Record<string, number> = {};
    let updatedCount = 0;
    let disputedCount = 0;
    let evaluatedCount = 0;

    const thresholds = this.effectiveLifecycleThresholds();
    const policy = {
      promoteHeatThreshold: thresholds.promoteHeatThreshold,
      staleDecayThreshold: thresholds.staleDecayThreshold,
      archiveDecayThreshold: thresholds.archiveDecayThreshold,
      protectedCategories: this.config.lifecycleProtectedCategories,
    };
    const actionPriors = await this.buildLifecycleActionPriors();

    for (const memory of allMemories) {
      if (memory.frontmatter.status === "superseded") {
        continue;
      }
      evaluatedCount += 1;
      const currentState = resolveLifecycleState(memory.frontmatter);
      const actionPriorScore = actionPriors.get(memory.frontmatter.id);
      const signals: LifecycleSignals | undefined =
        typeof actionPriorScore === "number" && Number.isFinite(actionPriorScore)
          ? { actionPriorScore }
          : undefined;
      const decision = decideLifecycleTransition(memory, policy, now, signals);
      const nextState: LifecycleState = memory.frontmatter.status === "archived"
        ? "archived"
        : decision.nextState;

      countsByState[nextState] += 1;
      if (memory.frontmatter.verificationState === "disputed") {
        disputedCount += 1;
      }
      if (nextState !== currentState) {
        const key = `${currentState}->${nextState}`;
        transitionCounts[key] = (transitionCounts[key] ?? 0) + 1;
      }

      const prevHeat = memory.frontmatter.heatScore;
      const prevDecay = memory.frontmatter.decayScore;
      const scoreDelta =
        Math.abs((prevHeat ?? -1) - decision.heatScore) +
        Math.abs((prevDecay ?? -1) - decision.decayScore);
      const shouldPersist =
        memory.frontmatter.lifecycleState !== nextState ||
        memory.frontmatter.heatScore === undefined ||
        memory.frontmatter.decayScore === undefined ||
        memory.frontmatter.lastValidatedAt === undefined ||
        scoreDelta >= 0.01;

      if (!shouldPersist) continue;

      const wrote = await this.storage.writeMemoryFrontmatter(memory, {
        lifecycleState: nextState,
        heatScore: decision.heatScore,
        decayScore: decision.decayScore,
        lastValidatedAt: nowIso,
      });
      if (wrote) updatedCount += 1;
    }

    if (!this.config.lifecycleMetricsEnabled) return;

    const total = evaluatedCount;
    const metrics = {
      generatedAt: nowIso,
      memoriesEvaluated: total,
      memoriesUpdated: updatedCount,
      countsByLifecycleState: countsByState,
      transitionCounts,
      staleRatio: total > 0 ? countsByState.stale / total : 0,
      disputedRatio: total > 0 ? disputedCount / total : 0,
      policy: {
        promoteHeatThreshold: thresholds.promoteHeatThreshold,
        staleDecayThreshold: thresholds.staleDecayThreshold,
        archiveDecayThreshold: thresholds.archiveDecayThreshold,
        protectedCategories: this.config.lifecycleProtectedCategories,
      },
    };
    const metricsPath = path.join(this.storage.dir, "state", "lifecycle-metrics.json");
    await mkdir(path.dirname(metricsPath), { recursive: true });
    await writeFile(metricsPath, JSON.stringify(metrics, null, 2), "utf-8");
  }

  /**
   * Archive old, low-importance, rarely-accessed facts (v6.0).
   * Moves eligible facts from facts/ to archive/YYYY-MM-DD/.
   * Returns the number of archived facts.
   */
  private async runFactArchival(allMemories: import("./types.js").MemoryFile[]): Promise<number> {
    const now = Date.now();
    const ageCutoffMs = this.config.factArchivalAgeDays * 24 * 60 * 60 * 1000;
    const protectedCategories = new Set(this.config.factArchivalProtectedCategories);
    let archivedCount = 0;

    for (const memory of allMemories) {
      const fm = memory.frontmatter;

      // Skip already-archived or superseded
      if (fm.status && fm.status !== "active") continue;

      // Skip protected categories
      if (protectedCategories.has(fm.category)) continue;

      // Skip corrections (always keep)
      if (fm.category === "correction") continue;

      // Check age requirement
      const createdMs = new Date(fm.created).getTime();
      if (now - createdMs < ageCutoffMs) continue;

      // Check importance (only archive low-importance facts)
      const importanceScore = fm.importance?.score ?? 0.5;
      if (importanceScore >= this.config.factArchivalMaxImportance) continue;

      // Check access count
      const accessCount = fm.accessCount ?? 0;
      if (accessCount > this.config.factArchivalMaxAccessCount) continue;

      // All criteria met — archive
      const result = await this.storage.archiveMemory(memory);
      if (result) {
        // Remove from content-hash index since it's no longer in hot search
        if (this.contentHashIndex) {
          this.contentHashIndex.remove(memory.content);
        }
        await this.embeddingFallback.removeFromIndex(memory.frontmatter.id);
        if (this.config.queryAwareIndexingEnabled && memory.path && memory.frontmatter?.created) {
          deindexMemory(
            this.config.memoryDir,
            memory.path,
            memory.frontmatter.created,
            memory.frontmatter.tags ?? [],
          );
        }
        archivedCount++;
      }
    }

    // Save hash index if we removed any entries
    if (archivedCount > 0 && this.contentHashIndex) {
      await this.contentHashIndex.save().catch((err) =>
        log.warn(`content-hash index save failed during archival: ${err}`),
      );
    }

    return archivedCount;
  }

  /**
   * Run memory summarization if memory count exceeds threshold (Phase 4A).
   */
  private async runSummarization(allMemories: import("./types.js").MemoryFile[]): Promise<void> {
    // Only active memories count toward the threshold
    const activeMemories = allMemories.filter(
      (m) => !m.frontmatter.status || m.frontmatter.status === "active",
    );

    if (activeMemories.length < this.config.summarizationTriggerCount) {
      return;
    }

    log.info(`memory count (${activeMemories.length}) exceeds threshold (${this.config.summarizationTriggerCount}) — running summarization`);

    // Sort by creation date, oldest first
    const sorted = activeMemories.sort(
      (a, b) =>
        new Date(a.frontmatter.created).getTime() -
        new Date(b.frontmatter.created).getTime(),
    );

    // Keep recent memories
    const toKeep = sorted.slice(-this.config.summarizationRecentToKeep);
    const toSummarize = sorted.slice(0, -this.config.summarizationRecentToKeep);

    // Filter candidates for summarization
    const candidates = toSummarize.filter((m) => {
      // Skip if protected by entity reference
      if (m.frontmatter.entityRef) return false;

      // Skip if protected by tag
      const protectedTags = this.config.summarizationProtectedTags;
      if (m.frontmatter.tags.some((t) => protectedTags.includes(t))) return false;

      // Skip if importance is above threshold
      const importance = m.frontmatter.importance?.score ?? 0.5;
      if (importance >= this.config.summarizationImportanceThreshold) return false;

      return true;
    });

    if (candidates.length < 50) {
      log.debug(`only ${candidates.length} candidates for summarization — skipping`);
      return;
    }

    // Summarize in batches of 50
    const batchSize = 50;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const batchData = batch.map((m) => ({
        id: m.frontmatter.id,
        content: m.content,
        category: m.frontmatter.category,
        created: m.frontmatter.created,
      }));

      const result = await this.extraction.summarizeMemories(batchData);
      if (!result) continue;

      // Create summary
      const summary: MemorySummary = {
        id: `summary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
        timeRangeStart: batch[0].frontmatter.created,
        timeRangeEnd: batch[batch.length - 1].frontmatter.created,
        summaryText: result.summaryText,
        keyFacts: result.keyFacts,
        keyEntities: result.keyEntities,
        sourceEpisodeIds: batch.map((m) => m.frontmatter.id),
      };

      await this.storage.writeSummary(summary);

      // Archive source memories
      const archived = await this.storage.archiveMemories(
        batch.map((m) => m.frontmatter.id),
        summary.id,
      );

      log.info(`created summary ${summary.id} from ${batch.length} memories, archived ${archived}`);
    }
  }

  /**
   * Run topic extraction on all memories (Phase 4B).
   */
  private async runTopicExtraction(allMemories: import("./types.js").MemoryFile[]): Promise<void> {
    // Only extract from active memories
    const activeMemories = allMemories.filter(
      (m) => !m.frontmatter.status || m.frontmatter.status === "active",
    );

    if (activeMemories.length === 0) return;

    const topics = extractTopics(activeMemories, this.config.topicExtractionTopN);
    await this.storage.saveTopics(topics);

    log.debug(`extracted ${topics.length} topics from ${activeMemories.length} memories`);
  }

  /** Threshold (bytes) at which IDENTITY.md reflections get auto-consolidated */
  private static readonly IDENTITY_CONSOLIDATE_THRESHOLD = 8_000;

  private async autoConsolidateIdentity(): Promise<void> {
    const namespaces = this.config.namespacesEnabled
      ? this.configuredNamespaces()
      : [this.config.defaultNamespace];

    for (const namespace of namespaces) {
      const storage = await this.storageRouter.storageFor(namespace);
      const identityNamespace =
        this.config.namespacesEnabled && namespace !== this.config.defaultNamespace
          ? namespace
          : undefined;
      const reflectionsContent = (await storage.readIdentityReflections()) ?? "";

      const existingIdentity = await storage.readIdentity(this.config.workspaceDir, identityNamespace);
      const headerEnd =
        existingIdentity.indexOf("## Learned Patterns") !== -1
          ? existingIdentity.indexOf("## Learned Patterns")
          : existingIdentity.indexOf("## Reflection");
      const staticHeader =
        (headerEnd !== -1 ? existingIdentity.slice(0, headerEnd) : existingIdentity).trimEnd() ||
        "# IDENTITY";
      const identityContent = `${staticHeader}\n\n${reflectionsContent.trim()}\n`;
      if (identityContent.length < Orchestrator.IDENTITY_CONSOLIDATE_THRESHOLD) continue;

      log.info(`IDENTITY(${namespace}) is ${identityContent.length} chars — auto-consolidating reflections`);
      const result = await this.extraction.consolidateIdentity(identityContent, "## Reflection");

      if (!result || result.learnedPatterns.length === 0) {
        log.warn(`identity consolidation produced no patterns for namespace=${namespace}`);
        continue;
      }

      const patternsSection = [
        "## Learned Patterns (consolidated from reflections, " + new Date().toISOString().slice(0, 10) + ")",
        "",
        ...result.learnedPatterns.map((p) => `- ${p}`),
        "",
      ].join("\n");

      const newContent = staticHeader + "\n\n" + patternsSection + "\n";

      await storage.writeIdentity(this.config.workspaceDir, newContent, identityNamespace);
      await storage.writeIdentityReflections("");
      log.info(
        `IDENTITY(${namespace}) consolidated: ${identityContent.length} → ${newContent.length} chars, ${result.learnedPatterns.length} patterns`,
      );
    }
  }

  private formatQmdResults(
    title: string,
    results: QmdSearchResult[],
  ): string {
    const lines = results.map((r, i) => {
      const snippet = r.snippet
        ? r.snippet.slice(0, 500).replace(/\n/g, " ")
        : "(no preview)";
      return `[${i + 1}] ${r.path} (score: ${r.score.toFixed(3)})\n${snippet}`;
    });
    return `## ${title}\n\n${lines.join("\n\n")}`;
  }

  private formatObjectiveStateResults(results: ObjectiveStateSearchResult[]): string {
    const lines = results.map(({ snapshot }, index) => {
      const parts = [
        snapshot.recordedAt.replace("T", " ").slice(0, 16),
        `${snapshot.kind}/${snapshot.changeKind}`,
      ];
      if (snapshot.outcome) parts.push(snapshot.outcome);
      const header = `[${index + 1}] ${parts.join(" | ")} | ${snapshot.scope}`;
      const detailParts = [snapshot.summary];
      if (snapshot.command) detailParts.push(`command: ${snapshot.command}`);
      else if (snapshot.toolName) detailParts.push(`tool: ${snapshot.toolName}`);
      return `${header}\n${detailParts.join(" | ")}`;
    });
    return `## Objective State\n\n${lines.join("\n\n")}`;
  }

  private formatCausalTrajectoryResults(results: CausalTrajectorySearchResult[]): string {
    const lines = results.map(({ record, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${record.recordedAt.replace("T", " ").slice(0, 16)}`,
        record.outcomeKind,
        record.sessionKey,
      ].join(" | ");
      const details = [
        `goal: ${record.goal}`,
        `action: ${record.actionSummary}`,
        `observation: ${record.observationSummary}`,
        `outcome: ${record.outcomeSummary}`,
      ];
      if (record.followUpSummary) details.push(`follow-up: ${record.followUpSummary}`);
      if (matchedFields.length > 0) details.push(`matched: ${matchedFields.join(", ")}`);
      return `${header}\n${details.join("\n")}`;
    });

    return `## Causal Trajectories\n\n${lines.join("\n\n")}`;
  }

  private formatTrustZoneResults(results: TrustZoneSearchResult[]): string {
    const lines = results.map(({ record, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${record.recordedAt.replace("T", " ").slice(0, 16)}`,
        record.zone,
        record.kind,
      ].join(" | ");
      const details = [
        record.summary,
        `provenance: ${record.provenance.sourceClass}`,
      ];
      if (record.entityRefs && record.entityRefs.length > 0) {
        details.push(`entities: ${record.entityRefs.join(", ")}`);
      }
      if (record.tags && record.tags.length > 0) {
        details.push(`tags: ${record.tags.join(", ")}`);
      }
      if (matchedFields.length > 0) {
        details.push(`matched: ${matchedFields.join(", ")}`);
      }
      return `${header}\n${details.join("\n")}`;
    });

    return `## Trust Zones\n\n${lines.join("\n\n")}`;
  }

  private formatHarmonicRetrievalResults(results: HarmonicRetrievalResult[]): string {
    const lines = results.map(({ node, matchedAnchors, matchedFields, nodeScore, anchorScore }, index) => {
      const header = [
        `[${index + 1}] ${node.recordedAt.replace("T", " ").slice(0, 16)}`,
        `${node.kind}/${node.abstractionLevel}`,
        node.sessionKey,
      ].join(" | ");
      const details = [
        node.title,
        node.summary,
        `scores: node=${nodeScore.toFixed(1)} anchor=${anchorScore.toFixed(1)}`,
      ];
      if (matchedAnchors.length > 0) {
        details.push(`anchors: ${matchedAnchors.map((anchor) => `${anchor.anchorType}:${anchor.anchorValue}`).join("; ")}`);
      }
      if (matchedFields.length > 0) {
        details.push(`matched: ${matchedFields.join(", ")}`);
      }
      return `${header}\n${details.join("\n")}`;
    });

    return `## Harmonic Retrieval\n\n${lines.join("\n\n")}`;
  }

  private formatWorkProductResults(results: WorkProductLedgerSearchResult[]): string {
    const lines = results.map(({ entry, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${entry.recordedAt.replace("T", " ").slice(0, 16)}`,
        `${entry.kind}/${entry.action}`,
        entry.sessionKey,
      ].join(" | ");
      const details = [entry.summary, `scope: ${entry.scope}`];
      if (entry.artifactPath) details.push(`artifact: ${entry.artifactPath}`);
      if (entry.tags && entry.tags.length > 0) details.push(`tags: ${entry.tags.join(", ")}`);
      if (matchedFields.length > 0) details.push(`matched: ${matchedFields.join(", ")}`);
      return `${header}\n${details.join("\n")}`;
    });

    return `## Work Products\n\n${lines.join("\n\n")}`;
  }

  private formatVerifiedEpisodeResults(results: VerifiedEpisodeResult[]): string {
    const lines = results.map(({ box, verifiedEpisodeCount, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${box.sealedAt.replace("T", " ").slice(0, 16)}`,
        box.traceId ? `trace:${box.traceId.slice(0, 12)}` : "trace:none",
      ].join(" | ");
      const details = [
        box.goal ?? `topics: ${box.topics.join(", ")}`,
        `verified episodes: ${verifiedEpisodeCount}`,
      ];
      if (box.toolsUsed && box.toolsUsed.length > 0) {
        details.push(`tools: ${box.toolsUsed.join(", ")}`);
      }
      if (matchedFields.length > 0) {
        details.push(`matched: ${matchedFields.join(", ")}`);
      }
      return `${header}\n${details.join("\n")}`;
    });

    return `## Verified Episodes\n\n${lines.join("\n\n")}`;
  }

  private formatVerifiedSemanticRuleResults(results: VerifiedSemanticRuleResult[]): string {
    const lines = results.map(({ rule, sourceMemoryId, verificationStatus, effectiveConfidence, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${rule.frontmatter.updated.replace("T", " ").slice(0, 16)}`,
        verificationStatus,
        `confidence:${effectiveConfidence.toFixed(2)}`,
      ].join(" | ");
      const details = [
        rule.content,
        `source memory: ${sourceMemoryId}`,
      ];
      if (matchedFields.length > 0) {
        details.push(`matched: ${matchedFields.join(", ")}`);
      }
      return `${header}\n${details.join("\n")}`;
    });

    return `## Verified Rules\n\n${lines.join("\n\n")}`;
  }

  private summarizeIdentityText(raw: string, maxLines: number, maxChars: number): string {
    const lines = raw
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    const compact = lines.slice(0, Math.max(1, maxLines)).join(" ");
    if (compact.length <= maxChars) return compact;
    return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  private formatOpenIncidentLine(incident: ContinuityIncidentRecord, includeDetails: boolean): string {
    const base = `[${incident.id}] ${incident.symptom.trim()}`;
    if (!includeDetails) return `- ${base}`;
    const parts = [base];
    if (incident.suspectedCause) parts.push(`cause: ${incident.suspectedCause.trim()}`);
    if (incident.triggerWindow) parts.push(`window: ${incident.triggerWindow.trim()}`);
    return `- ${parts.join(" | ")}`;
  }

  private trimIdentitySection(content: string, maxChars: number): { text: string; truncated: boolean } {
    if (maxChars <= 0) return { text: "", truncated: false };
    if (content.length <= maxChars) return { text: content, truncated: false };
    const suffix = "\n\n...(identity continuity trimmed)";
    if (maxChars <= suffix.length) {
      return { text: content.slice(0, maxChars), truncated: true };
    }
    const headroom = Math.max(0, maxChars - suffix.length);
    return { text: `${content.slice(0, headroom)}${suffix}`, truncated: true };
  }

  private async buildIdentityContinuitySection(options: {
    storage: StorageManager;
    recallMode: RecallPlanMode;
    prompt: string;
  }): Promise<{ section: string; mode: IdentityInjectionMode; injectedChars: number; truncated: boolean } | null> {
    if (!this.config.identityContinuityEnabled) return null;
    if (this.config.identityMaxInjectChars <= 0) return null;

    const resolved = resolveEffectiveIdentityInjectionMode({
      configuredMode: this.config.identityInjectionMode,
      recallMode: options.recallMode,
      prompt: options.prompt,
    });
    if (!resolved.shouldInject) return null;

    const [anchorRaw, loopsRaw, incidents] = await Promise.all([
      options.storage.readIdentityAnchor(),
      options.storage.readIdentityImprovementLoops(),
      options.storage.readContinuityIncidents(200),
    ]);
    const openIncidents = incidents.filter((incident) => incident.state === "open");

    const lines: string[] = [];
    if (resolved.mode === "full") {
      lines.push("## Identity Continuity");
      if (anchorRaw && anchorRaw.trim().length > 0) {
        lines.push("", "### Anchor", "", anchorRaw.trim());
      }
      if (loopsRaw && loopsRaw.trim().length > 0) {
        lines.push("", "### Improvement Loops", "", loopsRaw.trim());
      }
      lines.push("", "### Open Incidents", "");
      if (openIncidents.length === 0) {
        lines.push("- none");
      } else {
        lines.push(
          ...openIncidents.slice(0, 5).map((incident) => this.formatOpenIncidentLine(incident, true)),
        );
      }
    } else {
      const anchorSummary = anchorRaw ? this.summarizeIdentityText(anchorRaw, 3, 320) : "";
      const loopsSummary = loopsRaw ? this.summarizeIdentityText(loopsRaw, 2, 240) : "";
      lines.push("## Identity Continuity Signals", "");
      if (anchorSummary) lines.push(`- anchor: ${anchorSummary}`);
      if (loopsSummary) lines.push(`- loops: ${loopsSummary}`);
      if (openIncidents.length === 0) {
        lines.push("- incidents: 0 open");
      } else {
        lines.push(`- incidents: ${openIncidents.length} open`);
        lines.push(...openIncidents.slice(0, 2).map((incident) => this.formatOpenIncidentLine(incident, false)));
      }
    }

    const body = lines.join("\n").trim();
    if (!body) return null;

    const { text, truncated } = this.trimIdentitySection(body, this.config.identityMaxInjectChars);
    if (!text) return null;

    return {
      section: text,
      mode: resolved.mode,
      injectedChars: text.length,
      truncated,
    };
  }

  private emitTrace(event: EngramTraceEvent): void {
    try {
      const cb = (globalThis as any).__openclawEngramTrace;
      if (typeof cb === "function") cb(event);
    } catch (err) {
      log.debug(`trace callback failed: ${err}`);
    }
  }

  private queueEvalShadowRecall(
    record: Omit<EvalShadowRecallRecord, "schemaVersion">,
  ): void {
    if (!this.config.evalHarnessEnabled || !this.config.evalShadowModeEnabled) return;
    this.evalShadowWriteChain = this.evalShadowWriteChain
      .catch(() => undefined)
      .then(async () => {
        try {
          await recordEvalShadowRecall({
            memoryDir: this.config.memoryDir,
            evalStoreDir: this.config.evalStoreDir,
            record: {
              schemaVersion: 1,
              ...record,
            },
          });
        } catch (err) {
          log.debug(`eval shadow recall write failed: ${err}`);
        }
      });
  }

  private publishRecallResults(options: {
    title: string;
    results: QmdSearchResult[];
    sectionBuckets: Map<string, string[]>;
    retrievalQuery: string;
    sessionKey: string | undefined;
    identityInjection?: {
      mode: IdentityInjectionMode | "none";
      injectedChars: number;
      truncated: boolean;
    };
  }): void {
    const memoryIds = this.extractMemoryIdsFromResults(options.results);
    this.trackMemoryAccess(memoryIds);

    if (options.sessionKey) {
      const unique = Array.from(new Set(memoryIds)).slice(0, 40);
      this.lastRecall
        .record({
          sessionKey: options.sessionKey,
          query: options.retrievalQuery,
          memoryIds: unique,
          policyVersion: this.currentPolicyVersion(),
          identityInjection: options.identityInjection,
        })
        .catch((err) => log.debug(`last recall record failed: ${err}`));
    }

    this.appendRecallSection(
      options.sectionBuckets,
      "memories",
      this.formatQmdResults(options.title, options.results),
    );
  }

  private async searchEmbeddingFallback(query: string, limit: number): Promise<QmdSearchResult[]> {
    if (!this.config.embeddingFallbackEnabled) return [];
    if (!(await this.embeddingFallback.isAvailable())) return [];
    const hits = await this.embeddingFallback.search(query, limit);
    if (hits.length === 0) return [];

    const results: QmdSearchResult[] = [];
    for (const hit of hits) {
      const fullPath = path.isAbsolute(hit.path) ? hit.path : path.join(this.config.memoryDir, hit.path);
      const memory = await this.storage.readMemoryByPath(fullPath);
      if (!memory) continue;
      results.push({
        docid: hit.id,
        path: fullPath,
        score: hit.score,
        snippet: memory.content.slice(0, 400).replace(/\n/g, " "),
      });
    }
    return results;
  }

  /**
   * Long-term fallback retrieval.
   * Searches archived memories only, and is invoked only when hot recall returns zero hits.
   */
  private async searchLongTermArchiveFallback(
    prompt: string,
    recallNamespaces: string[],
    limit: number,
    queryAwarePrefilter?: QueryAwarePrefilter,
  ): Promise<QmdSearchResult[]> {
    const cappedLimit = Math.max(0, limit);
    if (cappedLimit === 0) return [];

    const scopedSeedResults = queryAwarePrefilter?.candidatePaths?.size
      ? await this.searchScopedMemoryCandidates(
        queryAwarePrefilter.candidatePaths,
        prompt,
        cappedLimit,
        { allowArchived: true },
      )
      : [];
    if (scopedSeedResults.length >= cappedLimit) {
      return scopedSeedResults
        .filter((result) => !isArtifactMemoryPath(result.path))
        .slice(0, cappedLimit);
    }

    const tokens = Array.from(new Set(tokenizeRecallQuery(prompt)));
    if (tokens.length === 0) return scopedSeedResults;

    const archivedMemories = await this.readArchivedMemoriesForNamespaces(recallNamespaces);
    if (archivedMemories.length === 0) return scopedSeedResults;

    const scored: QmdSearchResult[] = [];
    for (const memory of archivedMemories) {
      const haystack = [
        memory.content,
        memory.frontmatter.category,
        ...(memory.frontmatter.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      let hits = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) hits += 1;
      }
      if (hits === 0) continue;
      const normalized = hits / tokens.length;
      scored.push({
        docid: memory.frontmatter.id,
        path: memory.path,
        score: normalized,
        snippet: memory.content.slice(0, 400).replace(/\n/g, " "),
      });
    }

    const mergedByPath = new Map<string, QmdSearchResult>();
    for (const result of [...scopedSeedResults, ...scored]) {
      const key = result.path || result.docid;
      const existing = mergedByPath.get(key);
      if (!existing || result.score > existing.score) {
        mergedByPath.set(key, {
          ...result,
          snippet: result.snippet || existing?.snippet || "",
        });
      }
    }

    return [...mergedByPath.values()]
      .filter((result) => !isArtifactMemoryPath(result.path))
      .sort((a, b) => b.score - a.score)
      .slice(0, cappedLimit);
  }

  private async applyColdFallbackPipeline(options: {
    prompt: string;
    recallNamespaces: string[];
    recallResultLimit: number;
    recallMode: RecallPlanMode;
    queryAwarePrefilter?: QueryAwarePrefilter;
  }): Promise<QmdSearchResult[]> {
    const coldQmdEnabled = this.config.qmdColdTierEnabled === true;
    const coldCollection = this.config.qmdColdCollection ?? "openclaw-engram-cold";
    const coldMaxResults = this.config.qmdColdMaxResults ?? this.config.qmdMaxResults;

    let longTerm: QmdSearchResult[] = [];
    if (coldQmdEnabled && this.qmd.isAvailable()) {
      const coldFetchLimit = Math.max(
        0,
        Math.min(options.recallResultLimit, Math.max(0, coldMaxResults)),
      );
      if (coldFetchLimit > 0) {
        const coldHybridLimit = computeQmdHybridFetchLimit(
          coldFetchLimit,
          false,
          0,
        );
        longTerm = await this.fetchQmdMemoryResultsWithArtifactTopUp(
          options.prompt,
          coldFetchLimit,
          coldHybridLimit,
          {
            namespacesEnabled: this.config.namespacesEnabled,
            recallNamespaces: options.recallNamespaces,
            resolveNamespace: (p) => this.namespaceFromPath(p),
            collection: coldCollection,
            queryAwarePrefilter: options.queryAwarePrefilter,
          },
        );
        if (longTerm.length > 0) {
          log.debug(`cold-tier recall source=cold-qmd collection=${coldCollection} hits=${longTerm.length}`);
        }
      }
    }
    if (longTerm.length === 0) {
      longTerm = await this.searchLongTermArchiveFallback(
        options.prompt,
        options.recallNamespaces,
        options.recallResultLimit,
        options.queryAwarePrefilter,
      );
      if (longTerm.length > 0) {
        log.debug("cold-tier recall source=archive-scan");
      }
    }
    if (longTerm.length === 0) return [];

    let results = longTerm;
    if (this.config.namespacesEnabled) {
      results = results.filter((r) =>
        options.recallNamespaces.includes(this.namespaceFromPath(r.path)),
      );
    }
    // Artifact isolation contract: generic recall paths must exclude artifacts.
    results = results.filter((r) => !isArtifactMemoryPath(r.path));
    if (results.length === 0) return [];

    const isFullModeGraphAssist =
      this.config.qmdTierParityGraphEnabled &&
      this.config.multiGraphMemoryEnabled &&
      this.config.graphAssistInFullModeEnabled !== false &&
      options.recallMode === "full" &&
      results.length >= Math.max(1, this.config.graphAssistMinSeedResults ?? 3);
    const shouldRunGraphExpansion =
      this.config.qmdTierParityGraphEnabled &&
      (options.recallMode === "graph_mode" || isFullModeGraphAssist);

    if (shouldRunGraphExpansion) {
      const { merged } = await this.expandResultsViaGraph({
        memoryResults: results,
        recallNamespaces: options.recallNamespaces,
        recallResultLimit: options.recallResultLimit,
      });
      results = merged;
    }

    results = await this.boostSearchResults(
      results,
      options.recallNamespaces,
      options.prompt,
      undefined,
      { allowLifecycleFiltered: true },
    );

    if (this.config.rerankEnabled && this.config.rerankProvider === "local") {
      const ranked = await rerankLocalOrNoop({
        query: options.prompt,
        candidates: results.slice(0, this.config.rerankMaxCandidates).map((r) => ({
          id: r.path,
          snippet: r.snippet || r.path,
        })),
        local: this.fastLlm,
        enabled: true,
        timeoutMs: this.config.rerankTimeoutMs,
        maxCandidates: this.config.rerankMaxCandidates,
        cache: this.rerankCache,
        cacheEnabled: this.config.rerankCacheEnabled,
        cacheTtlMs: this.config.rerankCacheTtlMs,
      });
      if (ranked && ranked.length > 0) {
        const byPath = new Map(results.map((r) => [r.path, r]));
        const reordered: QmdSearchResult[] = [];
        for (const p of ranked) {
          const it = byPath.get(p);
          if (it) reordered.push(it);
        }
        const rankedSet = new Set(ranked);
        for (const r of results) {
          if (!rankedSet.has(r.path)) reordered.push(r);
        }
        results = reordered;
      }
    }
    if (this.config.rerankEnabled && this.config.rerankProvider === "cloud") {
      log.debug("rerankProvider=cloud is reserved/experimental in v2.2.0; skipping rerank");
    }

    return results.slice(0, options.recallResultLimit);
  }

  // ---------------------------------------------------------------------------
  // Access Tracking (Phase 1A)
  // ---------------------------------------------------------------------------

  /**
   * Record that memories were accessed (retrieved).
   * Updates are batched in memory and flushed during consolidation.
   */
  trackMemoryAccess(memoryIds: string[]): void {
    if (!this.config.accessTrackingEnabled) return;

    const now = new Date().toISOString();
    for (const id of memoryIds) {
      const existing = this.accessTrackingBuffer.get(id);
      this.accessTrackingBuffer.set(id, {
        count: (existing?.count ?? 0) + 1,
        lastAccessed: now,
      });
    }

    // Flush if buffer exceeds max size
    if (this.accessTrackingBuffer.size >= this.config.accessTrackingBufferMaxSize) {
      this.flushAccessTracking().catch((err) =>
        log.debug(`background access tracking flush failed: ${err}`),
      );
    }
  }

  /**
   * Flush access tracking buffer to disk.
   * Called during consolidation or when buffer is full.
   */
  async flushAccessTracking(): Promise<void> {
    if (this.accessTrackingBuffer.size === 0) return;

    // Build entries from buffer, merging with existing counts
    const entries: AccessTrackingEntry[] = [];
    const namespaces = this.config.namespacesEnabled
      ? Array.from(
          new Set<string>([
            this.config.defaultNamespace,
            this.config.sharedNamespace,
            ...this.config.namespacePolicies.map((p) => p.name),
          ]),
        )
      : [this.config.defaultNamespace];
    const memories = await this.readAllMemoriesForNamespaces(namespaces);
    const memoryMap = new Map(memories.map((m) => [m.frontmatter.id, m]));

    for (const [memoryId, update] of this.accessTrackingBuffer) {
      const memory = memoryMap.get(memoryId);
      const existingCount = memory?.frontmatter.accessCount ?? 0;
      entries.push({
        memoryId,
        newCount: existingCount + update.count,
        lastAccessed: update.lastAccessed,
      });
    }

    const byNamespace = new Map<string, AccessTrackingEntry[]>();
    for (const e of entries) {
      const m = memoryMap.get(e.memoryId);
      if (!m) continue;
      const ns = this.namespaceFromPath(m.path);
      const list = byNamespace.get(ns) ?? [];
      list.push(e);
      byNamespace.set(ns, list);
    }
    for (const [ns, list] of byNamespace) {
      const sm = await this.storageRouter.storageFor(ns);
      await sm.flushAccessTracking(list);
    }
    this.accessTrackingBuffer.clear();
    log.debug(`flushed ${entries.length} access tracking entries`);
  }

  /**
   * Apply recency, access count, and importance boosting to QMD search results.
   * Returns re-ranked results.
   */
  private async boostSearchResults(
    results: QmdSearchResult[],
    _recallNamespaces: string[],
    prompt?: string,
    preloadedMemoryMap?: Map<string, MemoryFile>,
    options?: {
      allowLifecycleFiltered?: boolean;
    },
  ): Promise<QmdSearchResult[]> {
    if (results.length === 0) return results;

    const now = Date.now();
    // Seed with any pre-loaded memories (e.g. from the recency fallback path)
    // to avoid redundant disk reads for files already in memory.
    const memoryByPath: Map<string, MemoryFile> = preloadedMemoryMap
      ? new Map(preloadedMemoryMap)
      : new Map();

    // Determine temporal/tag query params before I/O (pure computation).
    const resultPaths = new Set(results.map((r) => r.path).filter(Boolean) as string[]);
    let temporalFromDate: string | null = null;
    let promptTags: string[] = [];
    if (this.config.queryAwareIndexingEnabled && prompt) {
      if (isTemporalQuery(prompt)) {
        temporalFromDate = recencyWindowFromPrompt(prompt, now);
      }
      promptTags = extractTagsFromPrompt(prompt);
    }

    // Run all file I/O in parallel: memory files not yet preloaded + index files.
    const [, rawTemporal, rawTags] = await Promise.all([
      Promise.all(
        results.map(async (r) => {
          if (!r.path || memoryByPath.has(r.path)) return;
          const mem = await this.storage.readMemoryByPath(r.path);
          if (mem) memoryByPath.set(r.path, mem);
        }),
      ),
      temporalFromDate !== null
        ? queryByDateRangeAsync(this.config.memoryDir, temporalFromDate)
        : Promise.resolve<Set<string> | null>(null),
      promptTags.length > 0
        ? queryByTagsAsync(this.config.memoryDir, promptTags)
        : Promise.resolve<Set<string> | null>(null),
    ]);

    const queryIntent = this.config.intentRoutingEnabled && prompt
      ? inferIntentFromText(prompt)
      : null;

    // v8.1: Temporal + Tag prefilter candidate set
    // Scope to result paths first so cross-namespace paths don't consume the cap.
    let temporalCandidates: Set<string> | null = null;
    let tagCandidates: Set<string> | null = null;
    if (this.config.queryAwareIndexingEnabled && prompt) {
      const maxCandidates = this.config.queryAwareIndexingMaxCandidates;
      const capSet = (s: Set<string> | null): Set<string> | null => {
        if (!s) return null;
        // Intersect with result paths first so out-of-scope paths don't exhaust the budget
        const scoped = new Set(Array.from(s).filter((p) => resultPaths.has(p)));
        if (maxCandidates === 0 || scoped.size <= maxCandidates) return scoped.size > 0 ? scoped : null;
        return new Set(Array.from(scoped).slice(0, maxCandidates));
      };
      if (temporalFromDate !== null) {
        temporalCandidates = capSet(rawTemporal);
      }
      if (promptTags.length > 0) {
        tagCandidates = capSet(rawTags);
      }
    }

    let lifecycleFilteredCount = 0;
    const boosted: QmdSearchResult[] = [];
    const recencyWeight = this.effectiveRecencyWeight();
    for (const r of results) {
      const memory = memoryByPath.get(r.path);
      let score = r.score;

      if (memory) {
        if (
          options?.allowLifecycleFiltered !== true &&
          shouldFilterLifecycleRecallCandidate(memory.frontmatter, {
            lifecyclePolicyEnabled: this.config.lifecyclePolicyEnabled,
            lifecycleFilterStaleEnabled: this.config.lifecycleFilterStaleEnabled,
          })
        ) {
          lifecycleFilteredCount += 1;
          continue;
        }

        // Recency boost: exponential decay over 7 days
        if (recencyWeight > 0) {
          const createdAt = new Date(memory.frontmatter.created).getTime();
          const ageMs = now - createdAt;
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          const halfLifeDays = 7;
          const recencyScore = Math.pow(0.5, ageDays / halfLifeDays);
          score =
            score * (1 - recencyWeight) +
            recencyScore * recencyWeight;
        }

        // Access count boost: log scale, capped
        if (this.config.boostAccessCount && memory.frontmatter.accessCount) {
          const accessBoost = Math.log10(memory.frontmatter.accessCount + 1) / 3;
          score += applyUtilityRankingRuntimeDelta(
            Math.min(accessBoost, 0.1),
            this.utilityRuntimeValues,
            "boost",
          );
        }

        // Importance boost (Phase 1B): higher importance = higher rank
        if (memory.frontmatter.importance) {
          const importanceScore = memory.frontmatter.importance.score;
          // Boost important memories, slightly penalize trivial ones
          // Scale: trivial (-0.05) to critical (+0.15)
          const importanceBoost = (importanceScore - 0.4) * 0.25;
          score += applyUtilityRankingRuntimeDelta(
            importanceBoost,
            this.utilityRuntimeValues,
            importanceBoost >= 0 ? "boost" : "suppress",
          );
        }

        // Feedback bias (v2.2): apply small user-provided up/down vote adjustments.
        if (this.config.feedbackEnabled) {
          const match = memory.path.match(/([^/]+)\.md$/);
          const memoryId = match ? match[1] : null;
          if (memoryId) {
            const feedbackDelta = this.relevance.adjustment(memoryId);
            score += applyUtilityRankingRuntimeDelta(
              feedbackDelta,
              this.utilityRuntimeValues,
              feedbackDelta >= 0 ? "boost" : "suppress",
            );
          }
        }

        // Negative examples (v2.2): apply a small penalty for memories repeatedly marked "not useful".
        if (this.config.negativeExamplesEnabled) {
          const match = memory.path.match(/([^/]+)\.md$/);
          const memoryId = match ? match[1] : null;
          if (memoryId) {
            const negativePenalty = this.negatives.penalty(memoryId, {
              perHit: this.config.negativeExamplesPenaltyPerHit,
              cap: this.config.negativeExamplesPenaltyCap,
            });
            score -= applyUtilityRankingRuntimeDelta(
              negativePenalty,
              this.utilityRuntimeValues,
              "suppress",
            );
          }
        }

        if (
          queryIntent &&
          memory.frontmatter.intentGoal &&
          memory.frontmatter.intentActionType
        ) {
          const compatibility = intentCompatibilityScore(queryIntent, {
            goal: memory.frontmatter.intentGoal,
            actionType: memory.frontmatter.intentActionType,
            entityTypes: memory.frontmatter.intentEntityTypes ?? [],
          });
          score += applyUtilityRankingRuntimeDelta(
            compatibility * this.config.intentRoutingBoost,
            this.utilityRuntimeValues,
            "boost",
          );
        }

        // v8.1: Temporal + Tag index boost
        // Results that match the detected temporal window or tag query get a small additive boost.
        if (this.config.queryAwareIndexingEnabled && r.path) {
          if (temporalCandidates?.has(r.path)) {
            score += applyUtilityRankingRuntimeDelta(0.08, this.utilityRuntimeValues, "boost");
          }
          if (tagCandidates?.has(r.path)) {
            score += applyUtilityRankingRuntimeDelta(0.06, this.utilityRuntimeValues, "boost");
          }
        }

        // v8.3: lifecycle retrieval weighting (fail-open on legacy memories).
        const lifecycleDelta = lifecycleRecallScoreAdjustment(memory.frontmatter, {
          lifecyclePolicyEnabled: this.config.lifecyclePolicyEnabled,
        });
        score += applyUtilityRankingRuntimeDelta(
          lifecycleDelta,
          this.utilityRuntimeValues,
          lifecycleDelta >= 0 ? "boost" : "suppress",
        );
      }

      boosted.push({ ...r, score });
    }
    if (lifecycleFilteredCount > 0) {
      log.debug(`lifecycle retrieval filter removed ${lifecycleFilteredCount} stale/archived candidates`);
    }

    // Re-sort by boosted score
    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Extract memory IDs from QMD search results for access tracking.
   */
  private extractMemoryIdsFromResults(results: QmdSearchResult[]): string[] {
    // QMD results have paths like /path/to/fact-123.md
    // Extract the ID from the filename
    return results
      .map((r) => {
        const match = r.path.match(/([^/]+)\.md$/);
        return match ? match[1] : null;
      })
      .filter((id): id is string => id !== null);
  }

  // ---------------------------------------------------------------------------
  // Contradiction Detection (Phase 2B)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Feedback (v2.2)
  // ---------------------------------------------------------------------------

  async recordMemoryFeedback(memoryId: string, vote: "up" | "down", note?: string): Promise<void> {
    await this.relevance.record(memoryId, vote, note);
  }

  // Negative Examples (v2.2)
  async recordNotUsefulMemories(memoryIds: string[], note?: string): Promise<void> {
    await this.negatives.recordNotUseful(memoryIds, note);
  }

  getLastRecall(sessionKey: string): LastRecallSnapshot | null {
    return this.lastRecall.get(sessionKey);
  }

  /**
   * Check if a new memory contradicts an existing one.
   * Uses QMD to find similar memories, then LLM to verify contradiction.
   */
  private async checkForContradiction(
    content: string,
    category: string,
    namespaceScope: string,
  ): Promise<{ supersededId: string; confidence: number; reason: string; supersededPath: string; supersededCreated: string; supersededTags: string[] } | null> {
    if (!this.isSearchAvailableForNamespaceRouting()) return null;

    // Search for similar memories
    const results = await this.searchAcrossNamespaces({
      query: content,
      namespaces: [namespaceScope],
      maxResults: 5,
      mode: "search",
    });

    for (const result of results) {
      // Check similarity threshold
      if (result.score < this.config.contradictionSimilarityThreshold) {
        continue;
      }

      // Get the existing memory
      const memoryId = this.extractMemoryIdsFromResults([result])[0];
      if (!memoryId) continue;

      const resultNamespace = this.namespaceFromPath(result.path);
      if (resultNamespace !== namespaceScope) continue;
      const resultStorage = await this.storageRouter.storageFor(resultNamespace);
      const existingMemory = await resultStorage.getMemoryById(memoryId);
      if (!existingMemory) continue;

      // Skip already superseded memories
      if (existingMemory.frontmatter.status === "superseded") continue;

      // Verify contradiction with LLM
      const verification = await this.extraction.verifyContradiction(
        { content, category },
        {
          id: existingMemory.frontmatter.id,
          content: existingMemory.content,
          category: existingMemory.frontmatter.category,
          created: existingMemory.frontmatter.created,
        },
      );

      if (!verification) continue;

      // Check if it's a real contradiction with high confidence
      if (
        verification.isContradiction &&
        verification.confidence >= this.config.contradictionMinConfidence
      ) {
        // Auto-resolve if enabled
        if (this.config.contradictionAutoResolve) {
          // The new memory supersedes the old one (unless LLM said first is newer)
          if (verification.whichIsNewer !== "first") {
            await resultStorage.supersedeMemory(
              existingMemory.frontmatter.id,
              "pending-new", // Will be updated after the new memory is written
              verification.reasoning,
            );

            return {
              supersededId: existingMemory.frontmatter.id,
              confidence: verification.confidence,
              reason: verification.reasoning,
              supersededPath: existingMemory.path,
              supersededCreated: existingMemory.frontmatter.created,
              supersededTags: existingMemory.frontmatter.tags ?? [],
            };
          }
        }

        log.info(
          `detected contradiction (confidence: ${verification.confidence}): ${existingMemory.frontmatter.id} vs new memory`,
        );
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Memory Linking (Phase 3A)
  // ---------------------------------------------------------------------------

  /**
   * Suggest links for a new memory based on similar existing memories.
   */
  private async suggestLinksForMemory(
    content: string,
    category: string,
    namespaceScope: string,
  ): Promise<MemoryLink[]> {
    if (!this.isSearchAvailableForNamespaceRouting()) return [];

    // Search for related memories
    const results = await this.searchAcrossNamespaces({
      query: content,
      namespaces: [namespaceScope],
      maxResults: 5,
      mode: "search",
    });
    if (results.length === 0) return [];

    // Get full memory details for candidates
    const candidates: Array<{ id: string; content: string; category: string }> = [];
    for (const result of results) {
      const memoryId = this.extractMemoryIdsFromResults([result])[0];
      if (!memoryId) continue;

      const resultNamespace = this.namespaceFromPath(result.path);
      if (resultNamespace !== namespaceScope) continue;
      const resultStorage = await this.storageRouter.storageFor(resultNamespace);
      const memory = await resultStorage.getMemoryById(memoryId);
      if (memory && memory.frontmatter.status !== "superseded") {
        candidates.push({
          id: memory.frontmatter.id,
          content: memory.content,
          category: memory.frontmatter.category,
        });
      }
    }

    if (candidates.length === 0) return [];

    // Ask LLM for link suggestions
    const suggestions = await this.extraction.suggestLinks(
      { content, category },
      candidates,
    );

    if (!suggestions || suggestions.links.length === 0) return [];

    // Convert to MemoryLink format
    return suggestions.links.map((link) => ({
      targetId: link.targetId,
      linkType: link.linkType,
      strength: link.strength,
      reason: link.reason || undefined,
    }));
  }

  private namespaceFromPath(p: string): string {
    if (!this.config.namespacesEnabled) return this.config.defaultNamespace;
    const m = p.match(/[\\/]+namespaces[\\/]+([^\\/]+)(?:[\\/]|$)/);
    return m && m[1] ? m[1] : this.config.defaultNamespace;
  }

  private namespaceFromStorageDir(storageDir: string): string {
    if (!this.config.namespacesEnabled) return this.config.defaultNamespace;
    const resolvedStorageDir = path.resolve(storageDir);
    const resolvedMemoryDir = path.resolve(this.config.memoryDir);
    if (resolvedStorageDir === resolvedMemoryDir) return this.config.defaultNamespace;
    const m = resolvedStorageDir.match(/[\\/]namespaces[\\/]([^\\/]+)$/);
    return m && m[1] ? m[1] : this.config.defaultNamespace;
  }

  private async readAllMemoriesForNamespaces(namespaces: string[]): Promise<MemoryFile[]> {
    const uniq = Array.from(new Set(namespaces.filter(Boolean)));
    const lists = await Promise.all(
      uniq.map(async (ns) => {
        const sm = await this.storageRouter.storageFor(ns);
        return sm.readAllMemories();
      }),
    );
    return lists.flat();
  }

  private async readArchivedMemoriesForNamespaces(namespaces: string[]): Promise<MemoryFile[]> {
    const uniq = Array.from(new Set(namespaces.filter(Boolean)));
    const lists = await Promise.all(
      uniq.map(async (ns) => {
        const sm = await this.storageRouter.storageFor(ns);
        return sm.readArchivedMemories();
      }),
    );
    return lists.flat();
  }
}
