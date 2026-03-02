import path from "node:path";
import type {
  IdentityInjectionMode,
  PluginConfig,
  PrincipalRule,
  RecallPipelineConfig,
  RecallSectionConfig,
  ReasoningEffort,
  SessionObserverBandConfig,
  TriggerMode,
} from "./types.js";
import { log } from "./logger.js";
import { cloneDefaultSessionObserverBands } from "./session-observer-bands.js";

const DEFAULT_MEMORY_DIR = path.join(
  process.env.HOME ?? "~",
  ".openclaw",
  "workspace",
  "memory",
  "local",
);

const DEFAULT_WORKSPACE_DIR = path.join(
  process.env.HOME ?? "~",
  ".openclaw",
  "workspace",
);

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function normalizeOpenaiBaseUrl(value: string | undefined, source: "config" | "env"): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    log.warn(`ignoring invalid openaiBaseUrl from ${source}: not a valid URL`);
    return undefined;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    log.warn(
      `ignoring openaiBaseUrl from ${source}: unsupported URL scheme (${parsed.protocol.replace(":", "")})`,
    );
    return undefined;
  }

  if (parsed.protocol === "http:") {
    log.warn(`openaiBaseUrl from ${source} is using insecure http; prefer https`);
  }

  // Avoid duplicate slash behavior in downstream baseURL path joins.
  return parsed.toString().replace(/\/+$/, "");
}

const VALID_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];
const VALID_TRIGGERS: TriggerMode[] = ["smart", "every_n", "time_based"];
const VALID_IDENTITY_INJECTION_MODES: IdentityInjectionMode[] = ["recovery_only", "minimal", "full"];
const VALID_MEMORY_CATEGORIES = new Set([
  "fact",
  "preference",
  "correction",
  "entity",
  "decision",
  "relationship",
  "principle",
  "commitment",
  "moment",
  "skill",
]);

const DEFAULT_BEHAVIOR_LOOP_PROTECTED_PARAMS = [
  "maxMemoryTokens",
  "qmdMaxResults",
  "qmdColdMaxResults",
  "recallPlannerMaxQmdResultsMinimal",
  "verbatimArtifactsMaxRecall",
];

