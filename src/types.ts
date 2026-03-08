export type ReasoningEffort = "none" | "low" | "medium" | "high";
export type TriggerMode = "smart" | "every_n" | "time_based";
export type SignalLevel = "none" | "low" | "medium" | "high";
export type MemoryCategory = "fact" | "preference" | "correction" | "entity" | "decision" | "relationship" | "principle" | "commitment" | "moment" | "skill" | "rule";
export type ConsolidationAction = "ADD" | "MERGE" | "UPDATE" | "INVALIDATE" | "SKIP";
export type ConfidenceTier = "explicit" | "implied" | "inferred" | "speculative";
export type PrincipalFromSessionKeyMode = "map" | "prefix" | "regex";
export type RecallPlanMode = "no_recall" | "minimal" | "full" | "graph_mode";
export type CronRecallMode = "all" | "none" | "allowlist";
export type CronConversationRecallMode = "auto" | "always" | "never";
export type IdentityInjectionMode = "recovery_only" | "minimal" | "full";

export interface RecallSectionConfig {
  id: string;
  enabled?: boolean;
  maxChars?: number | null;
  consolidateTriggerLines?: number;
  consolidateTargetLines?: number;
  maxEntities?: number;
  maxResults?: number;
  maxTurns?: number;
  maxTokens?: number;
  lookbackHours?: number;
  maxCount?: number;
  topK?: number;
  timeoutMs?: number;
  maxPatterns?: number;
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

export function confidenceTier(score: number): ConfidenceTier {
  if (score >= 0.95) return "explicit";
  if (score >= 0.70) return "implied";
  if (score >= 0.40) return "inferred";
  return "speculative";
}

/** Default TTL in days for speculative memories (auto-expire if unconfirmed) */
export const SPECULATIVE_TTL_DAYS = 30;

export interface PluginConfig {
  openaiApiKey: string | undefined;
  openaiBaseUrl: string | undefined;
  model: string;
  reasoningEffort: ReasoningEffort;
  triggerMode: TriggerMode;
  bufferMaxTurns: number;
  bufferMaxMinutes: number;
  consolidateEveryN: number;
  highSignalPatterns: string[];
  maxMemoryTokens: number;
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
  fileHygiene?: FileHygieneConfig;
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
  // Contradiction Detection (Phase 2B)
  contradictionDetectionEnabled: boolean;
  contradictionSimilarityThreshold: number;
  contradictionMinConfidence: number;
  contradictionAutoResolve: boolean;
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
  // Hourly summaries
  hourlySummariesEnabled: boolean;
  /** If true, Engram may attempt to auto-register an hourly summary cron job (default off). */
  hourlySummaryCronAutoRegister: boolean;
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
  // Creation-memory foundation
  creationMemoryEnabled: boolean;
  commitmentLedgerEnabled: boolean;
  commitmentLifecycleEnabled: boolean;
  commitmentStaleDays: number;
  commitmentLedgerDir: string;
  resumeBundlesEnabled: boolean;
  resumeBundleDir: string;
  workProductRecallEnabled: boolean;
  workProductLedgerDir: string;
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
  /** Threshold for slow operation logging (ms). */
  slowLogThresholdMs: number;
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
  // Gateway config for fallback AI
  gatewayConfig?: GatewayConfig;

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
  autoPromoteToSharedCategories: Array<"correction" | "decision" | "preference">;
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

  // Search backend abstraction
  searchBackend?: "qmd" | "remote" | "noop" | "lancedb" | "meilisearch" | "orama";
  remoteSearchBaseUrl?: string;
  remoteSearchApiKey?: string;
  remoteSearchTimeoutMs?: number;

  // LanceDB backend
  lanceDbPath?: string;
  lanceEmbeddingDimension?: number;

  // Meilisearch backend
  meilisearchHost?: string;
  meilisearchApiKey?: string;
  meilisearchTimeoutMs?: number;
  meilisearchAutoIndex?: boolean;

  // Orama backend
  oramaDbPath?: string;
  oramaEmbeddingDimension?: number;

  // QMD daemon mode
  qmdDaemonEnabled: boolean;
  qmdDaemonUrl: string;
  qmdDaemonRecheckIntervalMs: number;

  // v7.0 Knowledge Graph Enhancement
  knowledgeIndexEnabled: boolean;
  knowledgeIndexMaxEntities: number;
  knowledgeIndexMaxChars: number;
  // Recall assembly controls
  recallBudgetChars: number;
  recallPipeline: RecallSectionConfig[];
  entityRelationshipsEnabled: boolean;
  entityActivityLogEnabled: boolean;
  entityActivityLogMaxEntries: number;
  entityAliasesEnabled: boolean;
  entitySummaryEnabled: boolean;

  // v6.0 Fact deduplication & archival
  /** Enable content-hash deduplication to prevent storing semantically identical facts. */
  factDeduplicationEnabled: boolean;
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
  maxCompressionTokensPerHour: number;
  behaviorLoopAutoTuneEnabled: boolean;
  behaviorLoopLearningWindowDays: number;
  behaviorLoopMinSignalCount: number;
  behaviorLoopMaxDeltaPerCycle: number;
  behaviorLoopProtectedParams: string[];
  // v8.0 Phase 1: recall planner + intent routing + verbatim artifacts
  recallPlannerEnabled: boolean;
  recallPlannerMaxQmdResultsMinimal: number;
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
  // v8.2 multi-graph memory (PR 18)
  multiGraphMemoryEnabled: boolean;
  // v8.2 PR 19A: graph recall planner gating
  graphRecallEnabled: boolean;
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
}

export interface BufferState {
  turns: BufferTurn[];
  lastExtractionAt: string | null;
  extractionCount: number;
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

export type BehaviorSignalType = "correction_override" | "preference_affinity";
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
export type MemoryStatus = "active" | "superseded" | "archived";
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
  /** Memory status: active (default), superseded, or archived */
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
  memoryKind?: "episode" | "note";
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

export interface ExtractedFact {
  category: MemoryCategory;
  content: string;
  confidence: number;
  tags: string[];
  entityRef?: string;
}

export interface MemoryIntent {
  goal: string;
  actionType: string;
  entityTypes: string[];
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

export interface EntityFile {
  name: string;
  type: string;
  updated: string;
  facts: string[];
  summary?: string;
  relationships: EntityRelationship[];
  activity: EntityActivityEntry[];
  aliases: string[];
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

export interface QmdSearchResult {
  docid: string;
  path: string;
  snippet: string;
  score: number;
}

export interface MetaState {
  extractionCount: number;
  lastExtractionAt: string | null;
  lastConsolidationAt: string | null;
  totalMemories: number;
  totalEntities: number;
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
  timestamp: string;
  action: MemoryActionType;
  outcome: MemoryActionOutcome;
  reason?: string;
  memoryId?: string;
  namespace?: string;
  promptHash?: string;
  policyDecision?: MemoryActionPolicyDecision;
  policyRationale?: string;
  policyEligibility?: MemoryActionEligibilityContext;
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

export interface CompressionGuidelineOptimizerState {
  version: number;
  updatedAt: string;
  sourceWindow: CompressionGuidelineOptimizerSourceWindow;
  eventCounts: CompressionGuidelineOptimizerEventCounts;
  guidelineVersion: number;
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
  operation: "extraction" | "consolidation" | "profile_consolidation" | "identity_consolidation";
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
  apiKey?: string;
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

export interface GatewayConfig {
  agents?: {
    defaults?: AgentDefaultsConfig;
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
