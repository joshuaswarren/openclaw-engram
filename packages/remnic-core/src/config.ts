import path from "node:path";
import type {
  IdentityInjectionMode,
  MemoryOsPresetName,
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
import { readEnvVar, resolveHomeDir } from "./runtime/env.js";

const DEFAULT_MEMORY_DIR = path.join(
  resolveHomeDir(),
  ".openclaw",
  "workspace",
  "memory",
  "local",
);

const DEFAULT_WORKSPACE_DIR = path.join(
  resolveHomeDir(),
  ".openclaw",
  "workspace",
);

function resolveEnvVars(value: string): string {
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, envVar: string) => {
    const envValue = readEnvVar(envVar);
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
  const remaining = resolved.match(/\$\{[^}]*\}/);
  if (remaining) {
    throw new Error(`Malformed environment variable placeholder: ${remaining[0]}`);
  }
  return resolved;
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
  let url = parsed.toString();
  while (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

function normalizeMemoryRelativeDir(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;

  const normalized = trimmed
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
  return normalized.length > 0 ? normalized : fallback;
}

const VALID_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];
const VALID_TRIGGERS: TriggerMode[] = ["smart", "every_n", "time_based"];
const VALID_IDENTITY_INJECTION_MODES: IdentityInjectionMode[] = ["recovery_only", "minimal", "full"];
const VALID_MEMORY_OS_PRESETS: MemoryOsPresetName[] = [
  "conservative",
  "balanced",
  "research-max",
  "local-llm-heavy",
];
export const VALID_MEMORY_CATEGORIES = new Set([
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
  "rule",
]);

const DEFAULT_BEHAVIOR_LOOP_PROTECTED_PARAMS = [
  "maxMemoryTokens",
  "qmdMaxResults",
  "qmdColdMaxResults",
  "recallPlannerMaxQmdResultsMinimal",
  "verbatimArtifactsMaxRecall",
];

const MEMORY_OS_PRESET_ALIASES: Record<string, MemoryOsPresetName> = {
  research: "research-max",
};

const MEMORY_OS_PRESETS: Record<MemoryOsPresetName, Record<string, unknown>> = {
  conservative: {
    maxMemoryTokens: 1500,
    recallPlannerMaxQmdResultsMinimal: 2,
    recallPlannerMaxQmdResultsFull: 5,
    queryAwareIndexingEnabled: false,
    verbatimArtifactsEnabled: false,
    verbatimArtifactsMaxRecall: 2,
    rerankEnabled: false,
    localLlmEnabled: false,
    localLlmFastEnabled: false,
    multiGraphMemoryEnabled: false,
    graphRecallEnabled: false,
    graphAssistInFullModeEnabled: false,
    proactiveExtractionEnabled: false,
    contextCompressionActionsEnabled: false,
    compressionGuidelineLearningEnabled: false,
    compressionGuidelineSemanticRefinementEnabled: false,
    maxProactiveQuestionsPerExtraction: 0,
    maxCompressionTokensPerHour: 0,
    behaviorLoopAutoTuneEnabled: false,
  },
  balanced: {
    maxMemoryTokens: 2000,
    recallPlannerMaxQmdResultsMinimal: 4,
    recallPlannerMaxQmdResultsFull: 8,
    queryAwareIndexingEnabled: true,
    verbatimArtifactsEnabled: true,
    verbatimArtifactsMaxRecall: 4,
    rerankEnabled: true,
    rerankProvider: "local",
    localLlmEnabled: false,
    localLlmFastEnabled: false,
    multiGraphMemoryEnabled: false,
    graphRecallEnabled: false,
    graphAssistInFullModeEnabled: false,
    proactiveExtractionEnabled: false,
    contextCompressionActionsEnabled: false,
    compressionGuidelineLearningEnabled: false,
    compressionGuidelineSemanticRefinementEnabled: false,
    maxProactiveQuestionsPerExtraction: 2,
    maxCompressionTokensPerHour: 1500,
    behaviorLoopAutoTuneEnabled: false,
  },
  "research-max": {
    maxMemoryTokens: 3200,
    recallPlannerMaxQmdResultsMinimal: 6,
    recallPlannerMaxQmdResultsFull: 12,
    queryAwareIndexingEnabled: true,
    verbatimArtifactsEnabled: true,
    verbatimArtifactsMaxRecall: 6,
    rerankEnabled: true,
    rerankProvider: "local",
    localLlmEnabled: false,
    localLlmFastEnabled: false,
    multiGraphMemoryEnabled: true,
    graphRecallEnabled: true,
    graphAssistInFullModeEnabled: true,
    proactiveExtractionEnabled: true,
    contextCompressionActionsEnabled: true,
    compressionGuidelineLearningEnabled: true,
    compressionGuidelineSemanticRefinementEnabled: true,
    maxProactiveQuestionsPerExtraction: 4,
    maxCompressionTokensPerHour: 3000,
    behaviorLoopAutoTuneEnabled: true,
  },
  "local-llm-heavy": {
    maxMemoryTokens: 2400,
    recallPlannerMaxQmdResultsMinimal: 4,
    recallPlannerMaxQmdResultsFull: 8,
    queryAwareIndexingEnabled: true,
    verbatimArtifactsEnabled: true,
    verbatimArtifactsMaxRecall: 4,
    rerankEnabled: true,
    rerankProvider: "local",
    localLlmEnabled: true,
    localLlmFastEnabled: true,
    embeddingFallbackProvider: "local",
    localLlmFallback: true,
    multiGraphMemoryEnabled: false,
    graphRecallEnabled: false,
    graphAssistInFullModeEnabled: false,
    proactiveExtractionEnabled: true,
    contextCompressionActionsEnabled: true,
    compressionGuidelineLearningEnabled: true,
    compressionGuidelineSemanticRefinementEnabled: false,
    maxProactiveQuestionsPerExtraction: 2,
    maxCompressionTokensPerHour: 1500,
    behaviorLoopAutoTuneEnabled: false,
  },
};

function resolveMemoryOsPreset(value: unknown): MemoryOsPresetName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (VALID_MEMORY_OS_PRESETS.includes(normalized as MemoryOsPresetName)) {
    return normalized as MemoryOsPresetName;
  }
  return MEMORY_OS_PRESET_ALIASES[normalized];
}

