import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  type FallbackLlmRuntimeContext,
  resolveRemnicPluginEntry,
  type GatewayConfig,
} from "@remnic/core";
import type {
  BenchJudge,
  BenchResponder,
} from "./adapters/types.js";
import { buildBenchBaselineRemnicConfig } from "./adapters/remnic-adapter.js";
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
import { createProvider } from "./providers/factory.js";
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
  systemApiKey?: string;
  judgeProvider?: BuiltInProvider;
  judgeModel?: string;
  judgeBaseUrl?: string;
  judgeApiKey?: string;
  requestTimeout?: number;
  max429WaitMs?: number;
  disableThinking?: boolean;
}

export interface ResolvedBenchRuntimeProfile {
  profile: BenchRuntimeProfile;
  remnicConfig: Record<string, unknown>;
  effectiveRemnicConfig: Record<string, unknown>;
  adapterOptions: {
    configOverrides: Record<string, unknown>;
    preserveRuntimeDefaults?: boolean;
    responder?: BenchResponder;
    judge?: BenchJudge;
  };
  systemProvider: ProviderConfig | null;
  judgeProvider: ProviderConfig | null;
}

const EXACT_SECRET_KEYS = new Set([
  "authorization",
  "password",
  "secret",
  "token",
] as const);

const SECRET_KEY_SEGMENT_SUFFIXES = new Set([
  "apikey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "clientsecret",
  "secretkey",
  "privatekey",
] as const);

const REDACTED_CONFIG_VALUE = "[redacted]";

