import { readFile } from "node:fs/promises";

import {
  resolveRemnicPluginEntry,
  type GatewayConfig,
} from "@remnic/core";
import type {
  BenchJudge,
  BenchResponder,
} from "./adapters/types.js";
import {
  ASSISTANT_AGENT_CONFIG_KEY,
  ASSISTANT_JUDGE_CONFIG_KEY,
} from "./benchmarks/remnic/_assistant-common/default-agent.js";
import type { AssistantAgent } from "./benchmarks/remnic/_assistant-common/types.js";
import {
  createGatewayResponder,
  createProviderBackedJudge,
  createProviderBackedResponder,
  createProviderBackedStructuredJudge,
} from "./responders.js";
import type { ProviderFactoryConfig } from "./providers/types.js";
import type { BenchRuntimeProfile, BuiltInProvider, ProviderConfig } from "./types.js";
export type BenchModelSource = "plugin" | "gateway";

export interface ResolveBenchRuntimeProfileOptions {
  runtimeProfile?: BenchRuntimeProfile;
  remnicConfigPath?: string;
  openclawConfigPath?: string;
  modelSource?: BenchModelSource;
  gatewayAgentId?: string;
  fastGatewayAgentId?: string;
  systemProvider?: BuiltInProvider;
  systemModel?: string;
  systemBaseUrl?: string;
  judgeProvider?: BuiltInProvider;
  judgeModel?: string;
  judgeBaseUrl?: string;
}

export interface ResolvedBenchRuntimeProfile {
  profile: BenchRuntimeProfile;
  remnicConfig: Record<string, unknown>;
  adapterOptions: {
    configOverrides: Record<string, unknown>;
    responder?: BenchResponder;
    judge?: BenchJudge;
  };
  systemProvider: ProviderConfig | null;
  judgeProvider: ProviderConfig | null;
}

const GATEWAY_SECRET_SUFFIXES = [
  "apikey",
  "authtoken",
  "accesstoken",
  "clientsecret",
  "authorization",
  "password",
  "secret",
  "token",
] as const;

const BASELINE_REMNIC_CONFIG: Record<string, unknown> = {
  qmdEnabled: false,
  qmdColdTierEnabled: false,
  transcriptEnabled: false,
  hourlySummariesEnabled: false,
  daySummaryEnabled: false,
  identityEnabled: false,
  identityContinuityEnabled: false,
  namespacesEnabled: false,
  sharedContextEnabled: false,
  workTasksEnabled: false,
  workProjectsEnabled: false,
  commitmentLedgerEnabled: false,
  resumeBundlesEnabled: false,
  nativeKnowledge: { enabled: false },
  lcmEnabled: true,
  lcmLeafBatchSize: 4,
  lcmRollupFanIn: 3,
  lcmFreshTailTurns: 8,
  lcmMaxDepth: 4,
  lcmDeterministicMaxTokens: 512,
  lcmRecallBudgetShare: 1.0,
  extractionDedupeEnabled: true,
  extractionMinChars: 10,
  extractionMinUserTurns: 0,
  recallPlannerEnabled: true,
  queryExpansionEnabled: false,
  rerankEnabled: false,
  memoryBoxesEnabled: false,
  traceWeaverEnabled: false,
  threadingEnabled: false,
  factDeduplicationEnabled: false,
  knowledgeIndexEnabled: false,
  entityRetrievalEnabled: false,
  verifiedRecallEnabled: false,
  queryAwareIndexingEnabled: false,
  contradictionDetectionEnabled: false,
  memoryLinkingEnabled: false,
  topicExtractionEnabled: false,
  chunkingEnabled: true,
  episodeNoteModeEnabled: false,
};

export async function resolveBenchRuntimeProfile(
  options: ResolveBenchRuntimeProfileOptions,
): Promise<ResolvedBenchRuntimeProfile> {
  const profile = options.runtimeProfile ?? "baseline";
  const systemProvider = resolveProviderConfig(
    "system",
    options.systemProvider,
    options.systemModel,
    options.systemBaseUrl,
  );
  const judgeProvider = resolveProviderConfig(
    "judge",
    options.judgeProvider,
    options.judgeModel,
    options.judgeBaseUrl,
  );

  const responder = systemProvider
    ? createProviderBackedResponder(asProviderFactoryConfig(systemProvider))
    : undefined;
  const judge = judgeProvider
    ? createProviderBackedJudge(asProviderFactoryConfig(judgeProvider))
    : undefined;
  const structuredJudge = judgeProvider
    ? createProviderBackedStructuredJudge(asProviderFactoryConfig(judgeProvider))
    : undefined;

  if (profile === "baseline") {
    const remnicConfig = withAssistantHooks(
      { ...BASELINE_REMNIC_CONFIG },
      responder,
      structuredJudge,
    );
    return {
      profile,
      remnicConfig,
      adapterOptions: {
        configOverrides: remnicConfig,
        responder,
        judge,
      },
      systemProvider,
      judgeProvider,
    };
  }

  if (profile === "real") {
    const fileConfig = options.remnicConfigPath
      ? await loadRemnicConfigFile(options.remnicConfigPath)
      : {};
    const remnicConfig = withAssistantHooks(
      {
        ...fileConfig,
        lcmEnabled: true,
        ...(options.modelSource ? { modelSource: options.modelSource } : {}),
        ...(options.gatewayAgentId ? { gatewayAgentId: options.gatewayAgentId } : {}),
        ...(options.fastGatewayAgentId
          ? { fastGatewayAgentId: options.fastGatewayAgentId }
          : {}),
      },
      responder,
      structuredJudge,
    );
    return {
      profile,
      remnicConfig,
      adapterOptions: {
        configOverrides: remnicConfig,
        responder,
        judge,
      },
      systemProvider,
      judgeProvider,
    };
  }

  const openclawRuntime = await loadOpenclawRuntimeConfig(options.openclawConfigPath);
  const gatewayConfig = openclawRuntime.gatewayConfig;
  const gatewayAgentId =
    options.gatewayAgentId ??
    asNonEmptyString(openclawRuntime.remnicConfig.gatewayAgentId);
  const fastGatewayAgentId =
    options.fastGatewayAgentId ??
    asNonEmptyString(openclawRuntime.remnicConfig.fastGatewayAgentId);
  const gatewayResponder = createGatewayResponder({
    gatewayConfig,
    agentId: gatewayAgentId,
  });
  const remnicConfig = withAssistantHooks(
    {
      ...openclawRuntime.remnicConfig,
      lcmEnabled: true,
      gatewayConfig: openclawRuntime.persistedGatewayConfig,
      modelSource: "gateway",
      ...(gatewayAgentId ? { gatewayAgentId } : {}),
      ...(fastGatewayAgentId ? { fastGatewayAgentId } : {}),
    },
    gatewayResponder,
    structuredJudge,
  );

  return {
    profile,
    remnicConfig,
    adapterOptions: {
      configOverrides: remnicConfig,
      responder: gatewayResponder,
      judge,
    },
    systemProvider: null,
    judgeProvider,
  };
}