export function parseConfig(raw: unknown): PluginConfig {
  const baseCfg =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const memoryOsPreset = resolveMemoryOsPreset(baseCfg.memoryOsPreset);
  const cfg = memoryOsPreset
    ? {
        ...MEMORY_OS_PRESETS[memoryOsPreset],
        ...baseCfg,
        memoryOsPreset,
      }
    : baseCfg;

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
  const captureMode =
    cfg.captureMode === "explicit" || cfg.captureMode === "hybrid"
      ? cfg.captureMode
      : "implicit";

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

  const rawNativeKnowledge =
    cfg.nativeKnowledge && typeof cfg.nativeKnowledge === "object" && !Array.isArray(cfg.nativeKnowledge)
      ? (cfg.nativeKnowledge as Record<string, unknown>)
      : undefined;
  const nativeKnowledge = rawNativeKnowledge?.enabled === true
    ? {
        enabled: true,
        includeFiles: Array.isArray(rawNativeKnowledge.includeFiles)
          ? (rawNativeKnowledge.includeFiles as unknown[])
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
          : ["IDENTITY.md", "MEMORY.md"],
        maxChunkChars:
          typeof rawNativeKnowledge.maxChunkChars === "number"
            ? Math.max(200, Math.floor(rawNativeKnowledge.maxChunkChars))
            : 900,
        maxResults:
          typeof rawNativeKnowledge.maxResults === "number"
            ? Math.max(0, Math.floor(rawNativeKnowledge.maxResults))
            : 4,
        maxChars:
          typeof rawNativeKnowledge.maxChars === "number"
            ? Math.max(0, Math.floor(rawNativeKnowledge.maxChars))
            : 2400,
        stateDir:
          normalizeMemoryRelativeDir(rawNativeKnowledge.stateDir, "state/native-knowledge"),
        openclawWorkspace:
          rawNativeKnowledge.openclawWorkspace &&
            typeof rawNativeKnowledge.openclawWorkspace === "object" &&
            !Array.isArray(rawNativeKnowledge.openclawWorkspace) &&
            (rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).enabled === true
            ? {
              enabled: true,
              bootstrapFiles: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).bootstrapFiles)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).bootstrapFiles as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : ["IDENTITY.md", "MEMORY.md", "USER.md"],
              handoffGlobs: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).handoffGlobs)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).handoffGlobs as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : ["**/*handoff*.md", "handoffs/**/*.md"],
              dailySummaryGlobs: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).dailySummaryGlobs)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).dailySummaryGlobs as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : ["**/*daily*summary*.md", "summaries/**/*.md"],
              automationNoteGlobs: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).automationNoteGlobs)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).automationNoteGlobs as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : [],
              workspaceDocGlobs: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).workspaceDocGlobs)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).workspaceDocGlobs as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : [],
              excludeGlobs: [
                ".git/**",
                "node_modules/**",
                "dist/**",
                "build/**",
                "coverage/**",
                "**/*.log",
                "**/.env*",
                "**/*.pem",
                "**/*.key",
                ...(Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).excludeGlobs)
                  ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).excludeGlobs as unknown[])
                    .filter((value): value is string => typeof value === "string")
                    .map((value) => value.trim())
                    .filter(Boolean)
                  : []),
              ].filter((value, index, array) => array.indexOf(value) === index),
              sharedSafeGlobs: Array.isArray((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).sharedSafeGlobs)
                ? ((rawNativeKnowledge.openclawWorkspace as Record<string, unknown>).sharedSafeGlobs as unknown[])
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter(Boolean)
                : [],
            }
            : undefined,
        obsidianVaults: Array.isArray(rawNativeKnowledge.obsidianVaults)
          ? (rawNativeKnowledge.obsidianVaults as unknown[])
            .filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value))
            .map((vault, index) => {
              const defaultId = `vault-${index + 1}`;
              return {
                id:
                  typeof vault.id === "string" && vault.id.trim().length > 0
                    ? vault.id.trim()
                    : defaultId,
                rootDir:
                  typeof vault.rootDir === "string" && vault.rootDir.trim().length > 0
                    ? vault.rootDir.trim()
                    : "",
                includeGlobs: Array.isArray(vault.includeGlobs)
                  ? (vault.includeGlobs as unknown[])
                    .filter((value): value is string => typeof value === "string")
                    .map((value) => value.trim())
                    .filter(Boolean)
                  : ["**/*.md"],
                excludeGlobs: Array.isArray(vault.excludeGlobs)
                  ? (vault.excludeGlobs as unknown[])
                    .filter((value): value is string => typeof value === "string")
                    .map((value) => value.trim())
                    .filter(Boolean)
                  : [".obsidian/**", "**/*.canvas", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.pdf"],
                namespace:
                  typeof vault.namespace === "string" && vault.namespace.trim().length > 0
                    ? vault.namespace.trim()
                    : undefined,
                privacyClass:
                  typeof vault.privacyClass === "string" && vault.privacyClass.trim().length > 0
                    ? vault.privacyClass.trim()
                    : undefined,
                folderRules: Array.isArray(vault.folderRules)
                  ? (vault.folderRules as unknown[])
                    .filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value))
                    .map((rule) => ({
                      pathPrefix:
                        typeof rule.pathPrefix === "string" && rule.pathPrefix.trim().length > 0
                          ? rule.pathPrefix.trim()
                          : "",
                      namespace:
                        typeof rule.namespace === "string" && rule.namespace.trim().length > 0
                          ? rule.namespace.trim()
                          : undefined,
                      privacyClass:
                        typeof rule.privacyClass === "string" && rule.privacyClass.trim().length > 0
                          ? rule.privacyClass.trim()
                          : undefined,
                    }))
                    .filter((rule) => rule.pathPrefix.length > 0)
                  : [],
                dailyNotePatterns: Array.isArray(vault.dailyNotePatterns)
                  ? (vault.dailyNotePatterns as unknown[])
                    .filter((value): value is string => typeof value === "string")
                    .map((value) => value.trim())
                    .filter(Boolean)
                  : ["YYYY-MM-DD"],
                materializeBacklinks: vault.materializeBacklinks === true,
              };
            })
            .filter((vault) => vault.rootDir.length > 0)
          : [],
      }
    : undefined;

  const rawAgentAccessHttp =
    cfg.agentAccessHttp && typeof cfg.agentAccessHttp === "object" && !Array.isArray(cfg.agentAccessHttp)
      ? (cfg.agentAccessHttp as Record<string, unknown>)
      : undefined;
  const agentAccessHttp = {
    enabled: rawAgentAccessHttp?.enabled === true,
    host:
      typeof rawAgentAccessHttp?.host === "string" && rawAgentAccessHttp.host.trim().length > 0
        ? rawAgentAccessHttp.host.trim()
        : "127.0.0.1",
    port:
      typeof rawAgentAccessHttp?.port === "number"
        ? Math.max(0, Math.floor(rawAgentAccessHttp.port))
        : 4318,
    authToken:
      typeof rawAgentAccessHttp?.authToken === "string" && rawAgentAccessHttp.authToken.trim().length > 0
        ? resolveEnvVars(rawAgentAccessHttp.authToken)
        : process.env.OPENCLAW_REMNIC_ACCESS_TOKEN ?? process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN,
    principal:
      typeof rawAgentAccessHttp?.principal === "string" && rawAgentAccessHttp.principal.trim().length > 0
        ? resolveEnvVars(rawAgentAccessHttp.principal)
        : process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL?.trim() || undefined,
    maxBodyBytes:
      typeof rawAgentAccessHttp?.maxBodyBytes === "number"
        ? Math.max(1, Math.floor(rawAgentAccessHttp.maxBodyBytes))
        : 131072,
  };

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
    memoryOsPreset,
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
    captureMode,
    fileHygiene,
    nativeKnowledge,
    agentAccessHttp,
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
    // Compaction reset (opt-in, default: false)
    compactionResetEnabled: cfg.compactionResetEnabled === true,
    // Hourly summaries
    hourlySummariesEnabled: cfg.hourlySummariesEnabled !== false, // default: true
    daySummaryEnabled: cfg.daySummaryEnabled !== false, // default: true
    hourlySummaryCronAutoRegister: cfg.hourlySummaryCronAutoRegister === true,
    nightlyGovernanceCronAutoRegister: cfg.nightlyGovernanceCronAutoRegister === true,
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
    evalHarnessEnabled: cfg.evalHarnessEnabled === true,
    evalShadowModeEnabled: cfg.evalShadowModeEnabled === true,
    benchmarkBaselineSnapshotsEnabled: cfg.benchmarkBaselineSnapshotsEnabled === true,
    benchmarkDeltaReporterEnabled: cfg.benchmarkDeltaReporterEnabled === true,
    benchmarkStoredBaselineEnabled: cfg.benchmarkStoredBaselineEnabled === true,
    evalStoreDir:
      typeof cfg.evalStoreDir === "string" && cfg.evalStoreDir.trim().length > 0
        ? cfg.evalStoreDir.trim()
        : path.join(memoryDir, "state", "evals"),
    objectiveStateMemoryEnabled: cfg.objectiveStateMemoryEnabled === true,
    objectiveStateSnapshotWritesEnabled: cfg.objectiveStateSnapshotWritesEnabled === true,
    objectiveStateRecallEnabled: cfg.objectiveStateRecallEnabled === true,
    objectiveStateStoreDir:
      typeof cfg.objectiveStateStoreDir === "string" && cfg.objectiveStateStoreDir.trim().length > 0
        ? cfg.objectiveStateStoreDir.trim()
        : path.join(memoryDir, "state", "objective-state"),
    causalTrajectoryMemoryEnabled: cfg.causalTrajectoryMemoryEnabled === true,
    causalTrajectoryStoreDir:
      typeof cfg.causalTrajectoryStoreDir === "string" && cfg.causalTrajectoryStoreDir.trim().length > 0
        ? cfg.causalTrajectoryStoreDir.trim()
        : path.join(memoryDir, "state", "causal-trajectories"),
    causalTrajectoryRecallEnabled: cfg.causalTrajectoryRecallEnabled === true,
    actionGraphRecallEnabled: cfg.actionGraphRecallEnabled === true,
    trustZonesEnabled: cfg.trustZonesEnabled === true,
    quarantinePromotionEnabled: cfg.quarantinePromotionEnabled === true,
    trustZoneStoreDir:
      typeof cfg.trustZoneStoreDir === "string" && cfg.trustZoneStoreDir.trim().length > 0
        ? cfg.trustZoneStoreDir.trim()
        : path.join(memoryDir, "state", "trust-zones"),
    trustZoneRecallEnabled: cfg.trustZoneRecallEnabled === true,
    memoryPoisoningDefenseEnabled: cfg.memoryPoisoningDefenseEnabled === true,
    memoryRedTeamBenchEnabled: cfg.memoryRedTeamBenchEnabled === true,
    harmonicRetrievalEnabled: cfg.harmonicRetrievalEnabled === true,
    abstractionAnchorsEnabled: cfg.abstractionAnchorsEnabled === true,
    verifiedRecallEnabled: cfg.verifiedRecallEnabled === true,
    semanticRulePromotionEnabled: cfg.semanticRulePromotionEnabled === true,
    semanticRuleVerificationEnabled: cfg.semanticRuleVerificationEnabled === true,
    semanticConsolidationEnabled: cfg.semanticConsolidationEnabled === true,
    semanticConsolidationModel:
      typeof cfg.semanticConsolidationModel === "string" && cfg.semanticConsolidationModel.length > 0
        ? cfg.semanticConsolidationModel
        : "auto",
    semanticConsolidationThreshold:
      typeof cfg.semanticConsolidationThreshold === "number" ? cfg.semanticConsolidationThreshold : 0.8,
    semanticConsolidationMinClusterSize:
      typeof cfg.semanticConsolidationMinClusterSize === "number"
        ? Math.max(2, Math.floor(cfg.semanticConsolidationMinClusterSize))
        : 3,
    semanticConsolidationExcludeCategories: Array.isArray(cfg.semanticConsolidationExcludeCategories)
      ? (cfg.semanticConsolidationExcludeCategories as unknown[]).filter(
          (c): c is string => typeof c === "string" && c.length > 0,
        )
      : ["correction", "commitment"],
    semanticConsolidationIntervalHours:
      typeof cfg.semanticConsolidationIntervalHours === "number"
        ? Math.max(1, Math.floor(cfg.semanticConsolidationIntervalHours))
        : 168,
    semanticConsolidationMaxPerRun:
      typeof cfg.semanticConsolidationMaxPerRun === "number"
        ? Math.max(0, Math.floor(cfg.semanticConsolidationMaxPerRun))
        : 100,
    creationMemoryEnabled: cfg.creationMemoryEnabled === true,
    memoryUtilityLearningEnabled: cfg.memoryUtilityLearningEnabled === true,
    promotionByOutcomeEnabled: cfg.promotionByOutcomeEnabled === true,
    commitmentLedgerEnabled: cfg.commitmentLedgerEnabled === true,
    commitmentLifecycleEnabled: cfg.commitmentLifecycleEnabled === true,
    commitmentStaleDays:
      typeof cfg.commitmentStaleDays === "number" ? cfg.commitmentStaleDays : 14,
    commitmentLedgerDir:
      typeof cfg.commitmentLedgerDir === "string" && cfg.commitmentLedgerDir.trim().length > 0
        ? cfg.commitmentLedgerDir.trim()
        : path.join(memoryDir, "state", "commitment-ledger"),
    resumeBundlesEnabled: cfg.resumeBundlesEnabled === true,
    resumeBundleDir:
      typeof cfg.resumeBundleDir === "string" && cfg.resumeBundleDir.trim().length > 0
        ? cfg.resumeBundleDir.trim()
        : path.join(memoryDir, "state", "resume-bundles"),
    workProductRecallEnabled: cfg.workProductRecallEnabled === true,
    workTasksEnabled: cfg.workTasksEnabled === true,
    workProjectsEnabled: cfg.workProjectsEnabled === true,
    workTasksDir:
      typeof cfg.workTasksDir === "string" && cfg.workTasksDir.trim().length > 0
        ? cfg.workTasksDir.trim()
        : path.join(memoryDir, "work", "tasks"),
    workProjectsDir:
      typeof cfg.workProjectsDir === "string" && cfg.workProjectsDir.trim().length > 0
        ? cfg.workProjectsDir.trim()
        : path.join(memoryDir, "work", "projects"),
    workIndexEnabled: cfg.workIndexEnabled === true,
    workIndexDir:
      typeof cfg.workIndexDir === "string" && cfg.workIndexDir.trim().length > 0
        ? cfg.workIndexDir.trim()
        : path.join(memoryDir, "work", "index"),
    workTaskIndexEnabled: cfg.workTaskIndexEnabled === true,
    workProjectIndexEnabled: cfg.workProjectIndexEnabled === true,
    workIndexAutoRebuildEnabled: cfg.workIndexAutoRebuildEnabled === true,
    workIndexAutoRebuildDebounceMs:
      typeof cfg.workIndexAutoRebuildDebounceMs === "number" ? cfg.workIndexAutoRebuildDebounceMs : 1000,
    workProductLedgerDir:
      typeof cfg.workProductLedgerDir === "string" && cfg.workProductLedgerDir.trim().length > 0
        ? cfg.workProductLedgerDir.trim()
        : path.join(memoryDir, "state", "work-product-ledger"),
    abstractionNodeStoreDir:
      typeof cfg.abstractionNodeStoreDir === "string" && cfg.abstractionNodeStoreDir.trim().length > 0
        ? cfg.abstractionNodeStoreDir.trim()
        : path.join(memoryDir, "state", "abstraction-nodes"),
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
    // Trace recall content — disabled by default; enable to send recalled memory text to trace subscribers
    traceRecallContent: cfg.traceRecallContent === true,
    // Performance profiling (opt-in, disabled by default)
    profilingEnabled: cfg.profilingEnabled === true,
    profilingStorageDir:
      typeof cfg.profilingStorageDir === "string" && cfg.profilingStorageDir.length > 0
        ? cfg.profilingStorageDir
        : path.join(memoryDir, "profiling"),
    profilingMaxTraces:
      typeof cfg.profilingMaxTraces === "number" && Number.isFinite(cfg.profilingMaxTraces)
        ? Math.max(0, cfg.profilingMaxTraces)
        : 100,
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
    // Local LLM fast tier (v9.1)
    localLlmFastEnabled: cfg.localLlmFastEnabled === true,
    localLlmFastModel:
      typeof cfg.localLlmFastModel === "string" && cfg.localLlmFastModel.length > 0
        ? cfg.localLlmFastModel
        : "",
    localLlmFastUrl:
      typeof cfg.localLlmFastUrl === "string" && cfg.localLlmFastUrl.length > 0
        ? cfg.localLlmFastUrl
        : typeof cfg.localLlmUrl === "string" && cfg.localLlmUrl.length > 0
          ? cfg.localLlmUrl
          : "http://localhost:1234/v1",
    localLlmFastTimeoutMs:
      typeof cfg.localLlmFastTimeoutMs === "number" ? cfg.localLlmFastTimeoutMs : 15_000,
    // Gateway config (passed from index.ts for fallback AI)
    gatewayConfig: cfg.gatewayConfig as PluginConfig["gatewayConfig"],
    // Gateway model source (v9.2) — route LLM calls through gateway agent model chain
    modelSource:
      cfg.modelSource === "gateway" ? "gateway" : "plugin",
    gatewayAgentId:
      typeof cfg.gatewayAgentId === "string" && cfg.gatewayAgentId.length > 0
        ? cfg.gatewayAgentId
        : "",
    fastGatewayAgentId:
      typeof cfg.fastGatewayAgentId === "string" && cfg.fastGatewayAgentId.length > 0
        ? cfg.fastGatewayAgentId
        : "",

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
      ? (cfg.autoPromoteToSharedCategories as any[]).filter((c) => c === "fact" || c === "correction" || c === "decision" || c === "preference")
      : ["fact", "correction", "decision", "preference"],
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

    // IRC (Inductive Rule Consolidation) — preference synthesis
    ircEnabled: cfg.ircEnabled !== false,
    ircMaxPreferences: typeof cfg.ircMaxPreferences === "number" ? cfg.ircMaxPreferences : 20,
    ircIncludeCorrections: cfg.ircIncludeCorrections !== false,
    ircMinConfidence: typeof cfg.ircMinConfidence === "number" ? cfg.ircMinConfidence : 0.3,

    // CMC (Causal Memory Consolidation) — cross-session causal reasoning
    cmcEnabled: cfg.cmcEnabled === true,
    cmcStitchLookbackDays: typeof cfg.cmcStitchLookbackDays === "number" ? cfg.cmcStitchLookbackDays : 7,
    cmcStitchMinScore: typeof cfg.cmcStitchMinScore === "number" ? cfg.cmcStitchMinScore : 2.5,
    cmcStitchMaxEdgesPerTrajectory: typeof cfg.cmcStitchMaxEdgesPerTrajectory === "number" ? cfg.cmcStitchMaxEdgesPerTrajectory : 3,
    cmcConsolidationEnabled: cfg.cmcConsolidationEnabled === true,
    cmcConsolidationMinRecurrence: typeof cfg.cmcConsolidationMinRecurrence === "number" ? cfg.cmcConsolidationMinRecurrence : 3,
    cmcConsolidationMinSessions: typeof cfg.cmcConsolidationMinSessions === "number" ? cfg.cmcConsolidationMinSessions : 2,
    cmcConsolidationSuccessThreshold: typeof cfg.cmcConsolidationSuccessThreshold === "number" ? cfg.cmcConsolidationSuccessThreshold : 0.7,
    cmcRetrievalEnabled: cfg.cmcRetrievalEnabled === true,
    cmcRetrievalMaxDepth: typeof cfg.cmcRetrievalMaxDepth === "number" ? cfg.cmcRetrievalMaxDepth : 3,
    cmcRetrievalMaxChars: typeof cfg.cmcRetrievalMaxChars === "number" ? cfg.cmcRetrievalMaxChars : 800,
    cmcRetrievalCounterfactualBoost: typeof cfg.cmcRetrievalCounterfactualBoost === "number" ? cfg.cmcRetrievalCounterfactualBoost : 0.4,
    cmcBehaviorLearningEnabled: cfg.cmcBehaviorLearningEnabled === true,
    cmcBehaviorMinFrequency: typeof cfg.cmcBehaviorMinFrequency === "number" ? cfg.cmcBehaviorMinFrequency : 3,
    cmcBehaviorMinSessions: typeof cfg.cmcBehaviorMinSessions === "number" ? cfg.cmcBehaviorMinSessions : 2,
    cmcBehaviorConfidenceThreshold: typeof cfg.cmcBehaviorConfidenceThreshold === "number" ? cfg.cmcBehaviorConfidenceThreshold : 0.6,
    cmcLifecycleCausalImpactWeight: typeof cfg.cmcLifecycleCausalImpactWeight === "number" ? cfg.cmcLifecycleCausalImpactWeight : 0.05,

    // PEDC (Prediction-Error-Driven Calibration) — model-user alignment
    calibrationEnabled: cfg.calibrationEnabled === true,
    calibrationMaxRulesPerRecall: typeof cfg.calibrationMaxRulesPerRecall === "number" ? cfg.calibrationMaxRulesPerRecall : 10,
    calibrationMaxChars: typeof cfg.calibrationMaxChars === "number" ? cfg.calibrationMaxChars : 1200,

    // v7.0 Knowledge Graph Enhancement
    knowledgeIndexEnabled: cfg.knowledgeIndexEnabled !== false,
    knowledgeIndexMaxEntities:
      typeof cfg.knowledgeIndexMaxEntities === "number" ? cfg.knowledgeIndexMaxEntities : 40,
    knowledgeIndexMaxChars:
      typeof cfg.knowledgeIndexMaxChars === "number" ? cfg.knowledgeIndexMaxChars : 4000,
    entityRetrievalEnabled: cfg.entityRetrievalEnabled !== false,
    entityRetrievalMaxChars:
      typeof cfg.entityRetrievalMaxChars === "number" ? cfg.entityRetrievalMaxChars : 2400,
    entityRetrievalMaxHints:
      typeof cfg.entityRetrievalMaxHints === "number" ? cfg.entityRetrievalMaxHints : 2,
    entityRetrievalMaxSupportingFacts:
      typeof cfg.entityRetrievalMaxSupportingFacts === "number" ? cfg.entityRetrievalMaxSupportingFacts : 6,
    entityRetrievalMaxRelatedEntities:
      typeof cfg.entityRetrievalMaxRelatedEntities === "number" ? cfg.entityRetrievalMaxRelatedEntities : 3,
    entityRetrievalRecentTurns:
      typeof cfg.entityRetrievalRecentTurns === "number" ? cfg.entityRetrievalRecentTurns : 6,
    recallBudgetChars: recallPipelineConfig.recallBudgetChars,
    recallOuterTimeoutMs:
      typeof cfg.recallOuterTimeoutMs === "number" ? Math.max(0, Math.floor(cfg.recallOuterTimeoutMs)) : 75_000,
    recallCoreDeadlineMs:
      typeof cfg.recallCoreDeadlineMs === "number" ? Math.max(0, Math.floor(cfg.recallCoreDeadlineMs)) : 75_000,
    recallEnrichmentDeadlineMs:
      typeof cfg.recallEnrichmentDeadlineMs === "number"
        ? Math.max(0, Math.floor(cfg.recallEnrichmentDeadlineMs))
        : 25_000,
    recallPipeline: recallPipelineConfig.pipeline,
    recallMmrEnabled: cfg.recallMmrEnabled !== false,
    recallMmrLambda:
      typeof cfg.recallMmrLambda === "number" && Number.isFinite(cfg.recallMmrLambda)
        ? Math.min(1, Math.max(0, cfg.recallMmrLambda))
        : 0.7,
    recallMmrTopN:
      typeof cfg.recallMmrTopN === "number" && Number.isFinite(cfg.recallMmrTopN)
        ? Math.max(0, Math.floor(cfg.recallMmrTopN))
        : 40,
    qmdRecallCacheTtlMs:
      typeof cfg.qmdRecallCacheTtlMs === "number" ? Math.max(0, Math.floor(cfg.qmdRecallCacheTtlMs)) : 60_000,
    qmdRecallCacheStaleTtlMs:
      typeof cfg.qmdRecallCacheStaleTtlMs === "number"
        ? Math.max(0, Math.floor(cfg.qmdRecallCacheStaleTtlMs))
        : 10 * 60_000,
    qmdRecallCacheMaxEntries:
      typeof cfg.qmdRecallCacheMaxEntries === "number"
        ? Math.max(0, Math.floor(cfg.qmdRecallCacheMaxEntries))
        : 128,
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
    lancedbEnabled: cfg.lancedbEnabled === true,
    lanceDbPath: typeof cfg.lanceDbPath === "string" ? cfg.lanceDbPath : path.join(memoryDir, "lancedb"),
    lanceEmbeddingDimension: typeof cfg.lanceEmbeddingDimension === "number" ? cfg.lanceEmbeddingDimension : 1536,

    // Meilisearch backend
    meilisearchEnabled: cfg.meilisearchEnabled === true,
    meilisearchHost: typeof cfg.meilisearchHost === "string" ? cfg.meilisearchHost : "http://localhost:7700",
    meilisearchApiKey: typeof cfg.meilisearchApiKey === "string" ? cfg.meilisearchApiKey : undefined,
    meilisearchTimeoutMs: typeof cfg.meilisearchTimeoutMs === "number" ? cfg.meilisearchTimeoutMs : 30_000,
    meilisearchAutoIndex: cfg.meilisearchAutoIndex === true,

    // Orama backend
    oramaEnabled: cfg.oramaEnabled === true,
    oramaDbPath: typeof cfg.oramaDbPath === "string" ? cfg.oramaDbPath : path.join(memoryDir, "orama"),
    oramaEmbeddingDimension: typeof cfg.oramaEmbeddingDimension === "number" ? cfg.oramaEmbeddingDimension : 1536,

    // QMD daemon mode
    qmdDaemonEnabled: cfg.qmdDaemonEnabled !== false,
    qmdDaemonUrl:
      typeof cfg.qmdDaemonUrl === "string" && cfg.qmdDaemonUrl.length > 0
        ? cfg.qmdDaemonUrl
        : "http://localhost:8181/mcp",
    qmdDaemonRecheckIntervalMs:
      typeof cfg.qmdDaemonRecheckIntervalMs === "number" ? cfg.qmdDaemonRecheckIntervalMs : 15_000,
    qmdIntentHintsEnabled: cfg.qmdIntentHintsEnabled === true,
    qmdExplainEnabled: cfg.qmdExplainEnabled === true,

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
    proactiveExtractionTimeoutMs:
      typeof cfg.proactiveExtractionTimeoutMs === "number"
        ? Math.max(0, Math.floor(cfg.proactiveExtractionTimeoutMs))
        : 2500,
    proactiveExtractionMaxTokens:
      typeof cfg.proactiveExtractionMaxTokens === "number"
        ? Math.max(0, Math.floor(cfg.proactiveExtractionMaxTokens))
        : 900,
    extractionMaxOutputTokens:
      typeof cfg.extractionMaxOutputTokens === "number"
        ? Math.max(1, Math.floor(cfg.extractionMaxOutputTokens))
        : 16384,
    proactiveExtractionCategoryAllowlist: Array.isArray(cfg.proactiveExtractionCategoryAllowlist)
      ? (cfg.proactiveExtractionCategoryAllowlist as unknown[]).filter(
          (category): category is PluginConfig["lifecycleProtectedCategories"][number] =>
            typeof category === "string" && VALID_MEMORY_CATEGORIES.has(category),
        )
      : undefined,
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
    recallPlannerModel:
      typeof cfg.recallPlannerModel === "string" && cfg.recallPlannerModel.trim().length > 0
        ? cfg.recallPlannerModel.trim()
        : "gpt-5.2-mini",
    recallPlannerTimeoutMs:
      typeof cfg.recallPlannerTimeoutMs === "number" ? cfg.recallPlannerTimeoutMs : 1500,
    recallPlannerUseResponsesApi: cfg.recallPlannerUseResponsesApi !== false,
    recallPlannerMaxPromptChars:
      typeof cfg.recallPlannerMaxPromptChars === "number" ? cfg.recallPlannerMaxPromptChars : 4000,
    recallPlannerMaxMemoryHints:
      typeof cfg.recallPlannerMaxMemoryHints === "number" ? cfg.recallPlannerMaxMemoryHints : 24,
    recallPlannerShadowMode: cfg.recallPlannerShadowMode === true,
    recallPlannerTelemetryEnabled: cfg.recallPlannerTelemetryEnabled !== false,
    recallPlannerMaxQmdResultsMinimal:
      typeof cfg.recallPlannerMaxQmdResultsMinimal === "number"
        ? cfg.recallPlannerMaxQmdResultsMinimal
        : 4,
    recallPlannerMaxQmdResultsFull:
      typeof cfg.recallPlannerMaxQmdResultsFull === "number" ? cfg.recallPlannerMaxQmdResultsFull : 8,
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
    temporalIndexWindowDays:
      typeof cfg.temporalIndexWindowDays === "number" ? cfg.temporalIndexWindowDays : 30,
    temporalIndexMaxEntries:
      typeof cfg.temporalIndexMaxEntries === "number" ? cfg.temporalIndexMaxEntries : 5000,
    temporalBoostRecentDays:
      typeof cfg.temporalBoostRecentDays === "number" ? cfg.temporalBoostRecentDays : 7,
    temporalBoostScore: typeof cfg.temporalBoostScore === "number" ? cfg.temporalBoostScore : 0.15,
    temporalDecayEnabled: cfg.temporalDecayEnabled !== false,
    tagMemoryEnabled: cfg.tagMemoryEnabled === true,
    tagMaxPerMemory: typeof cfg.tagMaxPerMemory === "number" ? cfg.tagMaxPerMemory : 5,
    tagIndexMaxEntries:
      typeof cfg.tagIndexMaxEntries === "number" ? cfg.tagIndexMaxEntries : 10000,
    tagRecallBoost: typeof cfg.tagRecallBoost === "number" ? cfg.tagRecallBoost : 0.15,
    tagRecallMaxMatches: typeof cfg.tagRecallMaxMatches === "number" ? cfg.tagRecallMaxMatches : 10,
    // v8.2: Multi-graph memory (PR 18)
    multiGraphMemoryEnabled: cfg.multiGraphMemoryEnabled === true,
    graphRecallEnabled: cfg.graphRecallEnabled === true,
    graphRecallMaxExpansions:
      typeof cfg.graphRecallMaxExpansions === "number" ? cfg.graphRecallMaxExpansions : 3,
    graphRecallMaxPerSeed:
      typeof cfg.graphRecallMaxPerSeed === "number" ? cfg.graphRecallMaxPerSeed : 5,
    graphRecallMinEdgeWeight:
      typeof cfg.graphRecallMinEdgeWeight === "number" ? cfg.graphRecallMinEdgeWeight : 0.1,
    graphRecallShadowEnabled: cfg.graphRecallShadowEnabled === true,
    graphRecallSnapshotEnabled: cfg.graphRecallSnapshotEnabled === true,
    graphRecallShadowSampleRate:
      typeof cfg.graphRecallShadowSampleRate === "number" ? cfg.graphRecallShadowSampleRate : 0.1,
    graphRecallExplainToolEnabled: cfg.graphRecallExplainToolEnabled === true,
    graphRecallStoreColdMirror: cfg.graphRecallStoreColdMirror === true,
    graphRecallColdMirrorCollection:
      typeof cfg.graphRecallColdMirrorCollection === "string" &&
      cfg.graphRecallColdMirrorCollection.trim().length > 0
        ? cfg.graphRecallColdMirrorCollection.trim()
        : undefined,
    graphRecallColdMirrorMinAgeDays:
      typeof cfg.graphRecallColdMirrorMinAgeDays === "number" ? cfg.graphRecallColdMirrorMinAgeDays : 7,
    graphRecallUseEntityPriors: cfg.graphRecallUseEntityPriors === true,
    graphRecallEntityPriorBoost:
      typeof cfg.graphRecallEntityPriorBoost === "number" ? cfg.graphRecallEntityPriorBoost : 0.2,
    graphRecallPreferHubSeeds: cfg.graphRecallPreferHubSeeds === true,
    graphRecallHubBias:
      typeof cfg.graphRecallHubBias === "number" ? cfg.graphRecallHubBias : 0.3,
    graphRecallRecencyHalfLifeDays:
      typeof cfg.graphRecallRecencyHalfLifeDays === "number" ? cfg.graphRecallRecencyHalfLifeDays : 30,
    graphRecallDampingFactor:
      typeof cfg.graphRecallDampingFactor === "number" ? cfg.graphRecallDampingFactor : 0.85,
    graphRecallMaxSeedNodes:
      typeof cfg.graphRecallMaxSeedNodes === "number" ? cfg.graphRecallMaxSeedNodes : 10,
    graphRecallMaxExpandedNodes:
      typeof cfg.graphRecallMaxExpandedNodes === "number" ? cfg.graphRecallMaxExpandedNodes : 30,
    graphRecallMaxTrailPerNode:
      typeof cfg.graphRecallMaxTrailPerNode === "number" ? cfg.graphRecallMaxTrailPerNode : 5,
    graphRecallMinSeedScore:
      typeof cfg.graphRecallMinSeedScore === "number" ? cfg.graphRecallMinSeedScore : 0.3,
    graphRecallExpansionScoreThreshold:
      typeof cfg.graphRecallExpansionScoreThreshold === "number"
        ? cfg.graphRecallExpansionScoreThreshold
        : 0.2,
    graphRecallExplainMaxPaths:
      typeof cfg.graphRecallExplainMaxPaths === "number" ? cfg.graphRecallExplainMaxPaths : 3,
    graphRecallExplainMaxChars:
      typeof cfg.graphRecallExplainMaxChars === "number" ? cfg.graphRecallExplainMaxChars : 500,
    graphRecallExplainEdgeLimit:
      typeof cfg.graphRecallExplainEdgeLimit === "number" ? cfg.graphRecallExplainEdgeLimit : 5,
    graphRecallExplainEnabled: cfg.graphRecallExplainEnabled === true,
    graphRecallEntityHintsEnabled: cfg.graphRecallEntityHintsEnabled === true,
    graphRecallEntityHintMax:
      typeof cfg.graphRecallEntityHintMax === "number" ? cfg.graphRecallEntityHintMax : 3,
    graphRecallEntityHintMaxChars:
      typeof cfg.graphRecallEntityHintMaxChars === "number" ? cfg.graphRecallEntityHintMaxChars : 200,
    graphRecallSnapshotDir:
      typeof cfg.graphRecallSnapshotDir === "string" && cfg.graphRecallSnapshotDir.trim().length > 0
        ? cfg.graphRecallSnapshotDir.trim()
        : path.join(memoryDir, "state", "graph"),
    graphRecallEnableTrace: cfg.graphRecallEnableTrace === true,
    graphRecallEnableDebug: cfg.graphRecallEnableDebug === true,
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
    delinearizeEnabled: cfg.delinearizeEnabled !== false,
    recallConfidenceGateEnabled: cfg.recallConfidenceGateEnabled === true,
    recallConfidenceGateThreshold:
      typeof cfg.recallConfidenceGateThreshold === "number"
        ? Math.max(0, Math.min(1, cfg.recallConfidenceGateThreshold))
        : 0.12,
    causalRuleExtractionEnabled: cfg.causalRuleExtractionEnabled === true,
    memoryReconstructionEnabled: cfg.memoryReconstructionEnabled === true,
    memoryReconstructionMaxExpansions:
      typeof cfg.memoryReconstructionMaxExpansions === "number" ? Math.max(0, Math.round(cfg.memoryReconstructionMaxExpansions)) : 3,
    graphLateralInhibitionEnabled: cfg.graphLateralInhibitionEnabled !== false,
    graphLateralInhibitionBeta:
      typeof cfg.graphLateralInhibitionBeta === "number"
        ? Math.max(0, Math.min(1, cfg.graphLateralInhibitionBeta))
        : 0.15,
    graphLateralInhibitionTopM:
      typeof cfg.graphLateralInhibitionTopM === "number"
        ? Math.max(0, Math.round(cfg.graphLateralInhibitionTopM))
        : 7,
    // v8.2: Temporal Memory Tree
    temporalMemoryTreeEnabled: cfg.temporalMemoryTreeEnabled === true,
    tmtHourlyMinMemories:
      typeof cfg.tmtHourlyMinMemories === "number" ? cfg.tmtHourlyMinMemories : 3,
    tmtSummaryMaxTokens:
      typeof cfg.tmtSummaryMaxTokens === "number" ? cfg.tmtSummaryMaxTokens : 300,
    // Lossless Context Management (LCM)
    lcmEnabled: cfg.lcmEnabled === true,
    lcmLeafBatchSize:
      typeof cfg.lcmLeafBatchSize === "number" ? Math.max(2, Math.floor(cfg.lcmLeafBatchSize)) : 8,
    lcmRollupFanIn:
      typeof cfg.lcmRollupFanIn === "number" ? Math.max(2, Math.floor(cfg.lcmRollupFanIn)) : 4,
    lcmFreshTailTurns:
      typeof cfg.lcmFreshTailTurns === "number" ? Math.max(1, Math.floor(cfg.lcmFreshTailTurns)) : 16,
    lcmMaxDepth:
      typeof cfg.lcmMaxDepth === "number" ? Math.max(1, Math.floor(cfg.lcmMaxDepth)) : 5,
    lcmRecallBudgetShare:
      typeof cfg.lcmRecallBudgetShare === "number"
        ? Math.max(0, Math.min(1, cfg.lcmRecallBudgetShare))
        : 0.15,
    lcmDeterministicMaxTokens:
      typeof cfg.lcmDeterministicMaxTokens === "number"
        ? Math.max(64, Math.floor(cfg.lcmDeterministicMaxTokens))
        : 512,
    lcmArchiveRetentionDays:
      typeof cfg.lcmArchiveRetentionDays === "number"
        ? Math.max(1, Math.floor(cfg.lcmArchiveRetentionDays))
        : 90,

    // v9.1 Parallel Specialized Retrieval
    parallelRetrievalEnabled: cfg.parallelRetrievalEnabled === true,
    parallelAgentWeights: (() => {
      const w = cfg.parallelAgentWeights as Record<string, unknown> | undefined;
      return {
        direct: typeof w?.direct === "number" ? Math.max(0, w.direct) : 1.0,
        contextual: typeof w?.contextual === "number" ? Math.max(0, w.contextual) : 0.7,
        temporal: typeof w?.temporal === "number" ? Math.max(0, w.temporal) : 0.85,
      };
    })(),
    parallelMaxResultsPerAgent:
      typeof cfg.parallelMaxResultsPerAgent === "number"
        ? Math.max(0, Math.floor(cfg.parallelMaxResultsPerAgent))
        : 20,
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
    maxHints: clampNonNegativeNumber(entry.maxHints),
    maxSupportingFacts: clampNonNegativeNumber(entry.maxSupportingFacts),
    maxRelatedEntities: clampNonNegativeNumber(entry.maxRelatedEntities),
    consolidateTriggerLines: clampNonNegativeNumber(entry.consolidateTriggerLines),
    consolidateTargetLines: clampNonNegativeNumber(entry.consolidateTargetLines),
    maxEntities: clampNonNegativeNumber(entry.maxEntities),
    maxResults: clampNonNegativeNumber(entry.maxResults),
    recentTurns: clampNonNegativeNumber(entry.recentTurns),
    maxTurns: clampNonNegativeNumber(entry.maxTurns),
    maxTokens: clampNonNegativeNumber(entry.maxTokens),
    lookbackHours: clampNonNegativeNumber(entry.lookbackHours),
    maxCount: clampNonNegativeNumber(entry.maxCount),
    topK: clampNonNegativeNumber(entry.topK),
    timeoutMs: clampNonNegativeNumber(entry.timeoutMs),
    maxPatterns: clampNonNegativeNumber(entry.maxPatterns),
    maxRubrics: clampNonNegativeNumber(entry.maxRubrics),
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
      id: "entity-retrieval",
      enabled: cfg.entityRetrievalEnabled !== false,
      maxChars:
        typeof cfg.entityRetrievalMaxChars === "number"
          ? Math.max(0, Math.floor(cfg.entityRetrievalMaxChars))
          : 2400,
      maxHints:
        typeof cfg.entityRetrievalMaxHints === "number"
          ? Math.max(0, Math.floor(cfg.entityRetrievalMaxHints))
          : 2,
      maxSupportingFacts:
        typeof cfg.entityRetrievalMaxSupportingFacts === "number"
          ? Math.max(0, Math.floor(cfg.entityRetrievalMaxSupportingFacts))
          : 6,
      maxRelatedEntities:
        typeof cfg.entityRetrievalMaxRelatedEntities === "number"
          ? Math.max(0, Math.floor(cfg.entityRetrievalMaxRelatedEntities))
          : 3,
      recentTurns:
        typeof cfg.entityRetrievalRecentTurns === "number"
          ? Math.max(0, Math.floor(cfg.entityRetrievalRecentTurns))
          : 6,
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
    { id: "lcm-compressed-history", enabled: cfg.lcmEnabled === true },
    {
      id: "objective-state",
      enabled: cfg.objectiveStateRecallEnabled === true,
      maxResults: 4,
      maxChars: 1800,
    },
    {
      id: "causal-trajectories",
      enabled: cfg.causalTrajectoryRecallEnabled === true,
      maxResults: 3,
      maxChars: 2200,
    },
    {
      id: "trust-zones",
      enabled: cfg.trustZoneRecallEnabled === true,
      maxResults: 3,
      maxChars: 1800,
    },
    {
      id: "harmonic-retrieval",
      enabled: cfg.harmonicRetrievalEnabled === true,
      maxResults: 3,
      maxChars: 2200,
    },
    {
      id: "verified-episodes",
      enabled: cfg.verifiedRecallEnabled === true,
      maxResults: 3,
      maxChars: 1800,
    },
    {
      id: "verified-rules",
      enabled: cfg.semanticRuleVerificationEnabled === true,
      maxResults: 3,
      maxChars: 1800,
    },
    {
      id: "work-products",
      enabled: cfg.workProductRecallEnabled === true,
      maxResults: 3,
      maxChars: 1800,
    },
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
      id: "native-knowledge",
      enabled: cfg.nativeKnowledge && typeof cfg.nativeKnowledge === "object"
        ? (cfg.nativeKnowledge as Record<string, unknown>).enabled === true
        : false,
      maxResults:
        cfg.nativeKnowledge && typeof cfg.nativeKnowledge === "object" &&
          typeof (cfg.nativeKnowledge as Record<string, unknown>).maxResults === "number"
          ? Math.max(0, Math.floor((cfg.nativeKnowledge as Record<string, unknown>).maxResults as number))
          : 4,
      maxChars:
        cfg.nativeKnowledge && typeof cfg.nativeKnowledge === "object" &&
          typeof (cfg.nativeKnowledge as Record<string, unknown>).maxChars === "number"
          ? Math.max(0, Math.floor((cfg.nativeKnowledge as Record<string, unknown>).maxChars as number))
          : 2400,
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
      maxRubrics: 4,
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