export function parseConfig(raw: unknown): PluginConfig {
  const cfg =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  let apiKey: string | undefined;
  if (typeof cfg.openaiApiKey === "string" && cfg.openaiApiKey.length > 0) {
    apiKey = resolveEnvVars(cfg.openaiApiKey);
  } else {
    apiKey = process.env.OPENAI_API_KEY;
  }

  // API key is optional at load time — retrieval works without it.
  // Extraction will log a warning if called without a key.

  const model =
    typeof cfg.model === "string" && cfg.model.length > 0
      ? cfg.model
      : "gpt-5.2";

  const rawEffort = cfg.reasoningEffort as string | undefined;
  const reasoningEffort: ReasoningEffort =
    rawEffort && VALID_EFFORTS.includes(rawEffort as ReasoningEffort)
      ? (rawEffort as ReasoningEffort)
      : "low";

  const rawTrigger = cfg.triggerMode as string | undefined;
  const triggerMode: TriggerMode =
    rawTrigger && VALID_TRIGGERS.includes(rawTrigger as TriggerMode)
      ? (rawTrigger as TriggerMode)
      : "smart";

  const memoryDir =
    typeof cfg.memoryDir === "string" && cfg.memoryDir.length > 0
      ? cfg.memoryDir
      : DEFAULT_MEMORY_DIR;
  const rawIdentityInjectionMode = cfg.identityInjectionMode as string | undefined;
  const identityInjectionMode: IdentityInjectionMode =
    rawIdentityInjectionMode
      && VALID_IDENTITY_INJECTION_MODES.includes(rawIdentityInjectionMode as IdentityInjectionMode)
      ? (rawIdentityInjectionMode as IdentityInjectionMode)
      : "recovery_only";
  const identityContinuityEnabled = cfg.identityContinuityEnabled === true;
  const sessionObserverBands: SessionObserverBandConfig[] = Array.isArray(cfg.sessionObserverBands)
    ? (cfg.sessionObserverBands as Array<Record<string, unknown>>)
        .map((band) => ({
          maxBytes:
            typeof band?.maxBytes === "number" ? Math.max(0, Math.floor(band.maxBytes)) : 0,
          triggerDeltaBytes:
            typeof band?.triggerDeltaBytes === "number"
              ? Math.max(0, Math.floor(band.triggerDeltaBytes))
              : 0,
          triggerDeltaTokens:
            typeof band?.triggerDeltaTokens === "number"
              ? Math.max(0, Math.floor(band.triggerDeltaTokens))
              : 0,
        }))
        .filter((band) => band.maxBytes > 0)
    : cloneDefaultSessionObserverBands();

  const principalRules: PrincipalRule[] = Array.isArray(cfg.principalFromSessionKeyRules)
    ? (cfg.principalFromSessionKeyRules as any[]).map((r) => ({
        match: typeof r?.match === "string" ? r.match : "",
        principal: typeof r?.principal === "string" ? r.principal : "",
      })).filter((r) => r.match.length > 0 && r.principal.length > 0)
    : [];

  // Optional file hygiene (memory file limits / truncation risk mitigation)
  const rawHygiene =
    cfg.fileHygiene && typeof cfg.fileHygiene === "object" && !Array.isArray(cfg.fileHygiene)
      ? (cfg.fileHygiene as Record<string, unknown>)
      : undefined;
  const hygieneEnabled = rawHygiene?.enabled === true;
  const fileHygiene = hygieneEnabled
    ? {
        enabled: true,
        lintEnabled: rawHygiene?.lintEnabled !== false,
        lintBudgetBytes:
          typeof rawHygiene?.lintBudgetBytes === "number" ? rawHygiene.lintBudgetBytes : 20_000,
        lintWarnRatio:
          typeof rawHygiene?.lintWarnRatio === "number" ? rawHygiene.lintWarnRatio : 0.8,
        lintPaths: Array.isArray(rawHygiene?.lintPaths)
          ? (rawHygiene!.lintPaths as string[])
          : ["IDENTITY.md", "MEMORY.md"],
        rotateEnabled: rawHygiene?.rotateEnabled === true,
        rotateMaxBytes:
          typeof rawHygiene?.rotateMaxBytes === "number" ? rawHygiene.rotateMaxBytes : 18_000,
        rotateKeepTailChars:
          typeof rawHygiene?.rotateKeepTailChars === "number"
            ? rawHygiene.rotateKeepTailChars
            : 2000,
        rotatePaths: Array.isArray(rawHygiene?.rotatePaths)
          ? (rawHygiene!.rotatePaths as string[])
          : ["IDENTITY.md"],
        archiveDir:
          typeof rawHygiene?.archiveDir === "string" && rawHygiene.archiveDir.length > 0
            ? (rawHygiene.archiveDir as string)
            : ".engram-archive",
        runMinIntervalMs:
          typeof rawHygiene?.runMinIntervalMs === "number" ? rawHygiene.runMinIntervalMs : 5 * 60 * 1000,
        warningsLogEnabled: rawHygiene?.warningsLogEnabled === true,
        warningsLogPath:
          typeof rawHygiene?.warningsLogPath === "string" && rawHygiene.warningsLogPath.length > 0
            ? (rawHygiene.warningsLogPath as string)
            : "hygiene/warnings.md",
        indexEnabled: rawHygiene?.indexEnabled === true,
        indexPath:
          typeof rawHygiene?.indexPath === "string" && rawHygiene.indexPath.length > 0
            ? (rawHygiene.indexPath as string)
            : "ENGRAM_INDEX.md",
      }
    : undefined;

  let baseUrl: string | undefined;
  if (typeof cfg.openaiBaseUrl === "string" && cfg.openaiBaseUrl.length > 0) {
    baseUrl = normalizeOpenaiBaseUrl(resolveEnvVars(cfg.openaiBaseUrl), "config");
  } else {
    baseUrl = normalizeOpenaiBaseUrl(process.env.OPENAI_BASE_URL, "env");
  }

  const sharedCrossSignalSemanticEnabled =
    cfg.sharedCrossSignalSemanticEnabled === true || cfg.crossSignalsSemanticEnabled === true;
  const sharedCrossSignalSemanticTimeoutMs =
    typeof cfg.sharedCrossSignalSemanticTimeoutMs === "number"
      ? Math.max(1, Math.floor(cfg.sharedCrossSignalSemanticTimeoutMs))
      : typeof cfg.crossSignalsSemanticTimeoutMs === "number"
        ? Math.max(1, Math.floor(cfg.crossSignalsSemanticTimeoutMs))
        : 4000;
  const recallPipelineConfig = buildRecallPipelineConfig(cfg);

  return {
    openaiApiKey: apiKey,
    openaiBaseUrl: baseUrl,
    model,
    reasoningEffort,
    triggerMode,
    bufferMaxTurns:
      typeof cfg.bufferMaxTurns === "number" ? cfg.bufferMaxTurns : 5,
    bufferMaxMinutes:
      typeof cfg.bufferMaxMinutes === "number" ? cfg.bufferMaxMinutes : 15,
    consolidateEveryN:
      typeof cfg.consolidateEveryN === "number" ? cfg.consolidateEveryN : 3,
    highSignalPatterns: Array.isArray(cfg.highSignalPatterns)
      ? (cfg.highSignalPatterns as string[])
      : [],
    maxMemoryTokens:
      typeof cfg.maxMemoryTokens === "number" ? cfg.maxMemoryTokens : 2000,
    qmdEnabled: cfg.qmdEnabled !== false,
    qmdCollection:
      typeof cfg.qmdCollection === "string"
        ? cfg.qmdCollection
        : "openclaw-engram",
    qmdMaxResults:
      typeof cfg.qmdMaxResults === "number" ? cfg.qmdMaxResults : 8,
    qmdColdTierEnabled: cfg.qmdColdTierEnabled === true,
    qmdColdCollection:
      typeof cfg.qmdColdCollection === "string" && cfg.qmdColdCollection.length > 0
        ? cfg.qmdColdCollection
        : "openclaw-engram-cold",
    qmdColdMaxResults:
      typeof cfg.qmdColdMaxResults === "number" ? cfg.qmdColdMaxResults : 8,
    qmdTierMigrationEnabled: cfg.qmdTierMigrationEnabled === true,
    qmdTierDemotionMinAgeDays:
      typeof cfg.qmdTierDemotionMinAgeDays === "number"
        ? Math.max(0, Math.floor(cfg.qmdTierDemotionMinAgeDays))
        : 14,
    qmdTierDemotionValueThreshold:
      typeof cfg.qmdTierDemotionValueThreshold === "number"
        ? Math.max(0, Math.min(1, cfg.qmdTierDemotionValueThreshold))
        : 0.35,
    qmdTierPromotionValueThreshold:
      typeof cfg.qmdTierPromotionValueThreshold === "number"
        ? Math.max(0, Math.min(1, cfg.qmdTierPromotionValueThreshold))
        : 0.7,
    qmdTierParityGraphEnabled: cfg.qmdTierParityGraphEnabled !== false,
    qmdTierParityHiMemEnabled: cfg.qmdTierParityHiMemEnabled !== false,
    qmdTierAutoBackfillEnabled: cfg.qmdTierAutoBackfillEnabled === true,
    embeddingFallbackEnabled: cfg.embeddingFallbackEnabled !== false,
    embeddingFallbackProvider:
      cfg.embeddingFallbackProvider === "openai"
        ? "openai"
        : cfg.embeddingFallbackProvider === "local"
          ? "local"
          : "auto",
    qmdPath:
      typeof cfg.qmdPath === "string" && cfg.qmdPath.length > 0
        ? cfg.qmdPath
        : undefined,
    memoryDir,
    debug: cfg.debug === true,
    identityEnabled: cfg.identityEnabled !== false,
    identityContinuityEnabled,
    identityInjectionMode,
    identityMaxInjectChars:
      typeof cfg.identityMaxInjectChars === "number"
        ? Math.max(0, Math.floor(cfg.identityMaxInjectChars))
        : 1200,
    continuityIncidentLoggingEnabled:
      typeof cfg.continuityIncidentLoggingEnabled === "boolean"
        ? cfg.continuityIncidentLoggingEnabled
        : identityContinuityEnabled,
    continuityAuditEnabled: cfg.continuityAuditEnabled === true,
    sessionObserverEnabled: cfg.sessionObserverEnabled === true,
    sessionObserverDebounceMs:
      typeof cfg.sessionObserverDebounceMs === "number"
        ? Math.max(0, Math.floor(cfg.sessionObserverDebounceMs))
        : 120_000,
    sessionObserverBands,
    injectQuestions: cfg.injectQuestions === true,
    commitmentDecayDays:
      typeof cfg.commitmentDecayDays === "number" ? cfg.commitmentDecayDays : 90,
    workspaceDir:
      typeof cfg.workspaceDir === "string" && cfg.workspaceDir.length > 0
        ? cfg.workspaceDir
        : DEFAULT_WORKSPACE_DIR,
    fileHygiene,
    // Access tracking (Phase 1A)
    accessTrackingEnabled: cfg.accessTrackingEnabled !== false,
    accessTrackingBufferMaxSize:
      typeof cfg.accessTrackingBufferMaxSize === "number"
        ? cfg.accessTrackingBufferMaxSize
        : 100,
    // Retrieval options
    recencyWeight:
      typeof cfg.recencyWeight === "number" ? cfg.recencyWeight : 0.2,
    boostAccessCount: cfg.boostAccessCount !== false,
    recordEmptyRecallImpressions: cfg.recordEmptyRecallImpressions === true,
    // v2.2 Advanced Retrieval (safe defaults: off unless enabled)
    queryExpansionEnabled: cfg.queryExpansionEnabled === true,
    queryExpansionMaxQueries:
      typeof cfg.queryExpansionMaxQueries === "number"
        ? cfg.queryExpansionMaxQueries
        : 4,
    queryExpansionMinTokenLen:
      typeof cfg.queryExpansionMinTokenLen === "number"
        ? cfg.queryExpansionMinTokenLen
        : 3,
    rerankEnabled: cfg.rerankEnabled === true,
    rerankProvider:
      cfg.rerankProvider === "cloud" ? "cloud" : "local",
    rerankMaxCandidates:
      typeof cfg.rerankMaxCandidates === "number" ? cfg.rerankMaxCandidates : 20,
    rerankTimeoutMs:
      typeof cfg.rerankTimeoutMs === "number" ? cfg.rerankTimeoutMs : 8000,
    rerankCacheEnabled: cfg.rerankCacheEnabled !== false,
    rerankCacheTtlMs:
      typeof cfg.rerankCacheTtlMs === "number" ? cfg.rerankCacheTtlMs : 60 * 60 * 1000,
    feedbackEnabled: cfg.feedbackEnabled === true,
    // v2.2 Negative Examples (safe defaults: off unless enabled)
    negativeExamplesEnabled: cfg.negativeExamplesEnabled === true,
    negativeExamplesPenaltyPerHit:
      typeof cfg.negativeExamplesPenaltyPerHit === "number"
        ? cfg.negativeExamplesPenaltyPerHit
        : 0.05,
    negativeExamplesPenaltyCap:
      typeof cfg.negativeExamplesPenaltyCap === "number"
        ? cfg.negativeExamplesPenaltyCap
        : 0.25,
    // Chunking (Phase 2A)
    chunkingEnabled: cfg.chunkingEnabled === true, // Off by default initially
    chunkingTargetTokens:
      typeof cfg.chunkingTargetTokens === "number" ? cfg.chunkingTargetTokens : 200,
    chunkingMinTokens:
      typeof cfg.chunkingMinTokens === "number" ? cfg.chunkingMinTokens : 150,
    chunkingOverlapSentences:
      typeof cfg.chunkingOverlapSentences === "number" ? cfg.chunkingOverlapSentences : 2,
    // Contradiction Detection (Phase 2B)
    contradictionDetectionEnabled: cfg.contradictionDetectionEnabled === true, // Off by default initially
    contradictionSimilarityThreshold:
      typeof cfg.contradictionSimilarityThreshold === "number" ? cfg.contradictionSimilarityThreshold : 0.7,
    contradictionMinConfidence:
      typeof cfg.contradictionMinConfidence === "number" ? cfg.contradictionMinConfidence : 0.9,
    contradictionAutoResolve: cfg.contradictionAutoResolve !== false,
    // Memory Linking (Phase 3A)
    memoryLinkingEnabled: cfg.memoryLinkingEnabled === true, // Off by default initially
    // Conversation Threading (Phase 3B)
    threadingEnabled: cfg.threadingEnabled === true, // Off by default initially
    threadingGapMinutes:
      typeof cfg.threadingGapMinutes === "number" ? cfg.threadingGapMinutes : 30,
    // Memory Summarization (Phase 4A)
    summarizationEnabled: cfg.summarizationEnabled === true, // Off by default
    summarizationTriggerCount:
      typeof cfg.summarizationTriggerCount === "number" ? cfg.summarizationTriggerCount : 1000,
    summarizationRecentToKeep:
      typeof cfg.summarizationRecentToKeep === "number" ? cfg.summarizationRecentToKeep : 300,
    summarizationImportanceThreshold:
      typeof cfg.summarizationImportanceThreshold === "number" ? cfg.summarizationImportanceThreshold : 0.3,
    summarizationProtectedTags: Array.isArray(cfg.summarizationProtectedTags)
      ? (cfg.summarizationProtectedTags as string[])
      : ["commitment", "preference", "decision", "principle"],
    // Topic Extraction (Phase 4B)
    topicExtractionEnabled: cfg.topicExtractionEnabled !== false, // On by default
    topicExtractionTopN:
      typeof cfg.topicExtractionTopN === "number" ? cfg.topicExtractionTopN : 50,
    // Transcript & Context Preservation (v2.0)
    // Transcript archive
    transcriptEnabled: cfg.transcriptEnabled !== false, // default: true
    transcriptRetentionDays:
      typeof cfg.transcriptRetentionDays === "number" ? cfg.transcriptRetentionDays : 7,
    transcriptSkipChannelTypes: Array.isArray(cfg.transcriptSkipChannelTypes)
      ? (cfg.transcriptSkipChannelTypes as string[])
      : ["cron"], // default: skip cron transcripts
    // Transcript injection
    transcriptRecallHours:
      typeof cfg.transcriptRecallHours === "number" ? cfg.transcriptRecallHours : 12,
    maxTranscriptTurns:
      typeof cfg.maxTranscriptTurns === "number" ? cfg.maxTranscriptTurns : 50,
    maxTranscriptTokens:
      typeof cfg.maxTranscriptTokens === "number" ? cfg.maxTranscriptTokens : 1000,
    // Checkpoint
    checkpointEnabled: cfg.checkpointEnabled !== false, // default: true
    checkpointTurns:
      typeof cfg.checkpointTurns === "number" ? cfg.checkpointTurns : 15,
    // Hourly summaries
    hourlySummariesEnabled: cfg.hourlySummariesEnabled !== false, // default: true
    hourlySummaryCronAutoRegister: cfg.hourlySummaryCronAutoRegister === true,
    summaryRecallHours:
      typeof cfg.summaryRecallHours === "number" ? cfg.summaryRecallHours : 24,
    maxSummaryCount:
      typeof cfg.maxSummaryCount === "number" ? cfg.maxSummaryCount : 6,
    summaryModel:
      typeof cfg.summaryModel === "string" && cfg.summaryModel.length > 0
        ? cfg.summaryModel
        : model, // default: same as extraction model
    // v2.4 Extended hourly summaries (default off)
    hourlySummariesExtendedEnabled: cfg.hourlySummariesExtendedEnabled === true,
    hourlySummariesIncludeToolStats: cfg.hourlySummariesIncludeToolStats === true,
    hourlySummariesIncludeSystemMessages: cfg.hourlySummariesIncludeSystemMessages === true,
    hourlySummariesMaxTurnsPerRun:
      typeof cfg.hourlySummariesMaxTurnsPerRun === "number" ? cfg.hourlySummariesMaxTurnsPerRun : 200,
    // v2.4 Conversation index (default off)
    conversationIndexEnabled: cfg.conversationIndexEnabled === true,
    conversationIndexBackend: cfg.conversationIndexBackend === "faiss" ? "faiss" : "qmd",
    conversationIndexQmdCollection:
      typeof cfg.conversationIndexQmdCollection === "string" && cfg.conversationIndexQmdCollection.length > 0
        ? cfg.conversationIndexQmdCollection
        : "openclaw-engram-conversations",
    conversationIndexRetentionDays:
      typeof cfg.conversationIndexRetentionDays === "number" ? cfg.conversationIndexRetentionDays : 30,
    conversationIndexMinUpdateIntervalMs:
      typeof cfg.conversationIndexMinUpdateIntervalMs === "number"
        ? cfg.conversationIndexMinUpdateIntervalMs
        : 15 * 60_000,
    conversationIndexEmbedOnUpdate: cfg.conversationIndexEmbedOnUpdate === true,
    conversationIndexFaissScriptPath:
      typeof cfg.conversationIndexFaissScriptPath === "string" && cfg.conversationIndexFaissScriptPath.trim().length > 0
        ? cfg.conversationIndexFaissScriptPath.trim()
        : undefined,
    conversationIndexFaissPythonBin:
      typeof cfg.conversationIndexFaissPythonBin === "string" && cfg.conversationIndexFaissPythonBin.trim().length > 0
        ? cfg.conversationIndexFaissPythonBin.trim()
        : undefined,
    conversationIndexFaissModelId:
      typeof cfg.conversationIndexFaissModelId === "string" && cfg.conversationIndexFaissModelId.trim().length > 0
        ? cfg.conversationIndexFaissModelId.trim()
        : "text-embedding-3-small",
    conversationIndexFaissIndexDir:
      typeof cfg.conversationIndexFaissIndexDir === "string" && cfg.conversationIndexFaissIndexDir.trim().length > 0
        ? cfg.conversationIndexFaissIndexDir.trim()
        : "state/conversation-index/faiss",
    conversationIndexFaissUpsertTimeoutMs:
      typeof cfg.conversationIndexFaissUpsertTimeoutMs === "number"
        ? Math.max(0, Math.floor(cfg.conversationIndexFaissUpsertTimeoutMs))
        : 30_000,
    conversationIndexFaissSearchTimeoutMs:
      typeof cfg.conversationIndexFaissSearchTimeoutMs === "number"
        ? Math.max(0, Math.floor(cfg.conversationIndexFaissSearchTimeoutMs))
        : 5_000,
    conversationIndexFaissHealthTimeoutMs:
      typeof cfg.conversationIndexFaissHealthTimeoutMs === "number"
        ? Math.max(0, Math.floor(cfg.conversationIndexFaissHealthTimeoutMs))
        : 2_000,
    conversationIndexFaissMaxBatchSize:
      typeof cfg.conversationIndexFaissMaxBatchSize === "number"
        ? Math.max(0, Math.floor(cfg.conversationIndexFaissMaxBatchSize))
        : 512,
    conversationIndexFaissMaxSearchK:
      typeof cfg.conversationIndexFaissMaxSearchK === "number"
        ? Math.max(0, Math.floor(cfg.conversationIndexFaissMaxSearchK))
        : 50,
    conversationRecallTopK:
      typeof cfg.conversationRecallTopK === "number" ? cfg.conversationRecallTopK : 3,
    conversationRecallMaxChars:
      typeof cfg.conversationRecallMaxChars === "number" ? cfg.conversationRecallMaxChars : 2500,
    conversationRecallTimeoutMs:
      typeof cfg.conversationRecallTimeoutMs === "number" ? cfg.conversationRecallTimeoutMs : 800,
    // Local LLM Provider (v2.1)
    localLlmEnabled: cfg.localLlmEnabled === true || cfg.localLlmEnabled === "true", // default: false
    localLlmUrl:
      typeof cfg.localLlmUrl === "string" && cfg.localLlmUrl.length > 0
        ? cfg.localLlmUrl
        : "http://localhost:1234/v1",
    localLlmModel:
      typeof cfg.localLlmModel === "string" && cfg.localLlmModel.length > 0
        ? cfg.localLlmModel
        : "local-model",
    localLlmApiKey:
      typeof cfg.localLlmApiKey === "string" && cfg.localLlmApiKey.length > 0
        ? resolveEnvVars(cfg.localLlmApiKey)
        : undefined,
    localLlmHeaders:
      cfg.localLlmHeaders && typeof cfg.localLlmHeaders === "object" && !Array.isArray(cfg.localLlmHeaders)
        ? Object.fromEntries(
            Object.entries(cfg.localLlmHeaders as Record<string, unknown>)
              .filter(([, value]) => typeof value === "string")
              .map(([key, value]) => [key, String(value)]),
          )
        : undefined,
    localLlmAuthHeader: cfg.localLlmAuthHeader !== false,
    localLlmFallback: cfg.localLlmFallback !== false, // default: true
    localLlmHomeDir:
      typeof cfg.localLlmHomeDir === "string" && cfg.localLlmHomeDir.length > 0
        ? cfg.localLlmHomeDir
        : undefined,
    localLmsCliPath:
      typeof cfg.localLmsCliPath === "string" && cfg.localLmsCliPath.length > 0
        ? cfg.localLmsCliPath
        : undefined,
    localLmsBinDir:
      typeof cfg.localLmsBinDir === "string" && cfg.localLmsBinDir.length > 0
        ? cfg.localLmsBinDir
        : undefined,
    localLlmTimeoutMs:
      typeof cfg.localLlmTimeoutMs === "number" ? cfg.localLlmTimeoutMs : 180_000,
    localLlmMaxContext:
      typeof cfg.localLlmMaxContext === "number" ? cfg.localLlmMaxContext : undefined,
    // Observability (disabled by default to avoid log spam)
    slowLogEnabled: cfg.slowLogEnabled === true,
    slowLogThresholdMs:
      typeof cfg.slowLogThresholdMs === "number" ? cfg.slowLogThresholdMs : 30_000,
    // Extraction stability guards (P0/P1)
    extractionDedupeEnabled: cfg.extractionDedupeEnabled !== false,
    extractionDedupeWindowMs:
      typeof cfg.extractionDedupeWindowMs === "number" ? cfg.extractionDedupeWindowMs : 5 * 60_000,
    extractionMinChars:
      typeof cfg.extractionMinChars === "number" ? cfg.extractionMinChars : 40,
    extractionMinUserTurns:
      typeof cfg.extractionMinUserTurns === "number" ? cfg.extractionMinUserTurns : 1,
    extractionMaxTurnChars:
      typeof cfg.extractionMaxTurnChars === "number" ? cfg.extractionMaxTurnChars : 4000,
    extractionMaxFactsPerRun:
      typeof cfg.extractionMaxFactsPerRun === "number" ? cfg.extractionMaxFactsPerRun : 12,
    extractionMaxEntitiesPerRun:
      typeof cfg.extractionMaxEntitiesPerRun === "number" ? cfg.extractionMaxEntitiesPerRun : 6,
    extractionMaxQuestionsPerRun:
      typeof cfg.extractionMaxQuestionsPerRun === "number" ? cfg.extractionMaxQuestionsPerRun : 3,
    extractionMaxProfileUpdatesPerRun:
      typeof cfg.extractionMaxProfileUpdatesPerRun === "number" ? cfg.extractionMaxProfileUpdatesPerRun : 4,
    consolidationRequireNonZeroExtraction: cfg.consolidationRequireNonZeroExtraction !== false,
    consolidationMinIntervalMs:
      typeof cfg.consolidationMinIntervalMs === "number" ? cfg.consolidationMinIntervalMs : 10 * 60_000,
    // QMD maintenance (debounced singleflight)
    qmdMaintenanceEnabled: cfg.qmdMaintenanceEnabled !== false,
    qmdMaintenanceDebounceMs:
      typeof cfg.qmdMaintenanceDebounceMs === "number" ? cfg.qmdMaintenanceDebounceMs : 30_000,
    qmdAutoEmbedEnabled: cfg.qmdAutoEmbedEnabled === true,
    qmdEmbedMinIntervalMs:
      typeof cfg.qmdEmbedMinIntervalMs === "number" ? cfg.qmdEmbedMinIntervalMs : 60 * 60_000,
    qmdUpdateTimeoutMs:
      typeof cfg.qmdUpdateTimeoutMs === "number" ? cfg.qmdUpdateTimeoutMs : 90_000,
    qmdUpdateMinIntervalMs:
      typeof cfg.qmdUpdateMinIntervalMs === "number" ? cfg.qmdUpdateMinIntervalMs : 15 * 60_000,
    // Local LLM resilience
    localLlmRetry5xxCount:
      typeof cfg.localLlmRetry5xxCount === "number" ? cfg.localLlmRetry5xxCount : 1,
    localLlmRetryBackoffMs:
      typeof cfg.localLlmRetryBackoffMs === "number" ? cfg.localLlmRetryBackoffMs : 400,
    localLlm400TripThreshold:
      typeof cfg.localLlm400TripThreshold === "number" ? cfg.localLlm400TripThreshold : 5,
    localLlm400CooldownMs:
      typeof cfg.localLlm400CooldownMs === "number" ? cfg.localLlm400CooldownMs : 120_000,
    // Gateway config (passed from index.ts for fallback AI)
    gatewayConfig: cfg.gatewayConfig as PluginConfig["gatewayConfig"],

    // v3.0 namespaces (default off)
    namespacesEnabled: cfg.namespacesEnabled === true,
    defaultNamespace:
      typeof cfg.defaultNamespace === "string" && cfg.defaultNamespace.length > 0 ? cfg.defaultNamespace : "default",
    sharedNamespace:
      typeof cfg.sharedNamespace === "string" && cfg.sharedNamespace.length > 0 ? cfg.sharedNamespace : "shared",
    principalFromSessionKeyMode:
      cfg.principalFromSessionKeyMode === "prefix"
        ? "prefix"
        : cfg.principalFromSessionKeyMode === "regex"
          ? "regex"
          : "map",
    principalFromSessionKeyRules: principalRules,
    namespacePolicies: Array.isArray(cfg.namespacePolicies)
      ? (cfg.namespacePolicies as any[]).map((p) => ({
          name: typeof p?.name === "string" ? p.name : "",
          readPrincipals: Array.isArray(p?.readPrincipals) ? p.readPrincipals.filter((x: any) => typeof x === "string") : [],
          writePrincipals: Array.isArray(p?.writePrincipals) ? p.writePrincipals.filter((x: any) => typeof x === "string") : [],
          includeInRecallByDefault: p?.includeInRecallByDefault === true,
        })).filter((p) => p.name.length > 0)
      : [],
    defaultRecallNamespaces: Array.isArray(cfg.defaultRecallNamespaces) ? ["self", "shared"].filter((x) => (cfg.defaultRecallNamespaces as any[]).includes(x)) as any : ["self", "shared"],
    cronRecallMode:
      cfg.cronRecallMode === "none"
        ? "none"
        : cfg.cronRecallMode === "allowlist"
          ? "allowlist"
          : "all",
    cronRecallAllowlist: Array.isArray(cfg.cronRecallAllowlist)
      ? (cfg.cronRecallAllowlist as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
      : [],
    cronRecallPolicyEnabled: cfg.cronRecallPolicyEnabled !== false,
    cronRecallNormalizedQueryMaxChars:
      typeof cfg.cronRecallNormalizedQueryMaxChars === "number"
        ? cfg.cronRecallNormalizedQueryMaxChars
        : 480,
    cronRecallInstructionHeavyTokenCap:
      typeof cfg.cronRecallInstructionHeavyTokenCap === "number"
        ? cfg.cronRecallInstructionHeavyTokenCap
        : 36,
    cronConversationRecallMode:
      cfg.cronConversationRecallMode === "always"
        ? "always"
        : cfg.cronConversationRecallMode === "never"
          ? "never"
          : "auto",
    autoPromoteToSharedEnabled: cfg.autoPromoteToSharedEnabled === true,
    autoPromoteToSharedCategories: Array.isArray(cfg.autoPromoteToSharedCategories)
      ? (cfg.autoPromoteToSharedCategories as any[]).filter((c) => c === "correction" || c === "decision" || c === "preference")
      : ["correction", "decision", "preference"],
    autoPromoteMinConfidenceTier:
      cfg.autoPromoteMinConfidenceTier === "explicit"
        ? "explicit"
        : cfg.autoPromoteMinConfidenceTier === "implied"
          ? "implied"
          : "explicit",
    routingRulesEnabled: cfg.routingRulesEnabled === true,
    routingRulesStateFile:
      typeof cfg.routingRulesStateFile === "string" && cfg.routingRulesStateFile.trim().length > 0
        ? cfg.routingRulesStateFile.trim()
        : "state/routing-rules.json",

    // v4.0 shared-context (default off)
    sharedContextEnabled: cfg.sharedContextEnabled === true,
    sharedContextDir:
      typeof cfg.sharedContextDir === "string" && cfg.sharedContextDir.length > 0 ? cfg.sharedContextDir : undefined,
    sharedContextMaxInjectChars:
      typeof cfg.sharedContextMaxInjectChars === "number" ? cfg.sharedContextMaxInjectChars : 4000,
    sharedCrossSignalSemanticEnabled,
    sharedCrossSignalSemanticTimeoutMs,
    sharedCrossSignalSemanticMaxCandidates:
      typeof cfg.sharedCrossSignalSemanticMaxCandidates === "number"
        ? Math.max(0, Math.floor(cfg.sharedCrossSignalSemanticMaxCandidates))
        : 120,
    // Backward-compatible aliases.
    crossSignalsSemanticEnabled: sharedCrossSignalSemanticEnabled,
    crossSignalsSemanticTimeoutMs: sharedCrossSignalSemanticTimeoutMs,

    // v5.0 compounding (default off)
    compoundingEnabled: cfg.compoundingEnabled === true,
    compoundingWeeklyCronEnabled: cfg.compoundingWeeklyCronEnabled === true,
    compoundingSemanticEnabled: cfg.compoundingSemanticEnabled === true,
    compoundingSynthesisTimeoutMs:
      typeof cfg.compoundingSynthesisTimeoutMs === "number" ? cfg.compoundingSynthesisTimeoutMs : 15_000,
    compoundingInjectEnabled: cfg.compoundingInjectEnabled !== false,

    // v7.0 Knowledge Graph Enhancement
    knowledgeIndexEnabled: cfg.knowledgeIndexEnabled !== false,
    knowledgeIndexMaxEntities:
      typeof cfg.knowledgeIndexMaxEntities === "number" ? cfg.knowledgeIndexMaxEntities : 40,
    knowledgeIndexMaxChars:
      typeof cfg.knowledgeIndexMaxChars === "number" ? cfg.knowledgeIndexMaxChars : 4000,
    recallBudgetChars: recallPipelineConfig.recallBudgetChars,
    recallPipeline: recallPipelineConfig.pipeline,
    entityRelationshipsEnabled: cfg.entityRelationshipsEnabled !== false,
    entityActivityLogEnabled: cfg.entityActivityLogEnabled !== false,
    entityActivityLogMaxEntries:
      typeof cfg.entityActivityLogMaxEntries === "number" ? cfg.entityActivityLogMaxEntries : 20,
    entityAliasesEnabled: cfg.entityAliasesEnabled !== false,
    entitySummaryEnabled: cfg.entitySummaryEnabled !== false,

    // Search backend abstraction
    searchBackend: (["qmd", "remote", "noop", "lancedb", "meilisearch", "orama"] as const).includes(cfg.searchBackend as any)
      ? (cfg.searchBackend as "qmd" | "remote" | "noop" | "lancedb" | "meilisearch" | "orama")
      : "qmd",
    remoteSearchBaseUrl: typeof cfg.remoteSearchBaseUrl === "string" ? cfg.remoteSearchBaseUrl : undefined,
    remoteSearchApiKey: typeof cfg.remoteSearchApiKey === "string" ? cfg.remoteSearchApiKey : undefined,
    remoteSearchTimeoutMs: typeof cfg.remoteSearchTimeoutMs === "number" ? cfg.remoteSearchTimeoutMs : 30_000,

    // LanceDB backend
    lanceDbPath: typeof cfg.lanceDbPath === "string" ? cfg.lanceDbPath : path.join(memoryDir, "lancedb"),
    lanceEmbeddingDimension: typeof cfg.lanceEmbeddingDimension === "number" ? cfg.lanceEmbeddingDimension : 1536,

    // Meilisearch backend
    meilisearchHost: typeof cfg.meilisearchHost === "string" ? cfg.meilisearchHost : "http://localhost:7700",
    meilisearchApiKey: typeof cfg.meilisearchApiKey === "string" ? cfg.meilisearchApiKey : undefined,
    meilisearchTimeoutMs: typeof cfg.meilisearchTimeoutMs === "number" ? cfg.meilisearchTimeoutMs : 30_000,
    meilisearchAutoIndex: cfg.meilisearchAutoIndex === true,

    // Orama backend
    oramaDbPath: typeof cfg.oramaDbPath === "string" ? cfg.oramaDbPath : path.join(memoryDir, "orama"),
    oramaEmbeddingDimension: typeof cfg.oramaEmbeddingDimension === "number" ? cfg.oramaEmbeddingDimension : 1536,

    // QMD daemon mode
    qmdDaemonEnabled: cfg.qmdDaemonEnabled !== false,
    qmdDaemonUrl:
      typeof cfg.qmdDaemonUrl === "string" && cfg.qmdDaemonUrl.length > 0
        ? cfg.qmdDaemonUrl
        : "http://localhost:8181/mcp",
    qmdDaemonRecheckIntervalMs:
      typeof cfg.qmdDaemonRecheckIntervalMs === "number" ? cfg.qmdDaemonRecheckIntervalMs : 60_000,

    // v6.0 Fact deduplication & archival
    factDeduplicationEnabled: cfg.factDeduplicationEnabled !== false,
    factArchivalEnabled: cfg.factArchivalEnabled === true,
    factArchivalAgeDays:
      typeof cfg.factArchivalAgeDays === "number" ? cfg.factArchivalAgeDays : 90,
    factArchivalMaxImportance:
      typeof cfg.factArchivalMaxImportance === "number" ? cfg.factArchivalMaxImportance : 0.3,
    factArchivalMaxAccessCount:
      typeof cfg.factArchivalMaxAccessCount === "number" ? cfg.factArchivalMaxAccessCount : 2,
    factArchivalProtectedCategories: Array.isArray(cfg.factArchivalProtectedCategories)
      ? (cfg.factArchivalProtectedCategories as any[]).filter((c) => typeof c === "string")
      : ["commitment", "preference", "decision", "principle"],
    // v8.3 lifecycle policy engine (default off)
    lifecyclePolicyEnabled: cfg.lifecyclePolicyEnabled === true,
    lifecycleFilterStaleEnabled: cfg.lifecycleFilterStaleEnabled === true,
    lifecyclePromoteHeatThreshold:
      typeof cfg.lifecyclePromoteHeatThreshold === "number"
        ? Math.min(1, Math.max(0, cfg.lifecyclePromoteHeatThreshold))
        : 0.55,
    lifecycleStaleDecayThreshold:
      typeof cfg.lifecycleStaleDecayThreshold === "number"
        ? Math.min(1, Math.max(0, cfg.lifecycleStaleDecayThreshold))
        : 0.65,
    lifecycleArchiveDecayThreshold:
      typeof cfg.lifecycleArchiveDecayThreshold === "number"
        ? Math.min(1, Math.max(0, cfg.lifecycleArchiveDecayThreshold))
        : 0.85,
    lifecycleProtectedCategories: Array.isArray(cfg.lifecycleProtectedCategories)
      ? (cfg.lifecycleProtectedCategories as any[]).filter(
          (c): c is PluginConfig["lifecycleProtectedCategories"][number] =>
            typeof c === "string" && VALID_MEMORY_CATEGORIES.has(c),
        )
      : ["decision", "principle", "commitment", "preference"],
    lifecycleMetricsEnabled:
      typeof cfg.lifecycleMetricsEnabled === "boolean"
        ? cfg.lifecycleMetricsEnabled
        : cfg.lifecyclePolicyEnabled === true,
    // v8.3 proactive + policy learning (default off)
    proactiveExtractionEnabled: cfg.proactiveExtractionEnabled === true,
    contextCompressionActionsEnabled: cfg.contextCompressionActionsEnabled === true,
    compressionGuidelineLearningEnabled: cfg.compressionGuidelineLearningEnabled === true,
    compressionGuidelineSemanticRefinementEnabled:
      cfg.compressionGuidelineSemanticRefinementEnabled === true,
    compressionGuidelineSemanticTimeoutMs:
      typeof cfg.compressionGuidelineSemanticTimeoutMs === "number"
        ? Math.max(1, Math.floor(cfg.compressionGuidelineSemanticTimeoutMs))
        : 2500,
    maxProactiveQuestionsPerExtraction:
      typeof cfg.maxProactiveQuestionsPerExtraction === "number"
        ? Math.max(0, Math.floor(cfg.maxProactiveQuestionsPerExtraction))
        : 2,
    maxCompressionTokensPerHour:
      typeof cfg.maxCompressionTokensPerHour === "number"
        ? Math.max(0, Math.floor(cfg.maxCompressionTokensPerHour))
        : 1500,
    behaviorLoopAutoTuneEnabled: cfg.behaviorLoopAutoTuneEnabled === true,
    behaviorLoopLearningWindowDays:
      typeof cfg.behaviorLoopLearningWindowDays === "number"
        ? Math.max(0, Math.floor(cfg.behaviorLoopLearningWindowDays))
        : 14,
    behaviorLoopMinSignalCount:
      typeof cfg.behaviorLoopMinSignalCount === "number"
        ? Math.max(0, Math.floor(cfg.behaviorLoopMinSignalCount))
        : 10,
    behaviorLoopMaxDeltaPerCycle:
      typeof cfg.behaviorLoopMaxDeltaPerCycle === "number"
        ? Math.min(1, Math.max(0, cfg.behaviorLoopMaxDeltaPerCycle))
        : 0.1,
    behaviorLoopProtectedParams: Array.isArray(cfg.behaviorLoopProtectedParams)
      ? (cfg.behaviorLoopProtectedParams as unknown[])
          .filter((param): param is string => typeof param === "string" && param.trim().length > 0)
      : [...DEFAULT_BEHAVIOR_LOOP_PROTECTED_PARAMS],
    // v8.0 phase 1
    recallPlannerEnabled: cfg.recallPlannerEnabled !== false,
    recallPlannerMaxQmdResultsMinimal:
      typeof cfg.recallPlannerMaxQmdResultsMinimal === "number"
        ? cfg.recallPlannerMaxQmdResultsMinimal
        : 4,
    intentRoutingEnabled: cfg.intentRoutingEnabled === true,
    intentRoutingBoost:
      typeof cfg.intentRoutingBoost === "number" ? cfg.intentRoutingBoost : 0.12,
    verbatimArtifactsEnabled: cfg.verbatimArtifactsEnabled === true,
    verbatimArtifactsMinConfidence:
      typeof cfg.verbatimArtifactsMinConfidence === "number"
        ? cfg.verbatimArtifactsMinConfidence
        : 0.8,
    verbatimArtifactsMaxRecall:
      typeof cfg.verbatimArtifactsMaxRecall === "number" ? cfg.verbatimArtifactsMaxRecall : 5,
    verbatimArtifactCategories: Array.isArray(cfg.verbatimArtifactCategories)
      ? (cfg.verbatimArtifactCategories as any[]).filter(
          (c): c is PluginConfig["verbatimArtifactCategories"][number] =>
            typeof c === "string" && VALID_MEMORY_CATEGORIES.has(c),
        )
      : ["decision", "correction", "principle", "commitment"],
    // v8.0 Phase 2A: Memory Boxes + Trace Weaving
    memoryBoxesEnabled: cfg.memoryBoxesEnabled === true,
    boxTopicShiftThreshold:
      typeof cfg.boxTopicShiftThreshold === "number" ? cfg.boxTopicShiftThreshold : 0.35,
    boxTimeGapMs:
      typeof cfg.boxTimeGapMs === "number" ? cfg.boxTimeGapMs : 30 * 60 * 1000,
    boxMaxMemories:
      typeof cfg.boxMaxMemories === "number" ? cfg.boxMaxMemories : 50,
    traceWeaverEnabled: cfg.traceWeaverEnabled === true,
    traceWeaverLookbackDays:
      typeof cfg.traceWeaverLookbackDays === "number" ? cfg.traceWeaverLookbackDays : 7,
    traceWeaverOverlapThreshold:
      typeof cfg.traceWeaverOverlapThreshold === "number" ? cfg.traceWeaverOverlapThreshold : 0.4,
    boxRecallDays:
      typeof cfg.boxRecallDays === "number" ? cfg.boxRecallDays : 3,
    // v8.0 Phase 2B: Episode/Note dual store (HiMem)
    episodeNoteModeEnabled: cfg.episodeNoteModeEnabled === true,
    // v8.1: Temporal + Tag Indexes (SwiftMem-inspired)
    queryAwareIndexingEnabled: cfg.queryAwareIndexingEnabled === true,
    queryAwareIndexingMaxCandidates:
      typeof cfg.queryAwareIndexingMaxCandidates === "number"
        ? Math.max(0, cfg.queryAwareIndexingMaxCandidates) // clamp: negative treated as 0 (no cap)
        : 200,
    // v8.2: Multi-graph memory (PR 18)
    multiGraphMemoryEnabled: cfg.multiGraphMemoryEnabled === true,
    graphRecallEnabled: cfg.graphRecallEnabled === true,
    graphExpandedIntentEnabled: cfg.graphExpandedIntentEnabled !== false,
    graphAssistInFullModeEnabled: cfg.graphAssistInFullModeEnabled !== false,
    graphAssistShadowEvalEnabled: cfg.graphAssistShadowEvalEnabled === true,
    graphAssistMinSeedResults:
      typeof cfg.graphAssistMinSeedResults === "number"
        ? Math.max(1, Math.floor(cfg.graphAssistMinSeedResults))
        : 3,
    entityGraphEnabled: cfg.entityGraphEnabled !== false,
    timeGraphEnabled: cfg.timeGraphEnabled !== false,
    graphWriteSessionAdjacencyEnabled: cfg.graphWriteSessionAdjacencyEnabled !== false,
    causalGraphEnabled: cfg.causalGraphEnabled !== false,
    maxGraphTraversalSteps:
      typeof cfg.maxGraphTraversalSteps === "number" ? Math.max(0, cfg.maxGraphTraversalSteps) : 3,
    graphActivationDecay:
      typeof cfg.graphActivationDecay === "number"
        ? Math.min(1, Math.max(0, cfg.graphActivationDecay))
        : 0.7,
    graphExpansionActivationWeight:
      typeof cfg.graphExpansionActivationWeight === "number"
        ? Math.min(1, Math.max(0, cfg.graphExpansionActivationWeight))
        : 0.65,
    graphExpansionBlendMin:
      typeof cfg.graphExpansionBlendMin === "number"
        ? Math.min(1, Math.max(0, cfg.graphExpansionBlendMin))
        : 0.05,
    graphExpansionBlendMax:
      typeof cfg.graphExpansionBlendMax === "number"
        ? Math.min(1, Math.max(0, cfg.graphExpansionBlendMax))
        : 0.95,
    maxEntityGraphEdgesPerMemory:
      typeof cfg.maxEntityGraphEdgesPerMemory === "number"
        ? Math.max(0, cfg.maxEntityGraphEdgesPerMemory)
        : 10,
    // v8.2: Temporal Memory Tree
    temporalMemoryTreeEnabled: cfg.temporalMemoryTreeEnabled === true,
    tmtHourlyMinMemories:
      typeof cfg.tmtHourlyMinMemories === "number" ? cfg.tmtHourlyMinMemories : 3,
    tmtSummaryMaxTokens:
      typeof cfg.tmtSummaryMaxTokens === "number" ? cfg.tmtSummaryMaxTokens : 300,
  };
}

function clampNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function parseRecallSectionEntry(raw: unknown): RecallSectionConfig {
  const entry =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    id: typeof entry.id === "string" ? entry.id.trim() : "",
    enabled: entry.enabled !== false,
    maxChars:
      entry.maxChars === null
        ? null
        : clampNonNegativeNumber(entry.maxChars),
    consolidateTriggerLines: clampNonNegativeNumber(entry.consolidateTriggerLines),
    consolidateTargetLines: clampNonNegativeNumber(entry.consolidateTargetLines),
    maxEntities: clampNonNegativeNumber(entry.maxEntities),
    maxResults: clampNonNegativeNumber(entry.maxResults),
    maxTurns: clampNonNegativeNumber(entry.maxTurns),
    maxTokens: clampNonNegativeNumber(entry.maxTokens),
    lookbackHours: clampNonNegativeNumber(entry.lookbackHours),
    maxCount: clampNonNegativeNumber(entry.maxCount),
    topK: clampNonNegativeNumber(entry.topK),
    timeoutMs: clampNonNegativeNumber(entry.timeoutMs),
    maxPatterns: clampNonNegativeNumber(entry.maxPatterns),
  };
}

