export type ReasoningEffort = "none" | "low" | "medium" | "high";
export type TriggerMode = "smart" | "every_n" | "time_based";
export type SignalLevel = "none" | "low" | "medium" | "high";
export type MemoryCategory = "fact" | "preference" | "correction" | "entity" | "decision" | "relationship" | "principle" | "commitment" | "moment" | "skill" | "rule" | "procedure" | "reasoning_trace";
export type ConsolidationAction = "ADD" | "MERGE" | "UPDATE" | "INVALIDATE" | "SKIP";
export type ConfidenceTier = "explicit" | "implied" | "inferred" | "speculative";
export type PrincipalFromSessionKeyMode = "map" | "prefix" | "regex";
export type RecallPlanMode = "no_recall" | "minimal" | "full" | "graph_mode";
export type CronRecallMode = "all" | "none" | "allowlist";
export type CronConversationRecallMode = "auto" | "always" | "never";
export type IdentityInjectionMode = "recovery_only" | "minimal" | "full";
export type CaptureMode = "implicit" | "explicit" | "hybrid";
export type MemoryOsPresetName = "conservative" | "balanced" | "research-max" | "local-llm-heavy";
export type ExtractionPassSource = "base" | "proactive";
export type SlotMismatchMode = "error" | "warn" | "silent";
export type CodexCompactionFlushMode = "signal" | "heuristic" | "auto";
export type DreamingNarrativePromptStyle = "reflective" | "diary" | "analytical";
export type HeartbeatDetectionMode = "runtime-signal" | "heuristic" | "auto";
export type ActiveRecallQueryMode = "message" | "recent" | "full";
export type ActiveRecallPromptStyle =
  | "balanced"
  | "strict"
  | "contextual"
  | "recall-heavy"
  | "precision-heavy"
  | "preference-only";
export type ActiveRecallThinking =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive";
export type ActiveRecallChatType = "direct" | "group" | "channel";
export type ActiveRecallModelFallbackPolicy = "default-remote" | "resolved-only";

/**
 * Retrieval tier ladder (issue #518).  Identifies which tier served a recall
 * result.  Ordered top-to-bottom by cost, but routing is not strictly
 * sequential — callers may jump straight to a lower tier when eligibility
 * does not hold.
 */
export type RetrievalTier =
  | "exact-cache"
  | "fuzzy-cache"
  | "direct-answer"
  | "hybrid"
  | "rerank-graph"
  | "agentic";

/**
 * Per-recall annotation describing which retrieval tier served a result,
 * why that tier was chosen, and what was filtered along the way.  Added as
 * part of issue #518 (direct-answer tier + `query --explain`).
 *
 * Not to be confused with the existing `recallExplain` operation
 * (graph-path explanation) — that is a user-invoked RPC; this is a
 * per-result annotation that can be attached to any recall response.
 */
export interface RecallTierExplain {
  tier: RetrievalTier;
  tierReason: string;
  filteredBy: string[];
  candidatesConsidered: number;
  latencyMs: number;
  sourceAnchors?: Array<{ path: string; lineRange?: [number, number] }>;
}

export interface RecallSectionConfig {
  id: string;
  enabled?: boolean;
  maxChars?: number | null;
  maxHints?: number;
  maxSupportingFacts?: number;
  maxRelatedEntities?: number;
  consolidateTriggerLines?: number;
  consolidateTargetLines?: number;
  maxEntities?: number;
  maxResults?: number;
  recentTurns?: number;
  maxTurns?: number;
  maxTokens?: number;
  lookbackHours?: number;
  maxCount?: number;
  topK?: number;
  timeoutMs?: number;
  maxPatterns?: number;
  maxRubrics?: number;
}

export interface RecallPipelineConfig {
  recallBudgetChars: number;
  pipeline: RecallSectionConfig[];
}

export interface SessionObserverBandConfig {
  maxBytes: number;
  triggerDeltaBytes: number;
  triggerDeltaTokens: number;
}

export interface FileHygieneConfig {
  enabled: boolean;
  // Lint (warn before truncation risk)
  lintEnabled: boolean;
  lintBudgetBytes: number;
  lintWarnRatio: number;
  lintPaths: string[];
  // Rotation/splitting
  rotateEnabled: boolean;
  rotateMaxBytes: number;
  rotateKeepTailChars: number;
  rotatePaths: string[];
  archiveDir: string;
  // Cadence
  runMinIntervalMs: number;
  // Optional warnings log (future-proofed)
  warningsLogEnabled: boolean;
  warningsLogPath: string;
  // Optional index file (future-proofed)
  indexEnabled: boolean;
  indexPath: string;
}

export interface NativeKnowledgeConfig {
  enabled: boolean;
  includeFiles: string[];
  maxChunkChars: number;
  maxResults: number;
  maxChars: number;
  stateDir: string;
  obsidianVaults: NativeKnowledgeObsidianVaultConfig[];
  openclawWorkspace?: NativeKnowledgeOpenClawWorkspaceConfig;
}

export interface NativeKnowledgeFolderRuleConfig {
  pathPrefix: string;
  namespace?: string;
  privacyClass?: string;
}

export interface NativeKnowledgeObsidianVaultConfig {
  id: string;
  rootDir: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  namespace?: string;
  privacyClass?: string;
  folderRules: NativeKnowledgeFolderRuleConfig[];
  dailyNotePatterns: string[];
  materializeBacklinks: boolean;
}

export interface NativeKnowledgeOpenClawWorkspaceConfig {
  enabled: boolean;
  bootstrapFiles: string[];
  handoffGlobs: string[];
  dailySummaryGlobs: string[];
  automationNoteGlobs: string[];
  workspaceDocGlobs: string[];
  excludeGlobs: string[];
  sharedSafeGlobs: string[];
}

export interface AgentAccessHttpConfig {
  enabled: boolean;
  host: string;
  port: number;
  authToken?: string;
  principal?: string;
  maxBodyBytes: number;
}

export interface DreamingConfig {
  enabled: boolean;
  journalPath: string;
  maxEntries: number;
  injectRecentCount: number;
  minIntervalMinutes: number;
  narrativeModel: string | null;
  narrativePromptStyle: DreamingNarrativePromptStyle;
  watchFile: boolean;
}

/** Procedural memory (issue #519): mining + recall gates. All sub-features default off. */
export interface ProceduralConfig {
  enabled: boolean;
  /** Minimum cluster size before emitting a candidate; `0` disables mining (`minOccurrences_zero`). */
  minOccurrences: number;
  /** Minimum success rate from trajectory outcomes in [0, 1]. */
  successFloor: number;
  /** When auto-promotion is enabled, promote pending_review → active after this many occurrences. */
  autoPromoteOccurrences: number;
  autoPromoteEnabled: boolean;
  lookbackDays: number;
  /** When true, installer may register the nightly procedural mining cron (default off). */
  proceduralMiningCronAutoRegister: boolean;
  /** Max procedure memories to inject on task-initiation recall (1–10). */
  recallMaxProcedures: number;
}

/**
 * Coding-agent mode config (issue #569).
 *
 * When the connector provides a `CodingContext` (see below), Remnic overlays
 * a project- and/or branch-scoped namespace on top of the principal's default
 * namespace so that memories written while working on project A do not surface
 * while working on project B.
 *
 * Both flags default off-for-branch / on-for-project. Per CLAUDE.md #30 every
 * filter or transform needs an escape hatch: set `projectScope: false` to
 * exactly restore pre-#569 behaviour.
 */
export interface CodingModeConfig {
  /**
   * When true (default), a session with a resolved `CodingContext` uses a
   * project-scoped namespace. When false, the principal's default namespace
   * is used unchanged (pre-#569 behaviour).
   */
  projectScope: boolean;
  /**
   * When true, recall/write also overlay the current branch on top of the
   * project namespace. Default false — branch-scope is opt-in because active
   * development typically wants recall across branches. (Wired by PR 3 of
   * issue #569; declared here so the schema ships in one slice.)
   */
  branchScope: boolean;
}

/**
 * Session-scoped coding context. Produced by `resolveGitContext()` in the
 * connector layer and attached to a session so that recall + write paths can
 * compute an overlay namespace.
 *
 * All fields mirror `GitContext` from `./coding/git-context.ts`; kept as a
 * separate interface because `types.ts` must stay dependency-free (it is
 * imported by every other module).
 */
export interface CodingContext {
  projectId: string;
  branch: string | null;
  rootPath: string;
  defaultBranch: string | null;
}

/** Configuration for the nightly contradiction-scan cron (issue #520). */
export interface ContradictionScanConfig {
  /** Master switch for the contradiction scan cron. Default true. */
  enabled: boolean;
  /** Embedding cosine similarity floor for candidate pair generation. Default 0.82. */
  similarityFloor: number;
  /** Minimum topic-token Jaccard overlap for unstructured pairs. Default 0.4. */
  topicOverlapFloor: number;
  /** Cap on candidate pairs evaluated per cron run. Default 500. */
  maxPairsPerRun: number;
  /** Cooldown in days before re-evaluating a pair judged independent/both-valid. Default 14. */
  cooldownDays: number;
  /** When true, pairs judged "duplicates" are auto-flagged for dedup (still need user approval). Default false. */
  autoMergeDuplicates: boolean;
}

export interface HeartbeatConfig {
  enabled: boolean;
  journalPath: string;
  maxPreviousRuns: number;
  watchFile: boolean;
  detectionMode: HeartbeatDetectionMode;
  gateExtractionDuringHeartbeat: boolean;
}

export interface SlotBehaviorConfig {
  requireExclusiveMemorySlot: boolean;
  onSlotMismatch: SlotMismatchMode;
}

export interface CodexCompatConfig {
  enabled: boolean;
  threadIdBufferKeying: boolean;
  compactionFlushMode: CodexCompactionFlushMode;
  fingerprintDedup: boolean;
}

export function confidenceTier(score: number): ConfidenceTier {
  if (score >= 0.95) return "explicit";
  if (score >= 0.70) return "implied";
  if (score >= 0.40) return "inferred";
  return "speculative";
}

/** Default TTL in days for speculative memories (auto-expire if unconfirmed) */
export const SPECULATIVE_TTL_DAYS = 30;

