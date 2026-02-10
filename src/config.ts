import path from "node:path";
import type { PluginConfig, ReasoningEffort, TriggerMode } from "./types.js";

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

const VALID_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];
const VALID_TRIGGERS: TriggerMode[] = ["smart", "every_n", "time_based"];

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

  return {
    openaiApiKey: apiKey,
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
    summaryRecallHours:
      typeof cfg.summaryRecallHours === "number" ? cfg.summaryRecallHours : 24,
    maxSummaryCount:
      typeof cfg.maxSummaryCount === "number" ? cfg.maxSummaryCount : 6,
    summaryModel:
      typeof cfg.summaryModel === "string" && cfg.summaryModel.length > 0
        ? cfg.summaryModel
        : model, // default: same as extraction model
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
    localLlmFallback: cfg.localLlmFallback !== false, // default: true
    localLlmTimeoutMs:
      typeof cfg.localLlmTimeoutMs === "number" ? cfg.localLlmTimeoutMs : 180_000,
    localLlmMaxContext:
      typeof cfg.localLlmMaxContext === "number" ? cfg.localLlmMaxContext : undefined,
    // Observability (disabled by default to avoid log spam)
    slowLogEnabled: cfg.slowLogEnabled === true,
    slowLogThresholdMs:
      typeof cfg.slowLogThresholdMs === "number" ? cfg.slowLogThresholdMs : 30_000,
    // Gateway config (passed from index.ts for fallback AI)
    gatewayConfig: cfg.gatewayConfig as PluginConfig["gatewayConfig"],
  };
}
