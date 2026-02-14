export type ReasoningEffort = "none" | "low" | "medium" | "high";
export type TriggerMode = "smart" | "every_n" | "time_based";
export type SignalLevel = "none" | "low" | "medium" | "high";
export type MemoryCategory = "fact" | "preference" | "correction" | "entity" | "decision" | "relationship" | "principle" | "commitment" | "moment" | "skill";
export type ConsolidationAction = "ADD" | "MERGE" | "UPDATE" | "INVALIDATE" | "SKIP";
export type ConfidenceTier = "explicit" | "implied" | "inferred" | "speculative";
export type PrincipalFromSessionKeyMode = "map" | "prefix" | "regex";

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
  memoryDir: string;
  debug: boolean;
  identityEnabled: boolean;
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
  conversationRecallTopK: number;
  conversationRecallMaxChars: number;
  conversationRecallTimeoutMs: number;
  // Local LLM Provider (v2.1)
  localLlmEnabled: boolean;
  localLlmUrl: string;
  localLlmModel: string;
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
  // Local LLM resilience
  localLlmRetry5xxCount: number;
  localLlmRetryBackoffMs: number;
  localLlm400TripThreshold: number;
  localLlm400CooldownMs: number;
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
  autoPromoteToSharedEnabled: boolean;
  autoPromoteToSharedCategories: Array<"correction" | "decision" | "preference">;
  autoPromoteMinConfidenceTier: ConfidenceTier;

  // v4.0 Shared-context (cross-agent shared intelligence)
  sharedContextEnabled: boolean;
  sharedContextDir?: string;
  sharedContextMaxInjectChars: number;
  crossSignalsSemanticEnabled: boolean;
  crossSignalsSemanticTimeoutMs: number;

  // v5.0 Compounding engine
  compoundingEnabled: boolean;
  compoundingWeeklyCronEnabled: boolean;
  compoundingSemanticEnabled: boolean;
  compoundingSynthesisTimeoutMs: number;
  compoundingInjectEnabled: boolean;

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

/** Memory status for lifecycle management */
export type MemoryStatus = "active" | "superseded" | "archived";

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
}

export interface EntityMention {
  name: string;
  type: "person" | "project" | "tool" | "company" | "place" | "other";
  facts: string[];
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

export type LlmTraceCallback = (event: LlmTraceEvent) => void;

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