/**
 * Shape for semantic chunking config overrides stored in PluginConfig.
 * Mirrors SemanticChunkingConfig from semantic-chunking.ts without creating
 * a circular import (types.ts is imported by everything).
 */
export interface SemanticChunkingConfigShape {
  targetTokens: number;
  minTokens: number;
  maxTokens: number;
  smoothingWindowSize: number;
  boundaryThresholdStdDevs: number;
  embeddingBatchSize: number;
  fallbackToRecursive: boolean;
}

export interface PluginConfig {
  openaiApiKey: string | undefined;
  openaiBaseUrl: string | undefined;
  model: string;
  reasoningEffort: ReasoningEffort;
  triggerMode: TriggerMode;
  bufferMaxTurns: number;
  bufferMaxMinutes: number;
  /**
   * Surprise-gated buffer flush (issue #563, D-MEM).
   *
   * When enabled, every turn added to the smart buffer is scored against a
   * configurable window of recent memories using an embedding-distance proxy
   * for novelty (see `buffer-surprise.ts`). A turn whose surprise score
   * exceeds `bufferSurpriseThreshold` triggers an immediate extract flush,
   * even if the existing signal/turn-count/time triggers would otherwise keep
   * buffering. Disabled by default — when `false`, buffer behavior is
   * identical to pre-#563 code. Additive only: existing triggers are never
   * suppressed by this flag.
   */
  bufferSurpriseTriggerEnabled: boolean;
  /**
   * Threshold in `[0, 1]` above which a surprise score causes an immediate
   * flush. `0.35` is a conservative default chosen to favor precision over
   * recall during the opt-in phase. Ignored unless
   * `bufferSurpriseTriggerEnabled` is `true`.
   */
  bufferSurpriseThreshold: number;
  /**
   * Number of nearest neighbors to average over when computing the surprise
   * score (see `computeSurprise`). Default `5`. Clamped to the recent-memory
   * window size at call time.
   */
  bufferSurpriseK: number;
  /**
   * Maximum number of recent memories to sample when computing the surprise
   * score. Bounds embedding cost per turn. Default `20`. Set to `0` to
   * disable the trigger even when the flag is on (no memories to compare
   * against → treat as not-applicable rather than maximally surprising).
   */
  bufferSurpriseRecentMemoryCount: number;
  /**
   * Hard timeout (ms) for the surprise probe. If the probe does not
   * resolve within this window, the buffer treats the probe as failed,
   * logs at debug, and falls through to the existing triggers. Ensures
   * a slow or hung embedder cannot stall the turn-append path. Default
   * `2000` (2s).
   */
  bufferSurpriseProbeTimeoutMs: number;
  consolidateEveryN: number;
  highSignalPatterns: string[];
  maxMemoryTokens: number;
  memoryOsPreset?: MemoryOsPresetName;
  qmdEnabled: boolean;
  qmdCollection: string;
  qmdMaxResults: number;
  qmdColdTierEnabled?: boolean;
  qmdColdCollection?: string;
  qmdColdMaxResults?: number;
  qmdTierMigrationEnabled: boolean;
  qmdTierDemotionMinAgeDays: number;
  qmdTierDemotionValueThreshold: number;
  qmdTierPromotionValueThreshold: number;
  qmdTierParityGraphEnabled: boolean;
  qmdTierParityHiMemEnabled: boolean;
  qmdTierAutoBackfillEnabled: boolean;
  embeddingFallbackEnabled: boolean;
  embeddingFallbackProvider: "auto" | "openai" | "local";
  /** Optional absolute path to qmd binary. If unset, PATH/fallback discovery is used. */
  qmdPath?: string;
  memoryDir: string;
  debug: boolean;
  identityEnabled: boolean;
  identityContinuityEnabled: boolean;
  identityInjectionMode: IdentityInjectionMode;
  identityMaxInjectChars: number;
  continuityIncidentLoggingEnabled: boolean;
  continuityAuditEnabled: boolean;
  sessionObserverEnabled?: boolean;
  sessionObserverDebounceMs?: number;
  sessionObserverBands?: SessionObserverBandConfig[];
  injectQuestions: boolean;
  commitmentDecayDays: number;
  workspaceDir: string;
  captureMode: CaptureMode;
  fileHygiene?: FileHygieneConfig;
  nativeKnowledge?: NativeKnowledgeConfig;
  agentAccessHttp: AgentAccessHttpConfig;
  // Access tracking (Phase 1A)
  accessTrackingEnabled: boolean;
  accessTrackingBufferMaxSize: number;
  // Retrieval options
  recencyWeight: number;
  boostAccessCount: boolean;
  /** Record empty recall impressions (memoryIds: []) when no memories are injected. Disabled by default. */
  recordEmptyRecallImpressions: boolean;
  // v2.2 Advanced Retrieval
  queryExpansionEnabled: boolean;
  queryExpansionMaxQueries: number;
  /** Minimum token length to consider for query expansion. */
  queryExpansionMinTokenLen: number;
  rerankEnabled: boolean;
  /** Rerank provider. "local" uses Local LLM only; "cloud" uses gateway fallback chain. */
  rerankProvider: "local" | "cloud";
  rerankMaxCandidates: number;
  rerankTimeoutMs: number;
  rerankCacheEnabled: boolean;
  rerankCacheTtlMs: number;
  feedbackEnabled: boolean;
  // v2.2 Negative Examples (safe defaults: off unless enabled)
  /** If true, allow recording negative examples and apply a soft penalty during ranking. */
  negativeExamplesEnabled: boolean;
  /** Score penalty per "not useful" hit (typical QMD scores ~0-1). Keep small. */
  negativeExamplesPenaltyPerHit: number;
  /** Maximum penalty applied from negative examples. */
  negativeExamplesPenaltyCap: number;
  // Chunking (Phase 2A)
  chunkingEnabled: boolean;
  chunkingTargetTokens: number;
  chunkingMinTokens: number;
  chunkingOverlapSentences: number;
  // Semantic Chunking (Issue #368)
  /** Enable semantic chunking with embedding-based topic boundary detection. Default: false. */
  semanticChunkingEnabled: boolean;
  /** Optional overrides for the semantic chunking algorithm. */
  semanticChunkingConfig: Partial<SemanticChunkingConfigShape>;
  // Contradiction Detection (Phase 2B)
  contradictionDetectionEnabled: boolean;
  contradictionSimilarityThreshold: number;
  contradictionMinConfidence: number;
  contradictionAutoResolve: boolean;
  /** Nightly contradiction-scan cron config (issue #520). */
  contradictionScan: ContradictionScanConfig;
  // Temporal Supersession (issue #375)
  /**
   * When enabled, writes that carry `structuredAttributes` mark any older
   * fact with the same `entityRef + attribute_name` supersession key and a
   * conflicting value as `status: "superseded"`.
   */
  temporalSupersessionEnabled: boolean;
  /**
   * When enabled, superseded memories are still returned by recall (useful
   * for audit/history queries).  Default: false — superseded memories are
   * filtered out.
   */
  temporalSupersessionIncludeInRecall: boolean;
  // Direct-answer retrieval tier (issue #518)
  /**
   * When true, recall checks whether a single validated memory in a
   * high-trust taxonomy bucket can answer the query before invoking QMD.
   * Default false — enable explicitly after bench validation.
   */
  recallDirectAnswerEnabled: boolean;
  /**
   * Graph-based retrieval tier via Personalized PageRank (issue #559 PR 4).
   * When true, recall builds a retrieval graph from memory frontmatter
   * and runs PPR, merging the result with QMD via MMR.  Default false —
   * ships off pending the retrieval-graph bench in PR 5.
   */
  recallGraphEnabled: boolean;
  /** PPR damping factor used when `recallGraphEnabled` is true. */
  recallGraphDamping: number;
  /** PPR power-iteration cap used when `recallGraphEnabled` is true. */
  recallGraphIterations: number;
  /**
   * Max memories returned by the graph tier before MMR.  Set to 0 to
   * disable the graph tier's contribution without flipping the flag.
   */
  recallGraphTopK: number;
  /**
   * Minimum token-overlap ratio (query tokens ∩ memory tokens / query tokens)
   * required for direct-answer eligibility.  Set to 0 to disable the gate.
   */
  recallDirectAnswerTokenOverlapFloor: number;
  /**
   * Minimum calibrated importance score required for direct-answer
   * eligibility.  Set to 0 to disable the gate.
   */
  recallDirectAnswerImportanceFloor: number;
  /**
   * Ambiguity margin: if the second-best candidate scores within this
   * ratio of the top candidate, direct-answer defers to the hybrid tier.
   */
  recallDirectAnswerAmbiguityMargin: number;
  /**
   * Taxonomy category IDs eligible for direct-answer routing.  Memories
   * whose resolved taxonomy category is not in this list never qualify.
   */
  recallDirectAnswerEligibleTaxonomyBuckets: string[];
  // Memory Worth recall filter (issue #560 PR 4)
  /**
   * When true, recall multiplies candidate scores by the Memory Worth
   * factor computed from `mw_success` / `mw_fail` counters on each
   * memory's frontmatter (see `computeMemoryWorth`). Memories with a
   * history of failed sessions sink; neutral / uninstrumented memories
   * are untouched (multiplier 1.0). Default false — flip to true in PR 5
   * once the benchmark shows precision tie-or-win.
   */
  recallMemoryWorthFilterEnabled: boolean;
  /**
   * Optional half-life for Memory Worth decay, in milliseconds. When
   * positive, older outcome observations are exponentially decayed toward
   * the uniform prior. Set to 0 (default) to disable decay and use raw
   * counter values.
   */
  recallMemoryWorthHalfLifeMs: number;
  // Memory Linking (Phase 3A)
  memoryLinkingEnabled: boolean;
  // Conversation Threading (Phase 3B)
  threadingEnabled: boolean;
  threadingGapMinutes: number;
  // Memory Summarization (Phase 4A)
  summarizationEnabled: boolean;
  summarizationTriggerCount: number;
  summarizationRecentToKeep: number;
  summarizationImportanceThreshold: number;
  summarizationProtectedTags: string[];
  // Topic Extraction (Phase 4B)
  topicExtractionEnabled: boolean;
  topicExtractionTopN: number;
  // Transcript & Context Preservation (v2.0)
  // Transcript archive
  transcriptEnabled: boolean;
  transcriptRetentionDays: number;
  /** Channel types to skip from transcript logging (e.g., ["cron"]) */
  transcriptSkipChannelTypes: string[];
  // Transcript injection
  transcriptRecallHours: number;
  maxTranscriptTurns: number;
  maxTranscriptTokens: number;
  // Checkpoint
  checkpointEnabled: boolean;
  checkpointTurns: number;
  // Compaction reset: trigger session reset after compaction instead of continuing degraded.
  // Requires OC fork with PR #29985 (api.resetSession).
  compactionResetEnabled: boolean;
  beforeResetTimeoutMs: number;
  flushOnResetEnabled: boolean;
  commandsListEnabled: boolean;
  openclawToolsEnabled: boolean;
  openclawToolSnippetMaxChars: number;
  sessionTogglesEnabled: boolean;
  verboseRecallVisibility: boolean;
  recallTranscriptsEnabled: boolean;
  recallTranscriptRetentionDays: number;
  respectBundledActiveMemoryToggle: boolean;
  activeRecallEnabled: boolean;
  activeRecallAgents: string[] | null;
  activeRecallAllowedChatTypes: ActiveRecallChatType[];
  activeRecallQueryMode: ActiveRecallQueryMode;
  activeRecallPromptStyle: ActiveRecallPromptStyle;
  activeRecallPromptOverride: string | null;
  activeRecallPromptAppend: string | null;
  activeRecallMaxSummaryChars: number;
  activeRecallRecentUserTurns: number;
  activeRecallRecentAssistantTurns: number;
  activeRecallRecentUserChars: number;
  activeRecallRecentAssistantChars: number;
  activeRecallThinking: ActiveRecallThinking;
  activeRecallTimeoutMs: number;
  activeRecallCacheTtlMs: number;
  activeRecallModel: string | null;
  activeRecallModelFallbackPolicy: ActiveRecallModelFallbackPolicy;
  activeRecallPersistTranscripts: boolean;
  activeRecallTranscriptDir: string;
  activeRecallEntityGraphDepth: number;
  activeRecallIncludeCausalTrajectories: boolean;
  activeRecallIncludeDaySummary: boolean;
  activeRecallAttachRecallExplain: boolean;
  activeRecallAllowChainedActiveMemory: boolean;
  dreaming: DreamingConfig;
  procedural: ProceduralConfig;
  // Coding-agent project/branch scoping (issue #569)
  codingMode: CodingModeConfig;
  heartbeat: HeartbeatConfig;
  slotBehavior: SlotBehaviorConfig;
  codexCompat: CodexCompatConfig;
  // Extraction judge (issue #376)
  /** Enable the LLM-as-judge fact-worthiness gate on extracted facts. Default false (opt-in). */
  extractionJudgeEnabled: boolean;
  /** Model override for the judge LLM. Empty string means use the local model. */
  extractionJudgeModel: string;
  /** Maximum number of candidate facts per judge LLM batch call. */
  extractionJudgeBatchSize: number;
  /** Shadow mode: log judge verdicts but do not filter facts. Default false. */
  extractionJudgeShadow: boolean;
  /**
   * Maximum number of times the same candidate text may be deferred before
   * the judge forcibly converts the verdict to `"reject"`. Prevents
   * pathological LLM responses from looping forever on ambiguous facts.
   * Defaults to 2 (issue #562, PR 2).
   */
  extractionJudgeMaxDeferrals: number;
  /**
   * Emit structured telemetry rows to
   * `state/observation-ledger/extraction-judge-verdicts.jsonl` on every
   * judge verdict. Off by default; enable to collect defer-rate / latency
   * metrics for operator dashboards (issue #562, PR 3).
   */
  extractionJudgeTelemetryEnabled: boolean;
  /**
   * Collect `(candidate_text, verdict_kind, reason)` tuples into
   * `~/.remnic/judge-training/<date>.jsonl` for use by a future GRPO
   * training pipeline (issue #562, PR 4). Off by default. Rows live in
   * the user's home directory rather than the shared memory directory so
   * they are not committed, sync'd, or bundled into memory exports.
   */
  collectJudgeTrainingPairs: boolean;
  /**
   * Override directory for judge training-pair collection. Empty string
   * means use the default (`~/.remnic/judge-training`). Primarily for
   * tests and for operators who want the output to land in a specific
   * location.
   */
  judgeTrainingDir: string;
  // Hourly summaries
  hourlySummariesEnabled: boolean;
  daySummaryEnabled: boolean;
  /** If true, Engram may attempt to auto-register an hourly summary cron job (default off). */
  hourlySummaryCronAutoRegister: boolean;
  /** If true, Engram may attempt to auto-register the nightly governance cron job (default off). */
  nightlyGovernanceCronAutoRegister: boolean;
  summaryRecallHours: number;
  maxSummaryCount: number;
  summaryModel: string;
  // v2.4 Extended hourly summaries
  hourlySummariesExtendedEnabled: boolean;
  hourlySummariesIncludeToolStats: boolean;
  hourlySummariesIncludeSystemMessages: boolean;
  hourlySummariesMaxTurnsPerRun: number;
  // v2.4 Conversation index (optional)
  conversationIndexEnabled: boolean;
  conversationIndexBackend: "qmd" | "faiss";
  conversationIndexQmdCollection: string;
  conversationIndexRetentionDays: number;
  conversationIndexMinUpdateIntervalMs: number;
  conversationIndexEmbedOnUpdate: boolean;
  conversationIndexFaissScriptPath?: string;
  conversationIndexFaissPythonBin?: string;
  conversationIndexFaissModelId: string;
  conversationIndexFaissIndexDir: string;
  conversationIndexFaissUpsertTimeoutMs: number;
  conversationIndexFaissSearchTimeoutMs: number;
  conversationIndexFaissHealthTimeoutMs: number;
  conversationIndexFaissMaxBatchSize: number;
  conversationIndexFaissMaxSearchK: number;
  conversationRecallTopK: number;
  conversationRecallMaxChars: number;
  conversationRecallTimeoutMs: number;
  // Evaluation harness foundation
  evalHarnessEnabled: boolean;
  evalShadowModeEnabled: boolean;
  benchmarkBaselineSnapshotsEnabled: boolean;
  benchmarkDeltaReporterEnabled: boolean;
  benchmarkStoredBaselineEnabled: boolean;
  evalStoreDir: string;
  // Objective-state memory foundation
  objectiveStateMemoryEnabled: boolean;
  objectiveStateSnapshotWritesEnabled: boolean;
  objectiveStateRecallEnabled: boolean;
  objectiveStateStoreDir: string;
  // Causal trajectory memory foundation
  causalTrajectoryMemoryEnabled: boolean;
  causalTrajectoryStoreDir: string;
  causalTrajectoryRecallEnabled: boolean;
  actionGraphRecallEnabled: boolean;
  // Trust-zone memory foundation
  trustZonesEnabled: boolean;
  quarantinePromotionEnabled: boolean;
  trustZoneStoreDir: string;
  trustZoneRecallEnabled: boolean;
  memoryPoisoningDefenseEnabled: boolean;
  memoryRedTeamBenchEnabled: boolean;
  // Harmonic retrieval foundation
  harmonicRetrievalEnabled: boolean;
  abstractionAnchorsEnabled: boolean;
  abstractionNodeStoreDir: string;
  // Episodic/semantic split foundation
  verifiedRecallEnabled: boolean;
  semanticRulePromotionEnabled: boolean;
  semanticRuleVerificationEnabled: boolean;
  semanticConsolidationEnabled: boolean;
  semanticConsolidationModel: string;
  semanticConsolidationThreshold: number;
  semanticConsolidationMinClusterSize: number;
  semanticConsolidationExcludeCategories: string[];
  semanticConsolidationIntervalHours: number;
  semanticConsolidationMaxPerRun: number;
  // Creation-memory foundation
  creationMemoryEnabled: boolean;
  memoryUtilityLearningEnabled: boolean;
  promotionByOutcomeEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  commitmentLifecycleEnabled: boolean;
  commitmentStaleDays: number;
  commitmentLedgerDir: string;
  resumeBundlesEnabled: boolean;
  resumeBundleDir: string;
  workProductRecallEnabled: boolean;
  workProductLedgerDir: string;
  workTasksEnabled: boolean;
  workProjectsEnabled: boolean;
  workTasksDir: string;
  workProjectsDir: string;
  workIndexEnabled: boolean;
  workIndexDir: string;
  workTaskIndexEnabled: boolean;
  workProjectIndexEnabled: boolean;
  workIndexAutoRebuildEnabled: boolean;
  workIndexAutoRebuildDebounceMs: number;
  // Local LLM Provider (v2.1)
  localLlmEnabled: boolean;
  localLlmUrl: string;
  localLlmModel: string;
  /** Optional API key for authenticated OpenAI-compatible endpoints. */
  localLlmApiKey?: string;
  /** Additional headers for local/compatible endpoint requests. */
  localLlmHeaders?: Record<string, string>;
  /** If false, do not send Authorization header even when localLlmApiKey is set. */
  localLlmAuthHeader: boolean;
  localLlmFallback: boolean;
  /** Optional home directory override for local LLM helpers (LM Studio settings, CLI PATH). */
  localLlmHomeDir?: string;
  /** Optional absolute path to LMS CLI binary (preferred over auto-detection). */
  localLmsCliPath?: string;
  /** Optional bin directory prepended to PATH for LMS CLI execution. */
  localLmsBinDir?: string;
  /** Hard timeout for local LLM requests (ms). */
  localLlmTimeoutMs: number;
  /** Max context window for local LLM (override auto-detection). Set lower if your LLM server defaults to smaller contexts. */
  localLlmMaxContext?: number;
  // Observability
  /** If true, log slow operations (local LLM + related I/O) with durations and metadata (no content). */
  slowLogEnabled: boolean;
  /**
   * If true, include the full recalled memory text in `RecallTraceEvent.recalledContent`.
   * Disabled by default — enable only when you want external trace subscribers (e.g. Langfuse)
   * to see the exact memory context injected into each conversation turn.
   * This adds payload to trace events but does not log to files or the gateway log.
   */
  traceRecallContent: boolean;
  /** Threshold for slow operation logging (ms). */
  slowLogThresholdMs: number;
  // Performance profiling (opt-in)
  /** If true, collect and persist timing traces for recall and extraction pipelines. */
  profilingEnabled: boolean;
  /** Directory for profiling trace JSONL files. Defaults to <memoryDir>/profiling. */
  profilingStorageDir: string;
  /** Maximum number of trace files to keep (rolling window). */
  profilingMaxTraces: number;
  // Extraction stability guards (P0/P1)
  extractionDedupeEnabled: boolean;
  extractionDedupeWindowMs: number;
  extractionMinChars: number;
  extractionMinUserTurns: number;
  extractionMaxTurnChars: number;
  extractionMaxFactsPerRun: number;
  extractionMaxEntitiesPerRun: number;
  extractionMaxQuestionsPerRun: number;
  extractionMaxProfileUpdatesPerRun: number;
  /**
   * Minimum importance level required to persist an extracted fact. Facts
   * whose locally-scored level falls below this threshold are dropped before
   * write and counted toward the `importance_gated` metric. Defaults to
   * "low" so trivial content (greetings, single-word replies, filler) is
   * silently dropped while everything else still passes.
   */
  extractionMinImportanceLevel: ImportanceLevel;
  /**
   * Inline source attribution (issue #369).
   * When enabled, extracted facts carry a compact provenance tag (agent,
   * session, timestamp) inlined into the fact text — not just in YAML
   * frontmatter — so the citation survives prompt injection, copy/paste,
   * and LLM quoting. Off by default to preserve backwards compatibility
   * with existing downstream consumers that expect raw fact text.
   */
  inlineSourceAttributionEnabled: boolean;
  /**
   * Template used when injecting inline citations. Supported placeholders:
   * `{agent}`, `{session}`, `{sessionId}`, `{ts}`, `{date}`. Defaults to
   * `[Source: agent={agent}, session={sessionId}, ts={ts}]`.
   */
  inlineSourceAttributionFormat: string;
  consolidationRequireNonZeroExtraction: boolean;
  consolidationMinIntervalMs: number;
  // QMD maintenance (debounced singleflight)
  qmdMaintenanceEnabled: boolean;
  qmdMaintenanceDebounceMs: number;
  qmdAutoEmbedEnabled: boolean;
  qmdEmbedMinIntervalMs: number;
  qmdUpdateTimeoutMs: number;
  qmdUpdateMinIntervalMs: number;
  // Local LLM resilience
  localLlmRetry5xxCount: number;
  localLlmRetryBackoffMs: number;
  localLlm400TripThreshold: number;
  localLlm400CooldownMs: number;
  // Local LLM fast tier (v9.1) — smaller model for quick ops
  localLlmFastEnabled: boolean;
  localLlmFastModel: string;
  localLlmFastUrl: string;
  localLlmFastTimeoutMs: number;
  /**
   * Suppress chain-of-thought / thinking mode on the main local LLM
   * (issue #548).  When true, Remnic injects
   * `chat_template_kwargs: { enable_thinking: false }` on every
   * request so thinking-capable models (Qwen 3.5, Gemma 4, DeepSeek,
   * etc.) skip reasoning tokens that structured-output tasks like
   * extraction and consolidation cannot benefit from.  Default: true
   * — the dominant localLlm use case is JSON-shaped extraction where
   * thinking is pure latency tax and a common cause of 60s timeouts.
   * Set to false to restore thinking for narrative tasks.
   *
   * The fast-tier client (`fastLlm`) always disables thinking; that
   * contract is baked into "fast tier" and is unaffected by this flag.
   */
  localLlmDisableThinking: boolean;
  // Gateway config for fallback AI
  gatewayConfig?: GatewayConfig;
  // Gateway model source (v9.2) — route LLM calls through gateway agent model chain
  modelSource: "plugin" | "gateway";
  gatewayAgentId: string;
  fastGatewayAgentId: string;