export async function resolveBenchRuntimeProfile(
  options: ResolveBenchRuntimeProfileOptions,
): Promise<ResolvedBenchRuntimeProfile> {
  const profile = options.runtimeProfile ?? "baseline";
  const systemProvider = profile === "openclaw-chain"
    ? null
    : resolveProviderConfig(
      "system",
      options.systemProvider,
      options.systemModel,
      options.systemBaseUrl,
      options.requestTimeout,
      options.disableThinking,
      options.systemApiKey,
      options.max429WaitMs,
    );
  const judgeProvider = resolveProviderConfig(
    "judge",
    options.judgeProvider,
    options.judgeModel,
    options.judgeBaseUrl,
    options.requestTimeout,
    options.disableThinking,
    options.judgeApiKey,
    options.max429WaitMs,
  );
  const responderFactoryConfig = systemProvider
    ? asProviderFactoryConfig(systemProvider)
    : undefined;
  const judgeFactoryConfig = judgeProvider
    ? asProviderFactoryConfig(judgeProvider)
    : undefined;
  const judgeProviderInstance = judgeFactoryConfig
    ? createProvider(judgeFactoryConfig)
    : undefined;
  const judge = judgeFactoryConfig
    ? createProviderBackedJudge(judgeFactoryConfig, judgeProviderInstance)
    : undefined;
  const structuredJudge = judgeFactoryConfig
    ? createProviderBackedStructuredJudge(judgeFactoryConfig, judgeProviderInstance)
    : undefined;

  if (profile === "baseline") {
    const responder = responderFactoryConfig
      ? createProviderBackedResponder(responderFactoryConfig)
      : undefined;
    const baselineConfig = buildBenchBaselineRemnicConfig();
    const persistedRemnicConfig = sanitizePersistedConfig(baselineConfig);
    const effectiveRemnicConfig = withAssistantHooks(
      { ...baselineConfig },
      responder,
      structuredJudge,
    );
    return {
      profile,
      remnicConfig: persistedRemnicConfig,
      effectiveRemnicConfig,
      adapterOptions: {
        configOverrides: effectiveRemnicConfig,
        responder,
        judge,
      },
      systemProvider,
      judgeProvider,
    };
  }

  if (profile === "real") {
    const responder = responderFactoryConfig
      ? createProviderBackedResponder(responderFactoryConfig)
      : undefined;
    const fileConfig = options.remnicConfigPath
      ? await loadRemnicConfigFile(options.remnicConfigPath)
      : {};
    const persistedRemnicConfig = sanitizePersistedConfig({
      ...fileConfig,
      lcmEnabled: true,
      ...(options.modelSource ? { modelSource: options.modelSource } : {}),
      ...(options.gatewayAgentId ? { gatewayAgentId: options.gatewayAgentId } : {}),
      ...(options.fastGatewayAgentId
        ? { fastGatewayAgentId: options.fastGatewayAgentId }
        : {}),
    });
    const effectiveRemnicConfig = withAssistantHooks(
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
      remnicConfig: persistedRemnicConfig,
      effectiveRemnicConfig,
      adapterOptions: {
        configOverrides: effectiveRemnicConfig,
        preserveRuntimeDefaults: true,
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
    ...openclawRuntime.runtimeContext,
  });
  const persistedRemnicConfig = sanitizePersistedConfig(
    {
      ...openclawRuntime.remnicConfig,
      lcmEnabled: true,
      gatewayConfig: openclawRuntime.persistedGatewayConfig,
      modelSource: "gateway",
      ...(gatewayAgentId ? { gatewayAgentId } : {}),
      ...(fastGatewayAgentId ? { fastGatewayAgentId } : {}),
    },
  );
  const effectiveRemnicConfig = withAssistantHooks(
    {
      ...openclawRuntime.remnicConfig,
      lcmEnabled: true,
      gatewayConfig,
      modelSource: "gateway",
      ...(gatewayAgentId ? { gatewayAgentId } : {}),
      ...(fastGatewayAgentId ? { fastGatewayAgentId } : {}),
    },
    gatewayResponder,
    structuredJudge,
  );

  return {
    profile,
    remnicConfig: persistedRemnicConfig,
    effectiveRemnicConfig,
    adapterOptions: {
      configOverrides: effectiveRemnicConfig,
      preserveRuntimeDefaults: true,
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
  runtimeContext: FallbackLlmRuntimeContext;
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
    runtimeContext: deriveOpenclawRuntimeContext(filePath),
  };
}

export function deriveOpenclawRuntimeContext(
  configPath: string,
): FallbackLlmRuntimeContext {
  const rootDir = path.dirname(path.resolve(configPath));
  return {
    agentDir: path.join(rootDir, "agents", "main", "agent"),
    workspaceDir: path.join(rootDir, "workspace"),
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
  requestTimeout?: number,
  disableThinking?: boolean,
  apiKey?: string,
  max429WaitMs?: number,
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

  // Issue #566 slice 5 — defense in depth: the CLI rejects
  // `--provider local-llm` without `--base-url`, but programmatic
  // callers that bypass the CLI must also get a clear error rather
  // than silently falling through to an OpenAI default URL in the
  // provider factory.
  if (provider === "local-llm" && !hasBaseUrl) {
    throw new Error(
      `${kind} provider "local-llm" requires a baseUrl ` +
        "(e.g. http://localhost:8080/v1 for llama.cpp).",
    );
  }

  return {
    provider,
    model: model.trim(),
    ...(hasBaseUrl ? { baseUrl: baseUrl!.trim() } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(requestTimeout != null || max429WaitMs != null
      ? { retryOptions: {
          ...(requestTimeout != null ? { timeoutMs: requestTimeout } : {}),
          ...(max429WaitMs != null ? { max429WaitMs } : {}),
        } }
      : {}),
    ...(disableThinking ? { disableThinking: true } : {}),
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
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.retryOptions ? { retryOptions: config.retryOptions } : {}),
    ...(config.disableThinking ? { disableThinking: config.disableThinking } : {}),
  } as ProviderFactoryConfig;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function sanitizeGatewayConfig(config: GatewayConfig): GatewayConfig {
  const sanitized = sanitizePersistedConfig(config);
  return isPlainObject(sanitized) ? sanitized as GatewayConfig : {};
}

function sanitizePersistedConfig(config: unknown): Record<string, unknown> {
  const sanitized = sanitizePersistedValue(config);
  return isPlainObject(sanitized) ? sanitized : {};
}

function sanitizePersistedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePersistedValue(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      next[key] = REDACTED_CONFIG_VALUE;
      continue;
    }
    next[key] = sanitizePersistedValue(entry);
  }
  return next;
}

function isSecretKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/i)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);

  if (segments.length === 0) {
    return false;
  }

  const normalized = segments.join("");
  if (EXACT_SECRET_KEYS.has(normalized as (typeof EXACT_SECRET_KEYS extends Set<infer T> ? T : never))) {
    return true;
  }

  if (
    SECRET_KEY_SEGMENT_SUFFIXES.has(
      normalized as (typeof SECRET_KEY_SEGMENT_SUFFIXES extends Set<infer T> ? T : never),
    )
  ) {
    return true;
  }

  const lastSegment = segments.at(-1);
  if (
    lastSegment &&
    EXACT_SECRET_KEYS.has(lastSegment as (typeof EXACT_SECRET_KEYS extends Set<infer T> ? T : never))
  ) {
    return true;
  }

  for (let width = 2; width <= Math.min(3, segments.length); width += 1) {
    const candidate = segments.slice(-width).join("");
    if (SECRET_KEY_SEGMENT_SUFFIXES.has(candidate as (typeof SECRET_KEY_SEGMENT_SUFFIXES extends Set<infer T> ? T : never))) {
      return true;
    }
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