function buildDefaultRecallPipeline(cfg: Record<string, unknown>): RecallSectionConfig[] {
  return [
    {
      id: "shared-context",
      enabled: cfg.sharedContextEnabled === true,
      maxChars:
        typeof cfg.sharedContextMaxInjectChars === "number"
          ? Math.max(0, Math.floor(cfg.sharedContextMaxInjectChars))
          : 4000,
    },
    {
      id: "profile",
      enabled: true,
      consolidateTriggerLines: 100,
      consolidateTargetLines: 50,
    },
    {
      id: "identity-continuity",
      enabled: cfg.identityContinuityEnabled === true,
    },
    {
      id: "knowledge-index",
      enabled: cfg.knowledgeIndexEnabled !== false,
      maxChars:
        typeof cfg.knowledgeIndexMaxChars === "number"
          ? Math.max(0, Math.floor(cfg.knowledgeIndexMaxChars))
          : 4000,
      maxEntities:
        typeof cfg.knowledgeIndexMaxEntities === "number"
          ? Math.max(0, Math.floor(cfg.knowledgeIndexMaxEntities))
          : 40,
    },
    { id: "verbatim-artifacts", enabled: cfg.verbatimArtifactsEnabled === true },
    { id: "memory-boxes", enabled: cfg.memoryBoxesEnabled === true },
    { id: "temporal-memory-tree", enabled: cfg.temporalMemoryTreeEnabled === true },
    {
      id: "memories",
      enabled: true,
      maxResults:
        typeof cfg.qmdMaxResults === "number"
          ? Math.max(0, Math.floor(cfg.qmdMaxResults))
          : 8,
    },
    {
      id: "compression-guidelines",
      enabled: cfg.compressionGuidelineLearningEnabled === true,
    },
    {
      id: "transcript",
      enabled: cfg.transcriptEnabled !== false,
      maxTurns:
        typeof cfg.maxTranscriptTurns === "number"
          ? Math.max(0, Math.floor(cfg.maxTranscriptTurns))
          : 50,
      maxTokens:
        typeof cfg.maxTranscriptTokens === "number"
          ? Math.max(0, Math.floor(cfg.maxTranscriptTokens))
          : 1000,
      lookbackHours:
        typeof cfg.transcriptRecallHours === "number"
          ? Math.max(0, Math.floor(cfg.transcriptRecallHours))
          : 12,
    },
    {
      id: "summaries",
      enabled: cfg.hourlySummariesEnabled !== false,
      maxCount:
        typeof cfg.maxSummaryCount === "number"
          ? Math.max(0, Math.floor(cfg.maxSummaryCount))
          : 6,
      lookbackHours:
        typeof cfg.summaryRecallHours === "number"
          ? Math.max(0, Math.floor(cfg.summaryRecallHours))
          : 24,
    },
    {
      id: "conversation-recall",
      enabled: cfg.conversationIndexEnabled === true,
      topK:
        typeof cfg.conversationRecallTopK === "number"
          ? Math.max(0, Math.floor(cfg.conversationRecallTopK))
          : 3,
      maxChars:
        typeof cfg.conversationRecallMaxChars === "number"
          ? Math.max(0, Math.floor(cfg.conversationRecallMaxChars))
          : 2500,
      timeoutMs:
        typeof cfg.conversationRecallTimeoutMs === "number"
          ? Math.max(0, Math.floor(cfg.conversationRecallTimeoutMs))
          : 800,
    },
    {
      id: "compounding",
      enabled: cfg.compoundingEnabled === true && cfg.compoundingInjectEnabled !== false,
      maxPatterns: 40,
    },
    { id: "questions", enabled: cfg.injectQuestions === true },
  ];
}

function buildRecallPipelineConfig(cfg: Record<string, unknown>): RecallPipelineConfig {
  const maxMemoryTokens =
    typeof cfg.maxMemoryTokens === "number"
      ? Math.max(0, Math.floor(cfg.maxMemoryTokens))
      : 2000;
  const recallBudgetCharsRaw = clampNonNegativeNumber(cfg.recallBudgetChars);
  const recallBudgetChars = recallBudgetCharsRaw ?? maxMemoryTokens * 4;

  const rawPipeline = cfg.recallPipeline;
  const pipeline = Array.isArray(rawPipeline)
    ? rawPipeline.map(parseRecallSectionEntry).filter((entry) => entry.id.length > 0)
    : buildDefaultRecallPipeline(cfg);

  return { recallBudgetChars, pipeline };
}