  // v3.0 Multi-agent memory (namespaces)
  namespacesEnabled: boolean;
  defaultNamespace: string;
  sharedNamespace: string;
  principalFromSessionKeyMode: PrincipalFromSessionKeyMode;
  principalFromSessionKeyRules: PrincipalRule[];
  namespacePolicies: NamespacePolicy[];
  defaultRecallNamespaces: Array<"self" | "shared">;
  cronRecallMode: CronRecallMode;
  cronRecallAllowlist: string[];
  cronRecallPolicyEnabled: boolean;
  cronRecallNormalizedQueryMaxChars: number;
  cronRecallInstructionHeavyTokenCap: number;
  cronConversationRecallMode: CronConversationRecallMode;
  autoPromoteToSharedEnabled: boolean;
  autoPromoteToSharedCategories: Array<"fact" | "correction" | "decision" | "preference">;
  autoPromoteMinConfidenceTier: ConfidenceTier;
  routingRulesEnabled: boolean;
  routingRulesStateFile: string;

  // v4.0 Shared-context (cross-agent shared intelligence)
  sharedContextEnabled: boolean;
  sharedContextDir?: string;
  sharedContextMaxInjectChars: number;
  crossSignalsSemanticEnabled: boolean;
  crossSignalsSemanticTimeoutMs: number;
  sharedCrossSignalSemanticEnabled?: boolean;
  sharedCrossSignalSemanticTimeoutMs?: number;
  sharedCrossSignalSemanticMaxCandidates?: number;