async function loadRemnicConfigFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  const parsed = await loadJsonObject(filePath, "Remnic config");
  const remnic = parsed.remnic;
  if (isPlainObject(remnic)) {
    return { ...remnic };
  }
  const engram = parsed.engram;
  if (isPlainObject(engram)) {
    return { ...engram };
  }
  return parsed;
}

async function loadOpenclawRuntimeConfig(
  filePath: string | undefined,
): Promise<{
  remnicConfig: Record<string, unknown>;
  gatewayConfig: GatewayConfig;
  persistedGatewayConfig: GatewayConfig;
}> {
  if (!filePath) {
    throw new Error("openclaw-chain runtime profile requires an OpenClaw config path");
  }

  const parsed = await loadJsonObject(filePath, "OpenClaw config");
  const entry = resolveRemnicPluginEntry(parsed);
  const remnicConfig =
    isPlainObject(entry?.config) ? { ...entry.config } : {};

  const gatewayConfig: GatewayConfig = {
    ...(isPlainObject(parsed.agents) ? { agents: parsed.agents as GatewayConfig["agents"] } : {}),
    ...(isPlainObject(parsed.models) ? { models: parsed.models as GatewayConfig["models"] } : {}),
  };

  return {
    remnicConfig,
    gatewayConfig,
    persistedGatewayConfig: sanitizeGatewayConfig(gatewayConfig),
  };
}

async function loadJsonObject(
  filePath: string,
  label: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} at ${filePath} contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${label} at ${filePath} must be a JSON object`);
  }

  return parsed;
}

function resolveProviderConfig(
  kind: "system" | "judge",
  provider: BuiltInProvider | undefined,
  model: string | undefined,
  baseUrl: string | undefined,
): ProviderConfig | null {
  const hasProvider = typeof provider === "string";
  const hasModel = typeof model === "string" && model.trim().length > 0;
  const hasBaseUrl = typeof baseUrl === "string" && baseUrl.trim().length > 0;

  if (!hasProvider && !hasModel && !hasBaseUrl) {
    return null;
  }

  if (!hasProvider || !hasModel) {
    throw new Error(`${kind} provider requires both provider and model`);
  }

  return {
    provider,
    model: model.trim(),
    ...(hasBaseUrl ? { baseUrl: baseUrl!.trim() } : {}),
  };
}

function withAssistantHooks(
  config: Record<string, unknown>,
  responder: BenchResponder | undefined,
  structuredJudge: ReturnType<typeof createProviderBackedStructuredJudge> | undefined,
): Record<string, unknown> {
  const next = { ...config };

  if (responder) {
    next[ASSISTANT_AGENT_CONFIG_KEY] = createAssistantAgentFromResponder(responder);
  }
  if (structuredJudge) {
    next[ASSISTANT_JUDGE_CONFIG_KEY] = structuredJudge;
  }

  return next;
}

function createAssistantAgentFromResponder(
  responder: BenchResponder,
): AssistantAgent {
  return {
    async respond(request) {
      const response = await responder.respond(request.prompt, request.memoryView);
      return response.text;
    },
  };
}

function asProviderFactoryConfig(config: ProviderConfig): ProviderFactoryConfig {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  } as ProviderFactoryConfig;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function sanitizeGatewayConfig(config: GatewayConfig): GatewayConfig {
  const sanitized = sanitizeGatewayValue(config);
  return isPlainObject(sanitized) ? sanitized as GatewayConfig : {};
}

function sanitizeGatewayValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeGatewayValue(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isGatewaySecretKey(key)) {
      continue;
    }
    next[key] = sanitizeGatewayValue(entry);
  }
  return next;
}

function isGatewaySecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return GATEWAY_SECRET_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
