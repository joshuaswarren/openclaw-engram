import path from "node:path";
import type { PluginConfig, PrincipalRule, ReasoningEffort, TriggerMode } from "./types.js";
import { log } from "./logger.js";

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

    // v4.0 shared-context (default off)
    sharedContextEnabled: cfg.sharedContextEnabled === true,
    sharedContextDir:
      typeof cfg.sharedContextDir === "string" && cfg.sharedContextDir.length > 0 ? cfg.sharedContextDir : undefined,
    sharedContextMaxInjectChars:
      typeof cfg.sharedContextMaxInjectChars === "number" ? cfg.sharedContextMaxInjectChars : 4000,
    crossSignalsSemanticEnabled: cfg.crossSignalsSemanticEnabled === true,
    crossSignalsSemanticTimeoutMs:
      typeof cfg.crossSignalsSemanticTimeoutMs === "number" ? cfg.crossSignalsSemanticTimeoutMs : 4000,

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
    entityRelationshipsEnabled: cfg.entityRelationshipsEnabled !== false,
    entityActivityLogEnabled: cfg.entityActivityLogEnabled !== false,
    entityActivityLogMaxEntries:
      typeof cfg.entityActivityLogMaxEntries === "number" ? cfg.entityActivityLogMaxEntries : 20,
    entityAliasesEnabled: cfg.entityAliasesEnabled !== false,
    entitySummaryEnabled: cfg.entitySummaryEnabled !== false,

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
  };
}