  // v5.0 Compounding engine
  compoundingEnabled: boolean;
  compoundingWeeklyCronEnabled: boolean;
  compoundingSemanticEnabled: boolean;
  compoundingSynthesisTimeoutMs: number;
  compoundingInjectEnabled: boolean;

  // IRC (Inductive Rule Consolidation) — preference synthesis
  ircEnabled: boolean;
  ircMaxPreferences: number;
  ircIncludeCorrections: boolean;
  ircMinConfidence: number;

  // CMC (Causal Memory Consolidation) — cross-session causal reasoning
  cmcEnabled: boolean;
  cmcStitchLookbackDays: number;
  cmcStitchMinScore: number;
  cmcStitchMaxEdgesPerTrajectory: number;
  cmcConsolidationEnabled: boolean;
  cmcConsolidationMinRecurrence: number;
  cmcConsolidationMinSessions: number;
  cmcConsolidationSuccessThreshold: number;
  cmcRetrievalEnabled: boolean;
  cmcRetrievalMaxDepth: number;
  cmcRetrievalMaxChars: number;
  cmcRetrievalCounterfactualBoost: number;
  cmcBehaviorLearningEnabled: boolean;
  cmcBehaviorMinFrequency: number;
  cmcBehaviorMinSessions: number;
  cmcBehaviorConfidenceThreshold: number;
  cmcLifecycleCausalImpactWeight: number;

  // PEDC (Prediction-Error-Driven Calibration) — model-user alignment
  calibrationEnabled: boolean;
  calibrationMaxRulesPerRecall: number;
  calibrationMaxChars: number;

  // Search backend abstraction
  searchBackend?: "qmd" | "remote" | "noop" | "lancedb" | "meilisearch" | "orama";
  remoteSearchBaseUrl?: string;
  remoteSearchApiKey?: string;
  remoteSearchTimeoutMs?: number;

  // LanceDB backend
  lancedbEnabled: boolean;
  lanceDbPath?: string;
  lanceEmbeddingDimension?: number;

  // Meilisearch backend
  meilisearchEnabled: boolean;
  meilisearchHost?: string;
  meilisearchApiKey?: string;
  meilisearchTimeoutMs?: number;
  meilisearchAutoIndex?: boolean;

  // Orama backend
  oramaEnabled: boolean;
  oramaDbPath?: string;
  oramaEmbeddingDimension?: number;

  // QMD daemon mode
  qmdDaemonEnabled: boolean;
  qmdDaemonUrl: string;
  qmdDaemonRecheckIntervalMs: number;
  qmdIntentHintsEnabled: boolean;
  qmdExplainEnabled: boolean;

  // v7.0 Knowledge Graph Enhancement
  knowledgeIndexEnabled: boolean;
  knowledgeIndexMaxEntities: number;
  knowledgeIndexMaxChars: number;
  entityRetrievalEnabled: boolean;
  entityRetrievalMaxChars: number;
  entityRetrievalMaxHints: number;
  entityRetrievalMaxSupportingFacts: number;
  entityRetrievalMaxRelatedEntities: number;
  entityRetrievalRecentTurns: number;
  entitySchemas?: Record<string, EntitySchemaDefinition>;
  // Recall assembly controls
  recallBudgetChars: number;
  recallOuterTimeoutMs: number;
  recallCoreDeadlineMs: number;
  recallEnrichmentDeadlineMs: number;
  recallPipeline: RecallSectionConfig[];
  /** Apply Maximal Marginal Relevance to the final recall selection per-section. */
  recallMmrEnabled: boolean;
  /** MMR λ parameter. 1.0 = pure relevance, 0.0 = pure diversity. Default 0.7. */
  recallMmrLambda: number;
  /** MMR is applied over the top N candidates per section. Default 40. */
  recallMmrTopN: number;
  /**
   * Boost stored `reasoning_trace` memories in recall results when the
   * incoming query reads like a problem-solving ask (e.g. "how do I…",
   * "step by step", "walk me through…"). Default false — opt in after
   * benchmarking (issue #564 PR 3).
   */
  recallReasoningTraceBoostEnabled: boolean;
  qmdRecallCacheTtlMs: number;
  qmdRecallCacheStaleTtlMs: number;
  qmdRecallCacheMaxEntries: number;
  entityRelationshipsEnabled: boolean;
  entityActivityLogEnabled: boolean;
  entityActivityLogMaxEntries: number;
  entityAliasesEnabled: boolean;
  entitySummaryEnabled: boolean;
  entitySynthesisMaxTokens: number;

  // v6.0 Fact deduplication & archival
  /** Enable content-hash deduplication to prevent storing semantically identical facts. */
  factDeduplicationEnabled: boolean;
  /**
   * Issue #373 — Write-time semantic similarity guard. When enabled (default),
   * the orchestrator embeds each candidate fact and queries the existing
   * embedding index for its top-K nearest neighbors. If the best cosine
   * similarity is at or above `semanticDedupThreshold`, the fact is dropped
   * as a near-duplicate. Fails open (keeps the fact) if the embedding backend
   * is unavailable.
   */
  semanticDedupEnabled: boolean;
  /** Cosine similarity threshold in [0, 1] above which a candidate fact is skipped. */
  semanticDedupThreshold: number;
  /** Number of nearest-neighbor candidates to consider during semantic dedup. */
  semanticDedupCandidates: number;
  /** Enable automatic archival of old, low-importance, rarely-accessed facts. */
  factArchivalEnabled: boolean;
  /** Minimum age in days before a fact is eligible for archival. */
  factArchivalAgeDays: number;
  /** Maximum importance score for archival eligibility (0-1). Only facts below this are archived. */
  factArchivalMaxImportance: number;
  /** Maximum access count for archival eligibility. Only rarely-accessed facts are archived. */
  factArchivalMaxAccessCount: number;
  /** Tags that protect a fact from archival regardless of other criteria. */
  factArchivalProtectedCategories: string[];
  // v8.3 Lifecycle policy engine
  lifecyclePolicyEnabled: boolean;
  lifecycleFilterStaleEnabled: boolean;
  lifecyclePromoteHeatThreshold: number;
  lifecycleStaleDecayThreshold: number;
  lifecycleArchiveDecayThreshold: number;
  lifecycleProtectedCategories: MemoryCategory[];
  lifecycleMetricsEnabled: boolean;
  // v8.3 proactive + policy learning
  proactiveExtractionEnabled: boolean;
  contextCompressionActionsEnabled: boolean;
  compressionGuidelineLearningEnabled: boolean;
  compressionGuidelineSemanticRefinementEnabled: boolean;
  compressionGuidelineSemanticTimeoutMs: number;
  maxProactiveQuestionsPerExtraction: number;
  proactiveExtractionTimeoutMs: number;
  proactiveExtractionMaxTokens: number;
  extractionMaxOutputTokens: number;
  proactiveExtractionCategoryAllowlist?: MemoryCategory[];
  maxCompressionTokensPerHour: number;
  behaviorLoopAutoTuneEnabled: boolean;
  behaviorLoopLearningWindowDays: number;
  behaviorLoopMinSignalCount: number;
  behaviorLoopMaxDeltaPerCycle: number;
  behaviorLoopProtectedParams: string[];
  // v8.0 Phase 1: recall planner + intent routing + verbatim artifacts
  recallPlannerEnabled: boolean;
  recallPlannerModel: string;
  recallPlannerTimeoutMs: number;
  recallPlannerUseResponsesApi: boolean;
  recallPlannerMaxPromptChars: number;
  recallPlannerMaxMemoryHints: number;
  recallPlannerShadowMode: boolean;
  recallPlannerTelemetryEnabled: boolean;
  recallPlannerMaxQmdResultsMinimal: number;
  recallPlannerMaxQmdResultsFull: number;
  intentRoutingEnabled: boolean;
  intentRoutingBoost: number;
  verbatimArtifactsEnabled: boolean;
  verbatimArtifactsMinConfidence: number;
  verbatimArtifactsMaxRecall: number;
  verbatimArtifactCategories: MemoryCategory[];
  // v8.0 Phase 2A: Memory Boxes + Trace Weaving
  memoryBoxesEnabled: boolean;
  /** Jaccard overlap threshold below which a topic shift triggers box sealing (0-1, default 0.35) */
  boxTopicShiftThreshold: number;
  /** Time gap in ms before an open box is sealed (default 30 min) */
  boxTimeGapMs: number;
  /** Max memories per box before forced seal */
  boxMaxMemories: number;
  traceWeaverEnabled: boolean;
  /** Days back to search for trace links */
  traceWeaverLookbackDays: number;
  /** Minimum Jaccard overlap to assign the same traceId (0-1, default 0.4) */
  traceWeaverOverlapThreshold: number;
  /** Number of recent days of boxes to inject during recall */
  boxRecallDays: number;
  // v8.0 Phase 2B: Episode/Note dual store (HiMem)
  /** Classify extracted memories as episode or note and tag with memoryKind */
  episodeNoteModeEnabled: boolean;
  // v8.1 Temporal + Tag Indexes (SwiftMem-inspired)
  /** Build and maintain temporal (state/index_time.json) and tag (state/index_tags.json) indexes */
  queryAwareIndexingEnabled: boolean;
  /** Max candidate paths returned from index prefilter (0 = no cap) */
  queryAwareIndexingMaxCandidates: number;
  temporalIndexWindowDays: number;
  temporalIndexMaxEntries: number;
  temporalBoostRecentDays: number;
  temporalBoostScore: number;
  temporalDecayEnabled: boolean;
  tagMemoryEnabled: boolean;
  tagMaxPerMemory: number;
  tagIndexMaxEntries: number;
  tagRecallBoost: number;
  tagRecallMaxMatches: number;
  // v8.2 multi-graph memory (PR 18)
  multiGraphMemoryEnabled: boolean;
  // v8.2 PR 19A: graph recall planner gating
  graphRecallEnabled: boolean;
  graphRecallMaxExpansions: number;
  graphRecallMaxPerSeed: number;
  graphRecallMinEdgeWeight: number;
  graphRecallShadowEnabled: boolean;
  graphRecallSnapshotEnabled: boolean;
  graphRecallShadowSampleRate: number;
  graphRecallExplainToolEnabled: boolean;
  graphRecallStoreColdMirror: boolean;
  graphRecallColdMirrorCollection?: string;
  graphRecallColdMirrorMinAgeDays: number;
  graphRecallUseEntityPriors: boolean;
  graphRecallEntityPriorBoost: number;
  graphRecallPreferHubSeeds: boolean;
  graphRecallHubBias: number;
  graphRecallRecencyHalfLifeDays: number;
  graphRecallDampingFactor: number;
  graphRecallMaxSeedNodes: number;
  graphRecallMaxExpandedNodes: number;
  graphRecallMaxTrailPerNode: number;
  graphRecallMinSeedScore: number;
  graphRecallExpansionScoreThreshold: number;
  graphRecallExplainMaxPaths: number;
  graphRecallExplainMaxChars: number;
  graphRecallExplainEdgeLimit: number;
  graphRecallExplainEnabled: boolean;
  graphRecallEntityHintsEnabled: boolean;
  graphRecallEntityHintMax: number;
  graphRecallEntityHintMaxChars: number;
  graphRecallSnapshotDir: string;
  graphRecallEnableTrace: boolean;
  graphRecallEnableDebug: boolean;
  /** Allow graph_mode escalation for broader causal/timeline phrasing beyond strict keywords. */
  graphExpandedIntentEnabled?: boolean;
  /** Run bounded graph expansion in full mode when enough recall seeds exist. */
  graphAssistInFullModeEnabled?: boolean;
  /** In full mode, compute graph assist for telemetry/snapshotting but do not inject merged results. */
  graphAssistShadowEvalEnabled?: boolean;
  /** Minimum seed results required before full-mode graph assist runs. */
  graphAssistMinSeedResults?: number;
  entityGraphEnabled: boolean;
  timeGraphEnabled: boolean;
  /** When true, write fallback temporal adjacency edges for consecutive extracted memories. */
  graphWriteSessionAdjacencyEnabled?: boolean;
  causalGraphEnabled: boolean;
  maxGraphTraversalSteps: number;
  graphActivationDecay: number;
  /** Weight of graph activation score when blending with seed QMD score (0-1). */
  graphExpansionActivationWeight: number;
  /** Lower bound for blended graph-expanded recall scores (0-1). */
  graphExpansionBlendMin: number;
  /** Upper bound for blended graph-expanded recall scores (0-1). */
  graphExpansionBlendMax: number;
  maxEntityGraphEdgesPerMemory: number;
  /** SimpleMem-inspired de-linearization: resolve pronouns and anchor relative dates after extraction. */
  delinearizeEnabled: boolean;
  /** Synapse-inspired confidence gate — skip memory injection when top score is below threshold. */
  recallConfidenceGateEnabled: boolean;
  recallConfidenceGateThreshold: number;
  /** PlugMem-inspired causal rule extraction: mine IF→THEN rules during consolidation. */
  causalRuleExtractionEnabled: boolean;
  /** E-Mem-inspired memory reconstruction: targeted retrieval for missing entity context. */
  memoryReconstructionEnabled: boolean;
  /** Maximum number of entity expansions per recall. */
  memoryReconstructionMaxExpansions: number;
  /** Synapse-inspired lateral inhibition to suppress hub-node dominance. */
  graphLateralInhibitionEnabled: boolean;
  /** Inhibition strength (default 0.15). Higher = more suppression. */
  graphLateralInhibitionBeta: number;
  /** Number of top competing nodes considered for inhibition (default 7). */
  graphLateralInhibitionTopM: number;
  // v8.2: Temporal Memory Tree
  temporalMemoryTreeEnabled: boolean;
  tmtHourlyMinMemories: number;
  tmtSummaryMaxTokens: number;
  // Lossless Context Management (LCM)
  lcmEnabled: boolean;
  lcmLeafBatchSize: number;
  lcmRollupFanIn: number;
  lcmFreshTailTurns: number;
  lcmMaxDepth: number;
  lcmRecallBudgetShare: number;
  lcmDeterministicMaxTokens: number;
  lcmArchiveRetentionDays: number;

  // v9.1 Parallel Specialized Retrieval (ASMR-inspired)
  /** Enable three-agent parallel retrieval (DirectFact + Contextual + Temporal). Default false. */
  parallelRetrievalEnabled: boolean;
  /** Per-agent source weights for score blending during merge. */
  parallelAgentWeights: { direct: number; contextual: number; temporal: number };
  /** Max results fetched per agent before merge. */
  parallelMaxResultsPerAgent: number;

  // Daily Context Briefing (Issue #370)
  /** Briefing configuration knobs — see BriefingConfig for field docs. */
  briefing: BriefingConfig;

  // Codex CLI connector settings (install-time)
  codex: CodexConnectorConfig;

  // MECE Taxonomy (#366)
  /** Enable the MECE taxonomy knowledge directory. Default false. */
  taxonomyEnabled: boolean;
  /** Auto-regenerate RESOLVER.md when taxonomy changes. Default true. */
  taxonomyAutoGenResolver: boolean;

  // Codex CLI — native memory materialization (#378)
  /** Materialize Remnic memories into Codex's expected ~/.codex/memories/ layout. Default true. */
  codexMaterializeMemories: boolean;
  /** Namespace to materialize; "auto" derives from the connector context. Default "auto". */
  codexMaterializeNamespace: string;
  /** Max whitespace-tokenized size of memory_summary.md. Default 4500. */
  codexMaterializeMaxSummaryTokens: number;
  /** Max age in days for rollout_summaries/*.md before pruning. Default 30. */
  codexMaterializeRolloutRetentionDays: number;
  /** Run materialization after semantic/causal consolidation completes. Default true. */
  codexMaterializeOnConsolidation: boolean;
  /** Run materialization at Codex session-end hook. Default true. */
  codexMaterializeOnSessionEnd: boolean;
  /** Enable Codex marketplace integration. Default true. */
  codexMarketplaceEnabled: boolean;

  // Page-level versioning (issue #371)
  /** Enable page-level versioning with sidecar snapshots. Default false. */
  versioningEnabled: boolean;
  /** Maximum number of version snapshots to keep per page. Default 50. Set to 0 to disable pruning. */
  versioningMaxPerPage: number;
  /** Name of the sidecar directory inside memoryDir. Default ".versions". */
  versioningSidecarDir: string;

  // Binary file lifecycle management (#367)
  /** Enable binary file lifecycle management (mirror, redirect, clean). Default: false. */
  binaryLifecycleEnabled: boolean;
  /** Grace period in days before a mirrored binary is eligible for local cleanup. Default: 7. */
  binaryLifecycleGracePeriodDays: number;
  /** Storage backend type: "filesystem" copies to a local dir, "none" is no-op. Default: "none". */
  binaryLifecycleBackendType: "filesystem" | "s3" | "none";
  /** Base path for the filesystem backend. Required when backendType is "filesystem". */
  binaryLifecycleBackendPath: string;

  // Codex citation parity (issue #379)
  /** Enable oai-mem-citation blocks in recall responses. Default false. */
  citationsEnabled: boolean;
  /** Auto-enable citations when the Codex adapter is detected. Default true. */
  citationsAutoDetect: boolean;

  // External enrichment pipeline (issue #365)
  /** Enable the external enrichment pipeline. Default false. */
  enrichmentEnabled: boolean;
  /** Automatically enrich new entities on creation. Default false. */
  enrichmentAutoOnCreate: boolean;
  /** Max candidates accepted per entity per enrichment run. Default 20. */
  enrichmentMaxCandidatesPerEntity: number;

  // Memory extensions discovery (#382)
  /** Whether third-party memory extensions are discovered and injected into consolidation. Default true. */
  memoryExtensionsEnabled: boolean;
  /**
   * Root directory for memory extensions. Empty string means derive from
   * memoryDir: go up to the Remnic home dir and append memory_extensions.
   */
  memoryExtensionsRoot: string;
}

/** Runtime configuration for the daily context briefing feature. */
export interface BriefingConfig {
  /** Whether `remnic briefing` CLI and MCP tool are enabled. */
  enabled: boolean;
  /** Default lookback window token (e.g. "yesterday", "3d", "1w", "24h"). */
  defaultWindow: string;
  /** Default output format for the CLI. */
  defaultFormat: "markdown" | "json";
  /** Maximum number of LLM-generated suggested follow-ups. */
  maxFollowups: number;
  /** Optional path to an ICS or JSON calendar file. null disables the section. */
  calendarSource: string | null;
  /** If true, CLI writes a dated briefing file by default. */
  saveByDefault: boolean;
  /** Override directory for saved briefings. null → $REMNIC_HOME/briefings/. */
  saveDir: string | null;
  /** Whether to call the Responses API for follow-up suggestions. */
  llmFollowups: boolean;
}

/** Parsed representation of a briefing lookback window. */
export type BriefingWindow = "yesterday" | "today" | string;

/** Filter the briefing to a single entity / project / topic. */
export interface BriefingFocus {
  type: "person" | "project" | "topic";
  value: string;
}

/** Calendar event surfaced by a CalendarSource implementation. */
export interface CalendarEvent {
  /** Stable identifier for dedupe / linking. */
  id: string;
  /** Event title (short). */
  title: string;
  /** ISO 8601 start timestamp. */
  start: string;
  /** Optional ISO 8601 end timestamp. */
  end?: string;
  /** Optional freeform location. */
  location?: string;
  /** Optional short notes. */
  notes?: string;
}

/** Abstraction over any calendar backend. Concrete implementations: `FileCalendarSource`. */
export interface CalendarSource {
  /** Return events that fall on the given UTC date (YYYY-MM-DD). */
  eventsForDate(dateIso: string): Promise<CalendarEvent[]>;
}

/** A single "active thread" surfaced in a briefing. */
export interface BriefingActiveThread {
  id: string;
  title: string;
  updatedAt: string;
  reason: string;
}

/** A single "recent entity" entry. */
export interface BriefingRecentEntity {
  name: string;
  type: string;
  updatedAt: string;
  score: number;
  summary?: string;
}

/** A single unresolved commitment or open question. */
export interface BriefingOpenCommitment {
  id: string;
  kind: "question" | "commitment" | "pending_memory";
  text: string;
  source?: string;
  createdAt?: string;
}

/** An LLM-generated short follow-up suggestion. */
export interface BriefingFollowup {
  text: string;
  rationale?: string;
}

/** Structured sections of a briefing result. */
export interface BriefingSections {
  activeThreads: BriefingActiveThread[];
  recentEntities: BriefingRecentEntity[];
  openCommitments: BriefingOpenCommitment[];
  suggestedFollowups: BriefingFollowup[];
  /** Only populated when a calendar source is configured and returns events. */
  todayCalendar?: CalendarEvent[];
}

/** A calendar source failure recorded when a CalendarSource throws during briefing generation. */
export interface BriefingCalendarSourceError {
  /** Human-readable description of the source (e.g. file path or source name). */
  source: string;
  /** Stringified error message from the failed source. */
  error: string;
}

/** Result returned by `buildBriefing`. */
export interface BriefingResult {
  markdown: string;
  json: Record<string, unknown>;
  sections: BriefingSections;
  /** Reason why suggested follow-ups were omitted (e.g. missing API key, LLM error). */
  followupsUnavailableReason?: string;
  /** Effective lookback window (ISO date range) used for this briefing. */
  window: { from: string; to: string };
  /**
   * Calendar sources that failed during this briefing run.
   * Only present (non-empty) when at least one source threw.
   * Allows callers to distinguish "no events today" from "source unavailable".
   */
  calendarSourceErrors?: BriefingCalendarSourceError[];
}

/**
 * Settings for the Codex CLI connector. These are consumed by
 * `remnic connectors install codex-cli` to decide where the phase-2 memory
 * extension is dropped and whether to install it at all.
 */
export interface CodexConnectorConfig {
  /**
   * Whether to install the Remnic memory extension into
   * `<codex_home>/memories_extensions/remnic/` when the `codex-cli`
   * connector is installed. Default `true`. Set to `false` for users who
   * self-manage the Codex memory extensions folder.
   */
  installExtension: boolean;
  /**
   * Optional override for the Codex home directory. When `null`, the
   * connector reads `$CODEX_HOME` and falls back to `~/.codex`. Setting
   * this is useful for integration tests and non-default installs.
   */
  codexHome: string | null;
}

export interface BootstrapOptions {
  dryRun?: boolean;
  sessionsDir?: string;
  limit?: number;
  since?: Date;
}

export interface BootstrapResult {
  sessionsScanned: number;
  turnsProcessed: number;
  highSignalTurns: number;
  memoriesCreated: number;
  skipped: number;
}

export interface PrincipalRule {
  match: string;
  principal: string;
}

export interface NamespacePolicy {
  name: string;
  readPrincipals: string[];
  writePrincipals: string[];
  includeInRecallByDefault?: boolean;
}

export interface RelevanceFeedback {
  up: number;
  down: number;
  lastUpdatedAt: string;
  notes?: string[];
}

export interface BufferTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  sessionKey?: string;
  logicalSessionKey?: string;
  providerThreadId?: string | null;
  turnFingerprint?: string;
  persistProcessedFingerprint?: boolean;
}

export interface BufferEntryState {
  turns: BufferTurn[];
  lastExtractionAt: string | null;
  extractionCount: number;
  /**
   * Turns retained across `clearAfterExtraction` so a later extraction pass
   * sees the context that caused a defer verdict (issue #562, PR 2). Bounded
   * to the configured retention cap by `retainDeferredTurns`. Empty / absent
   * means no retention in effect.
   */
  retainedTurns?: BufferTurn[];
}

export interface BufferState {
  turns: BufferTurn[];
  lastExtractionAt: string | null;
  extractionCount: number;
  entries?: Record<string, BufferEntryState>;
}

export interface BehaviorLoopAdjustment {
  parameter: string;
  previousValue: number;
  nextValue: number;
  delta: number;
  evidenceCount: number;
  confidence: number;
  reason: string;
  appliedAt: string;
}

export interface BehaviorLoopPolicyState {
  version: number;
  windowDays: number;
  minSignalCount: number;
  maxDeltaPerCycle: number;
  protectedParams: string[];
  adjustments: BehaviorLoopAdjustment[];
  updatedAt: string;
}

export type BehaviorSignalType = "correction_override" | "preference_affinity" | "topic_revisitation" | "action_pattern" | "outcome_preference" | "phrasing_style";
export type BehaviorSignalDirection = "positive" | "negative";

export interface BehaviorSignalEvent {
  timestamp: string;
  namespace: string;
  memoryId: string;
  category: Extract<MemoryCategory, "correction" | "preference">;
  signalType: BehaviorSignalType;
  direction: BehaviorSignalDirection;
  confidence: number;
  signalHash: string;
  source: "extraction" | "correction";
}

/** Memory status for lifecycle management */
export type MemoryStatus = "active" | "pending_review" | "rejected" | "quarantined" | "superseded" | "archived";
export type LifecycleState = "candidate" | "validated" | "active" | "stale" | "archived";
export type VerificationState = "unverified" | "user_confirmed" | "system_inferred" | "disputed";
export type PolicyClass = "ephemeral" | "durable" | "protected";

/** Importance level tiers */
export type ImportanceLevel = "critical" | "high" | "normal" | "low" | "trivial";

/** Importance scoring result */
export interface ImportanceScore {
  /** Numeric score 0-1 */
  score: number;
  /** Tier level */
  level: ImportanceLevel;
  /** Reasons for this score */
  reasons: string[];
  /** Salient keywords extracted */
  keywords: string[];
}

export interface MemoryFrontmatter {
  id: string;
  category: MemoryCategory;
  created: string;
  updated: string;
  source: string;
  confidence: number;
  confidenceTier: ConfidenceTier;
  tags: string[];
  entityRef?: string;
  supersedes?: string;
  /** ISO 8601 date — memory expires and gets cleaned up after this date */
  expiresAt?: string;
  /** IDs of parent memories this was derived from (lineage tracking) */
  lineage?: string[];
  /** Memory status: active (default), pending_review, rejected, quarantined, superseded, or archived */
  status?: MemoryStatus;
  /** ID of memory that superseded this one */
  supersededBy?: string;
  /** Timestamp when superseded */
  supersededAt?: string;
  /** Timestamp when archived */
  archivedAt?: string;
  /** Policy-driven lifecycle state used for retrieval eligibility/ranking. */
  lifecycleState?: LifecycleState;
  /** Verification provenance used by lifecycle policy. */
  verificationState?: VerificationState;
  /** Policy class used by lifecycle guardrails. */
  policyClass?: PolicyClass;
  /** Last lifecycle validation timestamp (ISO 8601). */
  lastValidatedAt?: string;
  /** Lifecycle decay score in [0,1]. */
  decayScore?: number;
  /** Lifecycle heat score in [0,1]. */
  heatScore?: number;
  // Access tracking (Phase 1A)
  /** Number of times this memory has been retrieved */
  accessCount?: number;
  /** Last time this memory was accessed (ISO 8601) */
  lastAccessed?: string;
  // Memory Worth counters (issue #560)
  //
  // Per-fact outcome counters used to derive a dynamic utility score —
  // `p(success | retrieved)` — as a complement to the static `importance`
  // field. Absent on legacy memories written before #560; readers must treat
  // `undefined` as zero observations (uniform Beta(1,1) prior).
  //
  // Both values must be non-negative integers on write. PR 1 wires only the
  // schema + storage round-trip — no increments, scoring, or filtering yet.
  /** Number of sessions where this memory was retrieved and the outcome was judged a success. */
  mw_success?: number;
  /** Number of sessions where this memory was retrieved and the outcome was judged a failure. */
  mw_fail?: number;
  // Importance scoring (Phase 1B)
  /** Importance score with level, reasons, and keywords */
  importance?: ImportanceScore;
  // Chunking (Phase 2A)
  /** Parent memory ID if this is a chunk */
  parentId?: string;
  /** Chunk index within parent (0-based) */
  chunkIndex?: number;
  /** Total number of chunks for this parent */
  chunkTotal?: number;
  // Memory Linking (Phase 3A)
  /** Links to other memories */
  links?: MemoryLink[];
  // Intent-grounded memory routing (v8.0 phase 1)
  intentGoal?: string;
  intentActionType?: string;
  intentEntityTypes?: string[];
  // Verbatim artifact lineage (v8.0 phase 1)
  artifactType?: "decision" | "constraint" | "todo" | "definition" | "commitment" | "correction" | "fact";
  sourceMemoryId?: string;
  sourceTurnId?: string;
  // v8.0 Phase 2B: HiMem episode/note classification
  /** episode = time-specific event; note = stable belief/preference/decision */
  memoryKind?: "episode" | "note" | "box" | "dream" | "procedural";
  /** Structured key-value attributes extracted from the content (e.g., product attributes, dates, quantities). */
  structuredAttributes?: Record<string, string>;
  /**
   * SHA-256 (via ContentHashIndex.computeHash) of the raw content that was
   * used as the dedup key at write time. Persists through archive and
   * consolidation so the hash can be removed from the index even if the stored
   * content has been transformed (e.g. an inline citation was appended).
   *
   * When present, archive/consolidation paths use this directly instead of
   * calling stripCitation(memory.content), which only handles the default
   * [Source: ...] format and silently fails for custom citation templates.
   */
  contentHash?: string;
  /**
   * Consolidation provenance — pointers to the page-versioning snapshots
   * that this memory was derived from (issue #561).  Each entry is a
   * `"<memory-path>:<version-number>"` string (e.g.
   * `"facts/preferences.md:3"`) referencing a snapshot recorded by
   * `page-versioning.ts`.
   *
   * PR 1 introduces this field as read-through only — storage preserves
   * it verbatim but no code produces it yet.  PR 2 populates it on
   * consolidation writes; PR 4 adds a `remnic doctor` integrity check
   * that validates each referent actually exists.
   */
  derived_from?: string[];
  /**
   * Which consolidation operator produced this memory (issue #561).  See
   * `ConsolidationOperator` in `semantic-consolidation.ts` for the
   * operator algebra.  Absent on memories that were not produced by a
   * consolidation pass.
   */
  derived_via?: "split" | "merge" | "update";
}

/** Memory link relationship types */
export type MemoryLinkType = "follows" | "references" | "contradicts" | "supports" | "related";

/** A link between memories */
export interface MemoryLink {
  targetId: string;
  linkType: MemoryLinkType;
  strength: number;
  reason?: string;
}

// Conversation Threading (Phase 3B)
export interface ConversationThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessionKey?: string;
  episodeIds: string[];
  linkedThreadIds: string[];
}

// Memory Summarization (Phase 4A)
export interface MemorySummary {
  id: string;
  createdAt: string;
  timeRangeStart: string;
  timeRangeEnd: string;
  summaryText: string;
  keyFacts: string[];
  keyEntities: string[];
  sourceEpisodeIds: string[];
}

export interface DaySummaryResult {
  summary: string;
  bullets: string[];
  next_actions: string[];
  risks_or_open_loops: string[];
}

// Topic Extraction (Phase 4B)
export interface TopicScore {
  term: string;
  score: number;
  count: number;
}

export interface MemoryFile {
  path: string;
  frontmatter: MemoryFrontmatter;
  content: string;
}

/** Ordered step for extracted procedure memories (issue #519). */
export interface ExtractedProcedureStep {
  order: number;
  intent: string;
  toolCall?: { kind: string; signature: string };
  expectedOutcome?: string;
  optional?: boolean;
}

export interface ExtractedFact {
  category: MemoryCategory;
  content: string;
  confidence: number;
  tags: string[];
  entityRef?: string;
  source?: ExtractionPassSource;
  promptedByQuestion?: string;
  /** Structured key-value attributes extracted from the content (e.g., product attributes, dates, quantities). */
  structuredAttributes?: Record<string, string>;
  /** When category is `procedure`, ordered steps with intents (persisted under procedures/). */
  procedureSteps?: ExtractedProcedureStep[];
  /**
   * When category is `reasoning_trace`, the stored solution chain the user
   * walked through. Persisted under reasoning-traces/.
   */
  reasoningTrace?: ExtractedReasoningTrace;
}

export interface ExtractedReasoningTraceStep {
  order: number;
  description: string;
}

export interface ExtractedReasoningTrace {
  steps: ExtractedReasoningTraceStep[];
  finalAnswer: string;
  observedOutcome?: string;
}

export interface MemoryIntent {
  goal: string;
  actionType: string;
  entityTypes: string[];
  /** True when the prompt reads like starting a concrete task (ship/deploy/tests/PR, etc.). */
  taskInitiation?: boolean;
}

export interface ExtractedQuestion {
  question: string;
  context: string;
  priority: number;
}

export interface QuestionEntry {
  id: string;
  question: string;
  context: string;
  priority: number; // 0-1, higher = more important
  created: string;
  resolved: boolean;
  resolvedAt?: string;
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  profileUpdates: string[];
  entities: EntityMention[];
  questions: ExtractedQuestion[];
  identityReflection?: string;
  relationships?: ExtractedRelationship[];
}

export interface EntityMention {
  name: string;
  type: "person" | "project" | "tool" | "company" | "place" | "other";
  facts: string[];
  structuredSections?: EntityStructuredSection[];
  source?: ExtractionPassSource;
  promptedByQuestion?: string;
}

// ---------------------------------------------------------------------------
// Knowledge Graph Enhancement (Entity Relationships, Activity, Scoring)
// ---------------------------------------------------------------------------

export interface EntityRelationship {
  target: string;
  label: string;
}

export interface EntityActivityEntry {
  date: string;
  note: string;
}

export interface EntityTimelineEntry {
  timestamp: string;
  text: string;
  source?: string;
  sessionKey?: string;
  principal?: string;
}

export interface EntityStructuredSection {
  key: string;
  title: string;
  facts: string[];
}

export interface EntitySchemaSectionDefinition {
  key: string;
  title: string;
  description: string;
  aliases?: string[];
}

export interface EntitySchemaDefinition {
  sections: EntitySchemaSectionDefinition[];
}

export interface EntityFile {
  name: string;
  type: string;
  created?: string;
  updated: string;
  extraFrontmatterLines?: string[];
  preSectionLines?: string[];
  facts: string[];
  summary?: string;
  synthesis?: string;
  synthesisUpdatedAt?: string;
  synthesisTimelineCount?: number;
  synthesisStructuredFactCount?: number;
  synthesisStructuredFactDigest?: string;
  synthesisVersion?: number;
  timeline: EntityTimelineEntry[];
  structuredSections?: EntityStructuredSection[];
  relationships: EntityRelationship[];
  activity: EntityActivityEntry[];
  aliases: string[];
  extraSections?: Array<{
    title: string;
    lines: string[];
  }>;
}

export interface ScoredEntity {
  name: string;
  type: string;
  score: number;
  factCount: number;
  summary?: string;
  topRelationships: string[];
}

export interface ExtractedRelationship {
  source: string;
  target: string;
  label: string;
  extractionSource?: ExtractionPassSource;
  promptedByQuestion?: string;
}

export interface ConsolidationItem {
  existingId: string;
  action: ConsolidationAction;
  mergeWith?: string;
  updatedContent?: string;
  reason: string;
}

export interface ConsolidationResult {
  items: ConsolidationItem[];
  profileUpdates: string[];
  entityUpdates: EntityMention[];
}

export interface ConsolidationObservation {
  runAt: string;
  recentMemories: MemoryFile[];
  existingMemories: MemoryFile[];
  profile: string;
  result: ConsolidationResult;
  merged: number;
  invalidated: number;
}

export interface QmdSearchResult {
  docid: string;
  path: string;
  snippet: string;
  score: number;
  explain?: QmdSearchExplain;
  transport?: "daemon" | "subprocess" | "hybrid" | "scoped_prefilter";
}

export interface QmdSearchExplain {
  ftsScores?: number[];
  vectorScores?: number[];
  rrf?: number;
  rerankScore?: number;
  blendedScore?: number;
}

export interface MetaState {
  extractionCount: number;
  lastExtractionAt: string | null;
  lastConsolidationAt: string | null;
  totalMemories: number;
  totalEntities: number;
  processedExtractionFingerprints?: Array<{
    fingerprint: string;
    observedAt: string;
  }>;
}

export type MemoryActionType =
  | "store_episode"
  | "store_note"
  | "update_note"
  | "create_artifact"
  | "summarize_node"
  | "discard"
  | "link_graph";

export type MemoryActionOutcome = "applied" | "skipped" | "failed";

export type MemoryActionPolicyDecision = "allow" | "defer" | "deny";

export type MemoryActionStatus = "validated" | "applied" | "rejected";

export type MemoryActionEligibilitySource =
  | "extraction"
  | "consolidation"
  | "replay"
  | "manual"
  | "unknown";

export interface MemoryActionEligibilityContext {
  confidence: number;
  lifecycleState: LifecycleState;
  importance: number;
  source: MemoryActionEligibilitySource;
}

export interface MemoryActionPolicyResult {
  action: MemoryActionType;
  decision: MemoryActionPolicyDecision;
  rationale: string;
  eligibility: MemoryActionEligibilityContext;
}

export interface MemoryActionEvent {
  schemaVersion?: number;
  actionId?: string;
  timestamp: string;
  action: MemoryActionType;
  outcome: MemoryActionOutcome;
  status?: MemoryActionStatus;
  actor?: string;
  subsystem?: string;
  reason?: string;
  memoryId?: string;
  namespace?: string;
  sessionKey?: string;
  sourceSessionKey?: string;
  checkpointCapturedAt?: string;
  checkpointTtl?: string;
  checkpointTurnCount?: number;
  inputSummary?: string;
  outputMemoryIds?: string[];
  dryRun?: boolean;
  policyVersion?: string;
  promptHash?: string;
  policyDecision?: MemoryActionPolicyDecision;
  policyRationale?: string;
  policyEligibility?: MemoryActionEligibilityContext;
}

export type MemoryLifecycleEventType =
  | "created"
  | "updated"
  | "superseded"
  | "archived"
  | "rejected"
  | "restored"
  | "merged"
  | "imported"
  | "promoted"
  | "explicit_capture_accepted"
  | "explicit_capture_queued";

export interface MemoryLifecycleStateSummary {
  category?: MemoryCategory;
  path?: string;
  status?: MemoryStatus;
  lifecycleState?: LifecycleState;
}

export interface MemoryLifecycleEvent {
  eventId: string;
  memoryId: string;
  eventType: MemoryLifecycleEventType;
  timestamp: string;
  actor: string;
  reasonCode?: string;
  ruleVersion: string;
  relatedMemoryIds?: string[];
  before?: MemoryLifecycleStateSummary;
  after?: MemoryLifecycleStateSummary;
  correlationId?: string;
}

export interface MemoryProjectionCurrentState {
  memoryId: string;
  category: MemoryCategory;
  status: MemoryStatus;
  lifecycleState?: LifecycleState;
  path: string;
  pathRel: string;
  created: string;
  updated: string;
  archivedAt?: string;
  supersededAt?: string;
  entityRef?: string;
  source: string;
  confidence: number;
  confidenceTier: ConfidenceTier;
  memoryKind?: MemoryFrontmatter["memoryKind"];
  accessCount?: number;
  lastAccessed?: string;
  tags?: string[];
  preview?: string;
}

export interface CompressionGuidelineOptimizerSourceWindow {
  from: string;
  to: string;
}

export interface CompressionGuidelineOptimizerEventCounts {
  total: number;
  applied: number;
  skipped: number;
  failed: number;
}

export type CompressionGuidelineActivationState = "draft" | "active";

export interface CompressionGuidelineOptimizerActionSummary {
  action: MemoryActionType;
  total: number;
  outcomes: Record<MemoryActionOutcome, number>;
  quality: {
    good: number;
    poor: number;
    unknown: number;
  };
}

export interface CompressionGuidelineOptimizerRuleUpdate {
  action: MemoryActionType;
  delta: number;
  direction: "increase" | "decrease" | "hold";
  confidence: "low" | "medium" | "high";
  notes: string[];
}

export interface CompressionGuidelineOptimizerState {
  version: number;
  updatedAt: string;
  sourceWindow: CompressionGuidelineOptimizerSourceWindow;
  eventCounts: CompressionGuidelineOptimizerEventCounts;
  guidelineVersion: number;
  contentHash?: string;
  activationState?: CompressionGuidelineActivationState;
  actionSummaries?: CompressionGuidelineOptimizerActionSummary[];
  ruleUpdates?: CompressionGuidelineOptimizerRuleUpdate[];
}

export type ContinuityIncidentState = "open" | "closed";

export interface ContinuityIncidentRecord {
  id: string;
  state: ContinuityIncidentState;
  openedAt: string;
  updatedAt: string;
  triggerWindow?: string;
  symptom: string;
  suspectedCause?: string;
  fixApplied?: string;
  verificationResult?: string;
  preventiveRule?: string;
  closedAt?: string;
  filePath?: string;
}

export interface ContinuityIncidentOpenInput {
  triggerWindow?: string;
  symptom: string;
  suspectedCause?: string;
}

export interface ContinuityIncidentCloseInput {
  fixApplied: string;
  verificationResult: string;
  preventiveRule?: string;
}

export type ContinuityLoopCadence = "daily" | "weekly" | "monthly" | "quarterly";
export type ContinuityLoopStatus = "active" | "paused" | "retired";

export interface ContinuityImprovementLoop {
  id: string;
  cadence: ContinuityLoopCadence;
  purpose: string;
  status: ContinuityLoopStatus;
  killCondition: string;
  lastReviewed: string;
  notes?: string;
}

export interface ContinuityLoopUpsertInput {
  id: string;
  cadence: ContinuityLoopCadence;
  purpose: string;
  status: ContinuityLoopStatus;
  killCondition: string;
  lastReviewed?: string;
  notes?: string;
}

export interface ContinuityLoopReviewInput {
  status?: ContinuityLoopStatus;
  notes?: string;
  reviewedAt?: string;
}

/** Entry in the access tracking buffer (batched updates) */
export interface AccessTrackingEntry {
  memoryId: string;
  newCount: number;
  lastAccessed: string;
}

export interface SignalScanResult {
  level: SignalLevel;
  patterns: string[];
}

// ============================================================================
// LLM Trace Callback (for external observability plugins)
// ============================================================================

export interface LlmTraceEvent {
  kind: "llm_start" | "llm_end" | "llm_error";
  traceId: string;
  model: string;
  operation: "extraction" | "consolidation" | "profile_consolidation" | "identity_consolidation" | "day_summary";
  input?: string;
  output?: string;
  durationMs?: number;
  error?: string;
  tokenUsage?: { input?: number; output?: number; total?: number };
}

export interface RecallTraceEvent {
  kind: "recall_summary";
  traceId: string;
  operation: "recall";
  sessionKey?: string;
  promptHash: string;
  promptLength: number;
  retrievalQueryHash: string;
  retrievalQueryLength: number;
  recallMode: RecallPlanMode;
  recallResultLimit: number;
  qmdEnabled: boolean;
  qmdAvailable: boolean;
  recallNamespaces: string[];
  source: "none" | "hot_qmd" | "hot_embedding" | "cold_fallback" | "recent_scan";
  recalledMemoryCount: number;
  injected: boolean;
  contextChars: number;
  policyVersion?: string;
  identityInjectionMode?: IdentityInjectionMode | "none";
  identityInjectedChars?: number;
  identityInjectionTruncated?: boolean;
  durationMs: number;
  timings?: Record<string, string>;
  /**
   * The full recalled memory context injected into the system prompt.
   * Only populated when `traceRecallContent` config option is `true`.
   * Omitted by default to avoid sending potentially sensitive memory content
   * to external trace collectors unless explicitly opted in.
   */
  recalledContent?: string;
}

export type EngramTraceEvent = LlmTraceEvent | RecallTraceEvent;
export type LlmTraceCallback = (event: EngramTraceEvent) => void;

// ============================================================================
// Gateway Configuration Types (for fallback AI)
// ============================================================================

export type ModelApi = "openai-completions" | "anthropic-messages" | "google-generative" | string;

export type ModelProviderAuthMode = "bearer" | "header" | "query";

export interface ModelDefinitionConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  costPer1MInput?: number;
  costPer1MOutput?: number;
  aliases?: string[];
}

export interface ModelProviderConfig {
  baseUrl: string;
  apiKey?: string | Record<string, unknown>;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelDefinitionConfig[];
}

export interface AgentDefaultsConfig {
  model?: {
    primary?: string;
    backup?: string;
    fallbacks?: string[];
  };
  thinking?: {
    mode?: "off" | "on" | "adaptive";
    budget?: number;
  };
}

export interface AgentPersonaModelConfig {
  primary?: string;
  fallbacks?: string[];
}

export interface AgentPersona {
  id: string;
  name?: string;
  model?: AgentPersonaModelConfig;
}

export interface GatewayConfig {
  agents?: {
    defaults?: AgentDefaultsConfig;
    list?: AgentPersona[];
  };
  models?: {
    providers?: Record<string, ModelProviderConfig>;
  };
}

// ============================================================================
// Transcript & Context Preservation (v2.0)
// ============================================================================

export interface TranscriptEntry {
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  sessionKey: string;
  turnId: string;
  metadata?: {
    compactAfter?: boolean;
    compactionId?: string | null;
  };
}

export interface Checkpoint {
  sessionKey: string;
  capturedAt: string;
  turns: TranscriptEntry[];
  ttl: string; // ISO timestamp when checkpoint expires
}

export interface HourlySummary {
  hour: string; // "2026-02-08T14:00:00Z"
  sessionKey: string;
  bullets: string[];
  turnCount: number;
  generatedAt: string;
}
