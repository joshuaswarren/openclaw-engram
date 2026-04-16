export { loadDaySummaryPrompt } from "./day-summary.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import OpenAI from "openai";
import { createRequire } from "node:module";
import { parseConfig } from "./config.js";
import { initLogger } from "./logger.js";
import { log } from "./logger.js";
import { detectSdkCapabilities, type SdkCapabilities } from "./sdk-compat.js";
import {
  Orchestrator,
  sanitizeSessionKeyForFilename,
  defaultWorkspaceDir,
} from "./orchestrator.js";
import { registerTools } from "./tools.js";
import { registerLcmTools } from "./lcm/index.js";
import { estimateTokens as estimateLcmTokens } from "./lcm/archive.js";
import { registerCli } from "./cli.js";
import { recordObjectiveStateSnapshotsFromAgentMessages } from "./objective-state-writers.js";
import { EngramAccessService } from "./access-service.js";
import { EngramAccessHttpServer } from "./access-http.js";

import {
  hasInlineExplicitCaptureMarkup,
  parseInlineExplicitCaptureNotes,
  persistExplicitCapture,
  queueExplicitCaptureForReview,
  shouldProcessInlineExplicitCapture,
  stripInlineExplicitCaptureNotes,
  validateExplicitCaptureInput,
} from "./explicit-capture.js";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createOpikExporter } from "./opik-exporter.js";
import { readEnvVar, resolveHomeDir } from "./runtime/env.js";
import { migrateFromEngram } from "./migrate/from-engram.js";
import { cleanUserMessage } from "./user-message-cleaning.js";
import { listRemnicPublicArtifacts } from "../packages/plugin-openclaw/src/public-artifacts.js";
import {
  buildMemoryGetTool,
  buildMemorySearchTool,
} from "../packages/plugin-openclaw/src/openclaw-tools/index.js";
import {
  matchesDelimitedPhrase,
  parseDreamNarrativeResponse,
  planDreamEntryFromConsolidation,
  syncDreamSurfaceEntries,
  syncHeartbeatOutcomeLinks,
  syncHeartbeatSurfaceEntries,
} from "../packages/plugin-openclaw/src/runtime-surfaces.js";
import {
  forEachRuntimeSurfaceStorage,
} from "../packages/plugin-openclaw/src/runtime-surface-namespaces.js";
import { buildSessionCommandDescriptors } from "../packages/plugin-openclaw/src/session-command-descriptors.js";
import { validateSlotSelection } from "../packages/plugin-openclaw/src/slot-validator.js";
import { PLUGIN_ID, resolveRemnicPluginEntry } from "../packages/remnic-core/src/plugin-id.js";
import { createFileToggleStore } from "../packages/remnic-core/src/session-toggles.js";
import { appendRecallAuditEntry, pruneRecallAuditEntries } from "../packages/remnic-core/src/recall-audit.js";
import { createActiveRecallEngine } from "../packages/remnic-core/src/active-recall.js";
import {
  buildTurnFingerprint,
  CODEX_THREAD_KEY_PREFIX,
  codexLogicalSessionKey,
  resolveCodexSessionIdentity,
} from "./codex-compat.js";
import { planRecallMode } from "../packages/remnic-core/src/intent.js";
import { resolvePrincipal } from "../packages/remnic-core/src/namespaces/principal.js";
import { createDreamsSurface } from "../packages/remnic-core/src/surfaces/dreams.js";
import { createHeartbeatSurface, type HeartbeatEntry } from "../packages/remnic-core/src/surfaces/heartbeat.js";
import type { ConsolidationObservation } from "../packages/remnic-core/src/types.js";

/**
 * Per-plugin runtime state is scoped by `serviceId` so a single process can host
 * both the canonical `openclaw-remnic` plugin and the legacy `openclaw-engram`
 * shim plugin without them trampling each other's orchestrator/config (#403 P2).
 *
 * Each slot base name is suffixed with `::${serviceId}` — e.g.
 * `__openclawEngramRegistered::openclaw-remnic` and
 * `__openclawEngramRegistered::openclaw-engram` are independent slots. Without
 * this, whichever plugin registered first would force the second one to reuse
 * the first plugin's orchestrator and `memoryDir`/policy despite having a
 * different id — silently operating on the wrong memory store during migration.
 *
 * `ENGRAM_MIGRATION_PROMISE` is intentionally **not** keyed: migrating
 * `~/.engram` → `~/.remnic` is a one-time process-wide operation, not a
 * per-plugin concern, and both plugin ids should observe the same migration.
 */
const ENGRAM_MIGRATION_PROMISE = "__openclawEngramMigrationPromise";

/**
 * CLI dedupe guard — intentionally **unkeyed** (not per-serviceId).
 *
 * CLI commands live in the gateway's central plugin registry, not in per-api
 * state.  In migration installs where both `openclaw-remnic` and
 * `openclaw-engram` plugin ids coexist in one process, the per-serviceId
 * `REGISTERED_GUARD` would give each plugin its own "first registration" and
 * both would call `registerCli()`, creating duplicate command trees.  This
 * global guard ensures CLI registration happens exactly once per process.
 */
const CLI_REGISTERED_GUARD = "__openclawEngramCliRegistered";
const SESSION_COMMANDS_REGISTERED_GUARD =
  "__openclawEngramSessionCommandsRegistered";

/**
 * Process-global count of Remnic plugin services whose `start()` has
 * successfully run (i.e., `didCountStart === true`).  Incremented in
 * `start()`, decremented in `stop()`.  When the count drops to zero, the
 * global `CLI_REGISTERED_GUARD` is cleared so a subsequent `register()`
 * in a fresh reload cycle can re-register CLI commands.
 *
 * This prevents the bug where one of two coexisting plugin ids stops and
 * clears the CLI guard while the other is still running (Codex P2
 * PRRT_kwDORJXyws56WHTe), while still allowing CLI re-registration after
 * a true full stop where the gateway rebuilds its command registry.
 */
const CLI_ACTIVE_SERVICE_COUNT = "__openclawEngramCliActiveServiceCount";

type ServiceKeys = {
  REGISTERED_GUARD: string;
  /** Tracks which api objects have already had hooks bound to prevent duplicate handlers. */
  HOOK_APIS: string;
  ACCESS_SERVICE: string;
  ACCESS_HTTP_SERVER: string;
  /**
   * Guards service.start() against duplicate invocation when multiple api instances
   * each register the service (all registries get registerService, but initialize
   * must only run once per process lifetime). Cleared by stop() so restart cycles
   * re-initialize correctly.
   */
  SERVICE_STARTED: string;
  /**
   * Holds the in-flight initialization Promise while the first registry's start()
   * is running. Concurrent start() calls from other registries await this promise
   * so they do not resolve before the orchestrator and HTTP server are fully ready.
   * Set to null after init completes (success or failure) and cleared on stop().
   */
  INIT_PROMISE: string;
  ORCHESTRATOR: string;
};

function buildServiceKeys(serviceId: string): ServiceKeys {
  const suffix = `::${serviceId}`;
  return {
    REGISTERED_GUARD: `__openclawEngramRegistered${suffix}`,
    HOOK_APIS: `__openclawEngramHookApis${suffix}`,
    ACCESS_SERVICE: `__openclawEngramAccessService${suffix}`,
    ACCESS_HTTP_SERVER: `__openclawEngramAccessHttpServer${suffix}`,
    SERVICE_STARTED: `__openclawEngramServiceStarted${suffix}`,
    INIT_PROMISE: `__openclawEngramInitPromise${suffix}`,
    ORCHESTRATOR: `__openclawEngramOrchestrator${suffix}`,
  };
}
// Workaround: Read config directly from openclaw.json since gateway may not pass it.
// IMPORTANT: Do not log raw config contents (may include secrets).
// Shared helper: read and parse the full plugin entry from openclaw.json.
function loadPluginEntryFromFile(pluginId?: string): Record<string, unknown> | undefined {
  try {
    const explicitConfigPath =
      readEnvVar("OPENCLAW_ENGRAM_CONFIG_PATH") ||
      readEnvVar("OPENCLAW_CONFIG_PATH");
    const homeDir = resolveHomeDir();
    const configPath =
      explicitConfigPath && explicitConfigPath.length > 0
        ? explicitConfigPath
        : path.join(homeDir, ".openclaw", "openclaw.json");
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    // Delegate slot → preferredId → PLUGIN_ID → LEGACY_PLUGIN_ID resolution to
    // the shared helper so all config loaders stay in sync (#403).
    // Pass the active plugin id so shim installs (id="openclaw-engram") prefer
    // their own entry when no slots.memory override is present.
    return resolveRemnicPluginEntry(config, pluginId);
  } catch (err) {
    log.warn(`Failed to load config from file: ${err}`);
    return undefined;
  }
}

function loadPluginConfigFromFile(pluginId?: string): Record<string, unknown> | undefined {
  return loadPluginEntryFromFile(pluginId)?.config as
    | Record<string, unknown>
    | undefined;
}

function loadRawConfigFromFile(): Record<string, unknown> | undefined {
  try {
    const explicitConfigPath =
      readEnvVar("OPENCLAW_ENGRAM_CONFIG_PATH") ||
      readEnvVar("OPENCLAW_CONFIG_PATH");
    const homeDir = resolveHomeDir();
    const configPath =
      explicitConfigPath && explicitConfigPath.length > 0
        ? explicitConfigPath
        : path.join(homeDir, ".openclaw", "openclaw.json");
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    return config && typeof config === "object"
      ? (config as Record<string, unknown>)
      : undefined;
  } catch (err) {
    log.warn(`Failed to load raw OpenClaw config from file: ${err}`);
    return undefined;
  }
}

/**
 * Read the plugin hooks policy from both the API config and the file-backed
 * config, since the gateway may not pass the full config to the plugin.
 */
function readPluginHooksPolicy(
  apiConfig: unknown,
  pluginId?: string,
): Record<string, unknown> | undefined {
  // Try api.config first — delegate slot → preferredId → PLUGIN_ID → LEGACY_PLUGIN_ID
  // resolution to the shared helper so all config loaders stay in sync (#403).
  const apiEntry = resolveRemnicPluginEntry(apiConfig, pluginId);
  const fromApi = apiEntry?.["hooks"] as Record<string, unknown> | undefined;
  if (fromApi && typeof fromApi === "object") return fromApi;
  // Fall back to file-backed config
  return loadPluginEntryFromFile(pluginId)?.["hooks"] as
    | Record<string, unknown>
    | undefined;
}

function isBundledActiveMemoryEnabledForAgent(
  runtimeConfig: unknown,
  fileBackedRuntimeConfig: unknown,
  agentId: string,
): boolean {
  const readMemorySlot = (config: unknown): string | undefined => {
    if (!config || typeof config !== "object") return undefined;
    const plugins = (config as Record<string, unknown>).plugins;
    if (!plugins || typeof plugins !== "object") return undefined;
    const slots = (plugins as Record<string, unknown>).slots;
    if (!slots || typeof slots !== "object") return undefined;
    const memorySlot = (slots as Record<string, unknown>).memory;
    return typeof memorySlot === "string" && memorySlot.length > 0 ? memorySlot : undefined;
  };

  const readActiveMemoryEntry = (config: unknown): Record<string, unknown> | undefined => {
    if (!config || typeof config !== "object") return undefined;
    const plugins = (config as Record<string, unknown>).plugins;
    if (!plugins || typeof plugins !== "object") return undefined;
    const entries = (plugins as Record<string, unknown>).entries;
    if (!entries || typeof entries !== "object") return undefined;
    const activeMemoryEntry = (entries as Record<string, unknown>)["active-memory"];
    return activeMemoryEntry && typeof activeMemoryEntry === "object"
      ? (activeMemoryEntry as Record<string, unknown>)
      : undefined;
  };

  const runtimeMemorySlot = readMemorySlot(runtimeConfig);
  const fileBackedMemorySlot = readMemorySlot(fileBackedRuntimeConfig);
  const effectiveMemorySlot = runtimeMemorySlot ?? fileBackedMemorySlot;
  if (effectiveMemorySlot !== "active-memory") return false;

  const runtimeEntry = readActiveMemoryEntry(runtimeConfig);
  const fileBackedEntry = readActiveMemoryEntry(fileBackedRuntimeConfig);
  const activeMemoryEntry = runtimeEntry ?? fileBackedEntry;
  if (!activeMemoryEntry || typeof activeMemoryEntry !== "object") return false;

  const resolveEnabled = (
    entry: Record<string, unknown> | undefined,
  ): boolean | undefined => {
    return typeof entry?.enabled === "boolean" ? (entry.enabled as boolean) : undefined;
  };

  const runtimeEnabled = resolveEnabled(runtimeEntry);
  if (runtimeEnabled === false) return false;

  const fileBackedEnabled = resolveEnabled(fileBackedEntry);
  if (runtimeEnabled === undefined && fileBackedEnabled === false) return false;

  const resolveAgents = (
    entry: Record<string, unknown> | undefined,
  ): string[] | undefined => {
    const entryConfig = entry?.config;
    if (!entryConfig || typeof entryConfig !== "object") return undefined;
    const agents = (entryConfig as Record<string, unknown>).agents;
    if (!Array.isArray(agents)) return undefined;
    return agents.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  };

  const runtimeAgents = resolveAgents(runtimeEntry);
  if (Array.isArray(runtimeAgents)) {
    return runtimeAgents.includes(agentId);
  }

  const fileBackedAgents = resolveAgents(fileBackedEntry);
  if (Array.isArray(fileBackedAgents)) {
    return fileBackedAgents.includes(agentId);
  }

  return true;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function shouldSkipRecallForSession(
  sessionKey: string,
  cfg: {
    cronRecallMode: "all" | "none" | "allowlist";
    cronRecallAllowlist: string[];
  },
): boolean {
  const isCron = sessionKey.includes(":cron:");
  if (!isCron) return false;

  if (cfg.cronRecallMode === "none") return true;
  if (cfg.cronRecallMode === "all") return false;

  if (cfg.cronRecallAllowlist.length === 0) return true;
  return !cfg.cronRecallAllowlist.some((pattern) => {
    try {
      return wildcardToRegExp(pattern).test(sessionKey);
    } catch {
      return false;
    }
  });
}

function isVerboseRecallRequested(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): boolean {
  const runtime = ctx.runtime as Record<string, unknown> | undefined;
  return (
    ctx.verbose === true ||
    event.verbose === true ||
    runtime?.verbose === true ||
    (ctx.metadata as Record<string, unknown> | undefined)?.verbose === true
  );
}

function summarizeRecallTextForStatus(value: string | null, maxChars: number = 220): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars)).trimEnd()}...`;
}

function buildVerboseRecallHeader(params: {
  sessionKey: string;
  agentId: string;
  latencyMs?: number;
  memoryIds: string[];
  plannerMode?: string;
  toggleState: "enabled" | "disabled-primary" | "disabled-secondary";
  summary: string | null;
}): string[] {
  const status =
    params.toggleState === "enabled"
      ? "enabled"
      : params.toggleState === "disabled-secondary"
        ? "disabled by bundled active-memory"
        : "disabled by Remnic session toggle";
  const summary = params.summary ?? "NONE - no relevant memory";
  return [
    `━━━ Remnic recall (${params.sessionKey}, agent ${params.agentId}) ━━━`,
    `Status: ${status} · Planner: ${params.plannerMode ?? "unknown"} · Memories: ${params.memoryIds.length} · Latency: ${params.latencyMs ?? "?"}ms`,
    summary,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
  ];
}

function resolveActiveRecallChatType(
  ctx: Record<string, unknown>,
): "direct" | "group" | "channel" {
  const provider = String(ctx.messageProvider ?? "").toLowerCase();
  if (
    provider.includes("discord") ||
    provider.includes("slack") ||
    provider.includes("channel")
  ) {
    return ctx.channelId ? "channel" : "group";
  }
  return "direct";
}

function extractRecentTurnsForActiveRecall(
  messages: Array<Record<string, unknown>> | undefined,
): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => {
      const role =
        message.role === "user" || message.role === "assistant"
          ? message.role
          : null;
      const content = extractTextContent(message);
      if (!role || content.length === 0) return null;
      return { role, content };
    })
    .filter(
      (
        value,
      ): value is {
        role: "user" | "assistant";
        content: string;
      } => value !== null,
    );
}

/**
 * Try to use the new SDK's definePluginEntry when available, otherwise return
 * the bare plugin definition object (works on legacy runtimes).
 */
function tryDefinePluginEntry(def: {
  id: string;
  name: string;
  description: string;
  kind: "memory";
  register: (api: OpenClawPluginApi) => void;
}) {
  try {
    const _require = createRequire(import.meta.url);
    const { definePluginEntry } = _require(
      "openclaw/plugin-sdk/plugin-entry",
    ) as {
      definePluginEntry: (d: typeof def) => typeof def;
    };
    return definePluginEntry(def);
  } catch {
    // SDK module not available — legacy runtime; return bare object.
    return def;
  }
}

/** SDK capabilities detected at register() time — available to later tasks. */
let sdkCaps: SdkCapabilities | undefined;

const pluginDefinition = {
  id: PLUGIN_ID,
  name: "Remnic (Local Memory)",
  description:
    "Local-first memory plugin. Uses GPT-5.2 for intelligent extraction and hybrid local retrieval.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    // Capture the id from the definition object so shim re-exports with
    // overridden ids (e.g. "openclaw-engram" in the backward-compat shim)
    // still register the service under the correct id (#403).
    // OpenClaw's cli-metadata loader currently invokes register(api) as an
    // unbound function, so `this` can legitimately be undefined there.
    // Guard that path and fall back to the canonical id when no bound entry
    // object is available.
    const registerThis =
      typeof this === "object" && this !== null
        ? (this as { id?: unknown })
        : undefined;
    const serviceId: string =
      typeof registerThis?.id === "string" && registerThis.id.trim().length > 0
        ? registerThis.id
        : PLUGIN_ID;
    // Scope all per-plugin runtime singletons (orchestrator, start guards,
    // access service, HTTP server, etc.) by serviceId so a migration install
    // can host both `openclaw-remnic` and `openclaw-engram` without the second
    // plugin silently reusing the first plugin's orchestrator/config (#403 P2).
    const keys = buildServiceKeys(serviceId);

    // Initialize logger early (debug off until config is parsed).
    initLogger(api.logger, false);

    const disableRegisterMigration =
      readEnvVar("REMNIC_DISABLE_REGISTER_MIGRATION") === "1" ||
      readEnvVar("OPENCLAW_ENGRAM_DISABLE_REGISTER_MIGRATION") === "1";
    if (!disableRegisterMigration) {
      const migrationPromise = ((globalThis as any)[ENGRAM_MIGRATION_PROMISE] ??=
        migrateFromEngram({
          quiet: true,
          logger: (message) => log.info(message),
        }).catch((error) => {
          log.warn(`register migration failed: ${error}`);
        }));
      void migrationPromise;
    }

    // Detect SDK capabilities for dual-path hook registration.
    sdkCaps = detectSdkCapabilities(api as unknown as Record<string, unknown>);
    log.info(
      `SDK detection: version=${sdkCaps.sdkVersion}, beforePromptBuild=${sdkCaps.hasBeforePromptBuild}, memoryPromptSection=${sdkCaps.hasRegisterMemoryPromptSection}, memoryCapability=${sdkCaps.hasRegisterMemoryCapability}, typedHooks=${sdkCaps.hasTypedHooks}`,
    );

    // Skip heavy initialization in setup-only mode (new SDK channel setup flows)
    if (sdkCaps.registrationMode === "setup-only") {
      log.info("registrationMode=setup-only — skipping full initialization");
      return;
    }

    // Workaround: Load config from file since gateway may not pass it.
    // Pass serviceId so shim installs prefer their own entry (#403).
    const fileConfig = loadPluginConfigFromFile(serviceId);
    const cfg = parseConfig({
      ...fileConfig, // File-backed fallback for runtimes that omit pluginConfig
      ...api.pluginConfig, // Runtime/plugin-supplied config must win
      gatewayConfig: api.config, // Pass gateway config for fallback AI
    });
    // Re-initialize with correct debug setting
    initLogger(api.logger, cfg.debug);
    log.info(
      `initialized (debug=${cfg.debug}, qmdEnabled=${cfg.qmdEnabled}, transcriptEnabled=${cfg.transcriptEnabled}, hourlySummariesEnabled=${cfg.hourlySummariesEnabled})`,
    );
    log.debug(
      `init llm routing (modelSource=${cfg.modelSource}, localLlmEnabled=${cfg.localLlmEnabled}${cfg.localLlmFastEnabled ? `, fastLlm=${cfg.localLlmFastModel || "(primary)"}` : ""})`,
    );
    const fileBackedRawRuntimeConfig = loadRawConfigFromFile();
    const rawRuntimeConfig =
      api.config && typeof api.config === "object"
        ? (api.config as Record<string, unknown>)
        : fileBackedRawRuntimeConfig;
    const slotValidationMode = validateSlotSelection({
      pluginId: serviceId,
      runtimeConfig: rawRuntimeConfig,
      requireExclusive: cfg.slotBehavior.requireExclusiveMemorySlot,
      onMismatch: cfg.slotBehavior.onSlotMismatch,
      logger: api.logger,
    });
    const passiveMode = slotValidationMode === "passive";
    if (passiveMode) {
      log.info(
        `[remnic] memory slot not assigned to ${serviceId}; running passively`,
      );
    }

    // Singleton guard: the gateway calls register() once per agent (each with a
    // different plugin registry). Reuse the orchestrator (heavy object) but always
    // re-register hooks — each api.on() call binds to the caller's registry, so
    // skipping registration leaves later registries with zero hooks.
    //
    // The orchestrator slot is keyed by serviceId, so a same-process migration
    // install with both `openclaw-remnic` and `openclaw-engram` plugin ids loaded
    // gives each plugin its own orchestrator with its own `memoryDir`/policy
    // instead of forcing the second plugin to reuse the first's (#403 P2).
    const existing = (globalThis as any)[keys.ORCHESTRATOR] as
      | Orchestrator
      | undefined;
    const orchestrator = existing?.recall ? existing : new Orchestrator(cfg);
    const isFirstRegistration = !(globalThis as any)[keys.REGISTERED_GUARD];
    (globalThis as any)[keys.REGISTERED_GUARD] = true;

    // Per-api hook deduplication: if the same api object calls register() twice
    // (e.g., during reload edge cases), skip re-binding hooks to avoid double-
    // fired handlers (double recall, double extraction, double reset).
    const hookApis: WeakSet<object> = ((globalThis as any)[keys.HOOK_APIS] ??=
      new WeakSet());
    if (hookApis.has(api)) {
      log.debug(
        "register: this api already has hooks bound — skipping duplicate hook registration",
      );
      return;
    }
    hookApis.add(api);

    if (!isFirstRegistration) {
      log.debug(
        "register called again (new registry); re-registering hooks with shared orchestrator",
      );
    }

    // Expose for inter-plugin discovery (e.g., langsmith tracing).
    // Store under the keyed slot (per-serviceId, authoritative) AND under the
    // unkeyed slot as a "last registered Remnic orchestrator" pointer for
    // cross-plugin observers (langsmith etc.) that don't know the serviceId.
    // Observers use this only for tracing — never for memory reads/writes —
    // so the ambiguity of which plugin it points at is acceptable there.
    (globalThis as any)[keys.ORCHESTRATOR] = orchestrator;
    (globalThis as any).__openclawEngramOrchestrator = orchestrator;
    // Trace callback slot — langsmith (or any observer) will overwrite this.
    // Intentionally unkeyed: tracing is cross-plugin.
    if ((globalThis as any).__openclawEngramTrace === undefined) {
      (globalThis as any).__openclawEngramTrace = undefined;
    }

    const existingAccessService = (globalThis as any)[keys.ACCESS_SERVICE] as
      | EngramAccessService
      | undefined;
    const accessService =
      existingAccessService && (existingAccessService as EngramAccessService)
        ? existingAccessService
        : new EngramAccessService(orchestrator);
    (globalThis as any)[keys.ACCESS_SERVICE] = accessService;

    const existingAccessHttpServer = (globalThis as any)[
      keys.ACCESS_HTTP_SERVER
    ] as EngramAccessHttpServer | undefined;
    const accessHttpServer =
      existingAccessHttpServer &&
      (existingAccessHttpServer as EngramAccessHttpServer)
        ? existingAccessHttpServer
        : new EngramAccessHttpServer({
            service: accessService,
            host: cfg.agentAccessHttp.host,
            port: cfg.agentAccessHttp.port,
            authToken: cfg.agentAccessHttp.authToken,
            principal: cfg.agentAccessHttp.principal,
            maxBodyBytes: cfg.agentAccessHttp.maxBodyBytes,
          });
    (globalThis as any)[keys.ACCESS_HTTP_SERVER] = accessHttpServer;

    const pluginStateDir = path.join(cfg.memoryDir, "state", "plugins", serviceId);
    const togglePrimaryPath = path.join(pluginStateDir, "session-toggles.json");
    const toggleSecondaryPath = cfg.respectBundledActiveMemoryToggle
      ? path.join(cfg.memoryDir, "state", "plugins", "active-memory", "session-toggles.json")
      : undefined;
    const sessionToggleStore = createFileToggleStore(togglePrimaryPath, {
      secondaryReadOnlyPath: toggleSecondaryPath,
    });
    const dreamsSurface = createDreamsSurface();
    const heartbeatSurface = createHeartbeatSurface();
    const dreamNarrativeClient = cfg.openaiApiKey
      ? new OpenAI({
          apiKey: cfg.openaiApiKey,
          ...(cfg.openaiBaseUrl ? { baseURL: cfg.openaiBaseUrl } : {}),
        })
      : null;
    let stopDreamWatcher: (() => void) | null = null;
    let stopHeartbeatWatcher: (() => void) | null = null;
    let removeDreamingObserver: (() => void) | null = null;
    let dreamSurfaceSyncChain: Promise<void> = Promise.resolve();
    let heartbeatSurfaceSyncChain: Promise<void> = Promise.resolve();
    const recallAuditDir = pluginStateDir;
    const lastRecallSummaryBySession = new Map<string, string | null>();

    function resolveWorkspaceRoot(runtimeWorkspaceDir?: string): string {
      return runtimeWorkspaceDir && runtimeWorkspaceDir.trim().length > 0
        ? runtimeWorkspaceDir
        : cfg.workspaceDir;
    }

    function resolveDreamJournalPath(runtimeWorkspaceDir?: string): string {
      const workspaceRoot = resolveWorkspaceRoot(runtimeWorkspaceDir);
      return path.isAbsolute(cfg.dreaming.journalPath)
        ? cfg.dreaming.journalPath
        : path.join(workspaceRoot, cfg.dreaming.journalPath);
    }

    function resolveHeartbeatJournalPath(runtimeWorkspaceDir?: string): string {
      const workspaceRoot = resolveWorkspaceRoot(runtimeWorkspaceDir);
      return path.isAbsolute(cfg.heartbeat.journalPath)
        ? cfg.heartbeat.journalPath
        : path.join(workspaceRoot, cfg.heartbeat.journalPath);
    }

    function queueDreamSurfaceSync(runtimeWorkspaceDir?: string): Promise<void> {
      if (!cfg.dreaming.enabled) return Promise.resolve();
      dreamSurfaceSyncChain = dreamSurfaceSyncChain
        .catch(() => {})
        .then(async () => {
          const journalPath = resolveDreamJournalPath(runtimeWorkspaceDir);
          const entries = await dreamsSurface.read(journalPath);
          await forEachRuntimeSurfaceStorage({
            config: cfg,
            storage: orchestrator.storage,
            getStorageForNamespace: (namespace) =>
              typeof orchestrator.getStorageForNamespace === "function"
                ? orchestrator.getStorageForNamespace(namespace)
                : Promise.resolve(orchestrator.storage),
            work: async (storage) => {
              await syncDreamSurfaceEntries({
                storage,
                entries,
                journalPath,
                maxEntries: cfg.dreaming.maxEntries,
                reindexMemory: async (id) => {
                  await orchestrator.reindexMemoryById(id, {
                    storage,
                  });
                },
              });
            },
          });
        });
      return dreamSurfaceSyncChain;
    }

    function queueHeartbeatSurfaceSync(runtimeWorkspaceDir?: string): Promise<void> {
      if (!cfg.heartbeat.enabled) return Promise.resolve();
      heartbeatSurfaceSyncChain = heartbeatSurfaceSyncChain
        .catch(() => {})
        .then(async () => {
          const journalPath = resolveHeartbeatJournalPath(runtimeWorkspaceDir);
          const entries = await heartbeatSurface.read(journalPath);
          if (entries.length === 0) {
            return;
          }
          await forEachRuntimeSurfaceStorage({
            config: cfg,
            storage: orchestrator.storage,
            getStorageForNamespace: (namespace) =>
              typeof orchestrator.getStorageForNamespace === "function"
                ? orchestrator.getStorageForNamespace(namespace)
                : Promise.resolve(orchestrator.storage),
            work: async (storage) => {
              await syncHeartbeatSurfaceEntries({
                storage,
                entries,
                journalPath,
                reindexMemory: async (id) => {
                  await orchestrator.reindexMemoryById(id, {
                    storage,
                  });
                },
              });
              await syncHeartbeatOutcomeLinks({
                storage,
                entries,
                reindexMemory: async (id) => {
                  await orchestrator.reindexMemoryById(id, {
                    storage,
                  });
                },
                logger: {
                  debug: (message) => log.debug(message),
                },
              });
            },
          });
        });
      return heartbeatSurfaceSyncChain;
    }

    async function maybeAppendDreamFromConsolidation(
      observation: ConsolidationObservation,
    ): Promise<void> {
      if (!cfg.dreaming.enabled) return;
      if (!dreamNarrativeClient) {
        log.debug("dreaming narrative skipped: direct OpenAI Responses client unavailable");
        return;
      }
      const journalPath = resolveDreamJournalPath();
      const existingDreams = await dreamsSurface.read(journalPath);
      const plan = planDreamEntryFromConsolidation({
        observation,
        existingDreams,
        minIntervalMinutes: cfg.dreaming.minIntervalMinutes,
      });
      if (!plan) return;

      const styleInstruction =
        cfg.dreaming.narrativePromptStyle === "diary"
          ? "Write like a compact private diary entry."
          : cfg.dreaming.narrativePromptStyle === "analytical"
            ? "Write like an analytical retrospective with explicit patterns."
            : "Write like a reflective narrative that notices patterns and emotional tone.";
      let rawNarrative = "";
      try {
        const response = await dreamNarrativeClient.responses.create({
          model: cfg.dreaming.narrativeModel ?? cfg.model,
          instructions:
            "You write short reflective dream-journal entries for an AI memory system. " +
            `${styleInstruction} Return exactly this structure:\n` +
            "Title: <short title>\nTags: #tag #tag\nBody:\n<2-4 concise paragraphs>",
          input:
            `The last consolidation spanned ${plan.sessionLikeCount} session-like windows.\n` +
            `Keep the reflection grounded in the evidence below.\n\n` +
            plan.memoryContext.join("\n"),
          temperature: 0.4,
          max_output_tokens: 400,
        });
        rawNarrative =
          typeof response.output_text === "string"
            ? response.output_text
            : JSON.stringify(response.output_text ?? "");
      } catch (error) {
        log.warn(`dreaming narrative generation failed: ${String(error)}`);
        return;
      }
      const parsed = parseDreamNarrativeResponse(
        rawNarrative,
        plan.suggestedTags,
      );
      if (!parsed) return;
      await dreamsSurface.append(journalPath, {
        timestamp: plan.timestamp,
        title: parsed.title,
        body: parsed.body,
        tags: parsed.tags,
      });
      await queueDreamSurfaceSync();
    }

    void pruneRecallAuditEntries(
      recallAuditDir,
      cfg.recallTranscriptRetentionDays,
    ).catch((error) => {
      log.debug(`recall audit prune failed: ${String(error)}`);
    });
    const sessionCommandDescriptors = buildSessionCommandDescriptors(serviceId, {
      toggles: sessionToggleStore,
      getLastRecall: (sessionKey) => orchestrator.getLastRecall(sessionKey),
      getLastRecallSummary: (sessionKey) =>
        lastRecallSummaryBySession.get(sessionKey) ?? null,
      flushSession: async (sessionKey) => {
        await orchestrator.flushSession(sessionKey, {
          reason: "session-command",
        });
      },
    });
    const activeRecallEngine = createActiveRecallEngine(
      {
        recall: async (query, sessionKey) => orchestrator.recall(query, sessionKey),
        getLastRecallSnapshot: (sessionKey) => orchestrator.getLastRecall(sessionKey),
        explainLastRecall:
          cfg.activeRecallAttachRecallExplain === true
            ? async () =>
                await orchestrator
                  .explainLastQmdRecall()
                  .catch(() => null)
            : undefined,
      },
      {
        enabled: cfg.activeRecallEnabled,
        agents: cfg.activeRecallAgents,
        allowedChatTypes: cfg.activeRecallAllowedChatTypes,
        queryMode: cfg.activeRecallQueryMode,
        promptStyle: cfg.activeRecallPromptStyle,
        promptOverride: cfg.activeRecallPromptOverride,
        promptAppend: cfg.activeRecallPromptAppend,
        maxSummaryChars: cfg.activeRecallMaxSummaryChars,
        recentUserTurns: cfg.activeRecallRecentUserTurns,
        recentAssistantTurns: cfg.activeRecallRecentAssistantTurns,
        recentUserChars: cfg.activeRecallRecentUserChars,
        recentAssistantChars: cfg.activeRecallRecentAssistantChars,
        thinking: cfg.activeRecallThinking,
        timeoutMs: cfg.activeRecallTimeoutMs,
        cacheTtlMs: cfg.activeRecallCacheTtlMs,
        persistTranscripts: cfg.activeRecallPersistTranscripts,
        transcriptDir: path.isAbsolute(cfg.activeRecallTranscriptDir)
          ? cfg.activeRecallTranscriptDir
          : path.join(pluginStateDir, cfg.activeRecallTranscriptDir),
        entityGraphDepth: cfg.activeRecallEntityGraphDepth,
        includeCausalTrajectories: cfg.activeRecallIncludeCausalTrajectories,
        includeDaySummary: cfg.activeRecallIncludeDaySummary,
        attachRecallExplain: cfg.activeRecallAttachRecallExplain,
        modelOverride: cfg.activeRecallModel,
        modelFallbackPolicy: cfg.activeRecallModelFallbackPolicy,
      },
    );

    if (!passiveMode) {
    // ========================================================================
    // HOOK: before_prompt_build / before_agent_start — Inject memory context
    // ========================================================================
    // When registerMemoryPromptSection is available (preferred path), skip the
    // recall hook entirely to avoid dual memory injection.
    // Uses literal hook names so src/compat/checks.ts parseHookRegistrations()
    // can statically detect them.
    // Respect allowPromptInjection=false: the gateway only gates typed hooks,
    // NOT section builders, so we must check the policy ourselves.
    // Read from both api.config and file-backed config for installs where
    // the gateway doesn't pass the full config object.
    const hooksPolicy = readPluginHooksPolicy(api.config, serviceId);
    const promptInjectionAllowed = hooksPolicy?.allowPromptInjection !== false;

    // True when the section builder will be registered (capability + policy).
    // Must be determined before the hook registration block below.
    const useMemoryPromptSection =
      sdkCaps.hasRegisterMemoryPromptSection &&
      typeof api.registerMemoryPromptSection === "function" &&
      promptInjectionAllowed;
    const warnedBundledActiveMemoryCollisionAgents = new Set<string>();

    // Per-session cache: shared by the hook fallback path (populated when only
    // registerMemoryCapability is available) and the registerMemoryPromptSection
    // path (populated by the async pre-compute hook). Declared early so both
    // paths and the closure-captured handlers below can reference it without
    // TDZ surprises.
    const cachedMemoryBySession = new Map<string, string[] | null>();
    const cachedMemoryByCodexThread = new Map<string, string[] | null>();
    const codexThreadBySession = new Map<string, string>();
    const codexBufferKeyBySession = new Map<string, string>();
    const codexSessionsByThread = new Map<string, Set<string>>();
    const codexSessionsByBufferKey = new Map<string, Set<string>>();
    const codexMessageCountByBufferKey = new Map<string, number>();
    let codexCompactionModeLogged = false;

    function resolveStoredCodexThreadId(sessionKey: string): string | null {
      const threadId = codexThreadBySession.get(sessionKey);
      return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
    }

    function resolveStoredCodexBufferKey(sessionKey: string): string | null {
      const bufferKey = codexBufferKeyBySession.get(sessionKey);
      return typeof bufferKey === "string" && bufferKey.length > 0
        ? bufferKey
        : null;
    }

    function addSessionToCodexIndex(
      index: Map<string, Set<string>>,
      key: string,
      sessionKey: string,
    ): void {
      const sessions = index.get(key) ?? new Set<string>();
      sessions.add(sessionKey);
      index.set(key, sessions);
    }

    function removeSessionFromCodexIndex(
      index: Map<string, Set<string>>,
      key: string,
      sessionKey: string,
    ): boolean {
      const sessions = index.get(key);
      if (!sessions) return true;
      sessions.delete(sessionKey);
      if (sessions.size === 0) {
        index.delete(key);
        return true;
      }
      return false;
    }

    function resolveCodexCompactionBaselineKey(
      sessionKey: string,
      providerThreadId?: string | null,
    ): string | null {
      const resolvedThreadId =
        providerThreadId ?? resolveStoredCodexThreadId(sessionKey);
      if (!resolvedThreadId) return null;
      const logicalSessionKey =
        cfg.codexCompat.threadIdBufferKeying !== false
          ? codexLogicalSessionKey(resolvedThreadId)
          : sessionKey;
      return resolveExtractionBufferKey(sessionKey, logicalSessionKey);
    }

    function rememberCodexThread(
      sessionKey: string,
      providerThreadId: string | null,
    ): void {
      if (!providerThreadId) return;
      const previousThreadId = resolveStoredCodexThreadId(sessionKey);
      const previousBufferKey = resolveStoredCodexBufferKey(sessionKey);
      const nextBufferKey = resolveCodexCompactionBaselineKey(
        sessionKey,
        providerThreadId,
      );
      if (
        previousThreadId === providerThreadId &&
        previousBufferKey === nextBufferKey
      ) {
        return;
      }
      if (previousBufferKey) {
        const bufferWasEmptied = removeSessionFromCodexIndex(
          codexSessionsByBufferKey,
          previousBufferKey,
          sessionKey,
        );
        if (bufferWasEmptied) {
          codexMessageCountByBufferKey.delete(previousBufferKey);
        }
      }
      if (previousThreadId) {
        const threadWasEmptied = removeSessionFromCodexIndex(
          codexSessionsByThread,
          previousThreadId,
          sessionKey,
        );
        if (threadWasEmptied) {
          cachedMemoryByCodexThread.delete(previousThreadId);
        }
      }
      codexThreadBySession.set(sessionKey, providerThreadId);
      if (nextBufferKey) {
        codexBufferKeyBySession.set(sessionKey, nextBufferKey);
        addSessionToCodexIndex(
          codexSessionsByBufferKey,
          nextBufferKey,
          sessionKey,
        );
      }
      addSessionToCodexIndex(codexSessionsByThread, providerThreadId, sessionKey);
    }

    function forgetCodexThread(
      sessionKey: string,
      providerThreadId?: string | null,
    ): void {
      const resolvedThreadId =
        providerThreadId ?? resolveStoredCodexThreadId(sessionKey);
      const resolvedBufferKey =
        resolveStoredCodexBufferKey(sessionKey) ??
        resolveCodexCompactionBaselineKey(sessionKey, resolvedThreadId);
      if (resolvedBufferKey) {
        const bufferWasEmptied = removeSessionFromCodexIndex(
          codexSessionsByBufferKey,
          resolvedBufferKey,
          sessionKey,
        );
        if (bufferWasEmptied) {
          codexMessageCountByBufferKey.delete(resolvedBufferKey);
        }
      }
      if (resolvedThreadId) {
        const threadWasEmptied = removeSessionFromCodexIndex(
          codexSessionsByThread,
          resolvedThreadId,
          sessionKey,
        );
        if (threadWasEmptied) {
          cachedMemoryByCodexThread.delete(resolvedThreadId);
        }
      }
      codexThreadBySession.delete(sessionKey);
      codexBufferKeyBySession.delete(sessionKey);
    }

    function clearCodexCompatCaches(
      sessionKey: string,
      providerThreadId?: string | null,
      options?: {
        preserveMessageCount?: boolean;
        preserveThreadBinding?: boolean;
      },
    ): void {
      cachedMemoryBySession.delete(sessionKey);
      const resolvedThreadId =
        providerThreadId ?? resolveStoredCodexThreadId(sessionKey);
      const resolvedBufferKey =
        resolveStoredCodexBufferKey(sessionKey) ??
        resolveCodexCompactionBaselineKey(sessionKey, resolvedThreadId);
      if (resolvedThreadId) {
        cachedMemoryByCodexThread.delete(resolvedThreadId);
      }
      if (resolvedBufferKey && options?.preserveMessageCount !== true) {
        const sessionsForBuffer = codexSessionsByBufferKey.get(resolvedBufferKey);
        const otherSessionsRemain =
          options?.preserveThreadBinding === true ||
          Array.from(sessionsForBuffer ?? []).some(
            (boundSessionKey) => boundSessionKey !== sessionKey,
          );
        if (!otherSessionsRemain) {
          codexMessageCountByBufferKey.delete(resolvedBufferKey);
        }
      }
      if (options?.preserveThreadBinding !== true) {
        if (resolvedBufferKey) {
          removeSessionFromCodexIndex(
            codexSessionsByBufferKey,
            resolvedBufferKey,
            sessionKey,
          );
        }
        if (resolvedThreadId) {
          removeSessionFromCodexIndex(
            codexSessionsByThread,
            resolvedThreadId,
            sessionKey,
          );
        }
        codexThreadBySession.delete(sessionKey);
        codexBufferKeyBySession.delete(sessionKey);
      }
    }

    function hasExplicitProviderIdentity(
      source: Record<string, unknown> | undefined,
    ): boolean {
      if (!source || typeof source !== "object") return false;
      if (typeof source.messageProvider === "string" && source.messageProvider.length > 0) {
        return true;
      }
      if (typeof source.providerId === "string" && source.providerId.length > 0) {
        return true;
      }
      if (typeof source.providerName === "string" && source.providerName.length > 0) {
        return true;
      }
      if (typeof source.modelId === "string" && source.modelId.length > 0) {
        return true;
      }
      if (typeof source.model === "string" && source.model.length > 0) {
        return true;
      }
      if (
        typeof source.providerThreadId === "string" &&
        source.providerThreadId.length > 0
      ) {
        return true;
      }
      if (typeof source.codexThreadId === "string" && source.codexThreadId.length > 0) {
        return true;
      }
      if (source.provider && typeof source.provider === "object") {
        const provider = source.provider as Record<string, unknown>;
        return (
          (typeof provider.id === "string" && provider.id.length > 0) ||
          (typeof provider.name === "string" && provider.name.length > 0) ||
          (typeof provider.model === "string" && provider.model.length > 0) ||
          (typeof provider.modelId === "string" && provider.modelId.length > 0) ||
          (typeof provider.threadId === "string" && provider.threadId.length > 0)
        );
      }
      return false;
    }

    function cachePromptMemoryLines(
      sessionKey: string,
      providerThreadId: string | null,
      memoryLines: string[] | null,
    ): void {
      cachedMemoryBySession.set(sessionKey, memoryLines);
      if (providerThreadId) {
        rememberCodexThread(sessionKey, providerThreadId);
        cachedMemoryByCodexThread.set(providerThreadId, memoryLines);
      }
    }

    function consumePromptMemoryLines(
      sessionKey: string,
      options?: { destructive?: boolean },
    ): string[] | null {
      const destructive = options?.destructive !== false;
      const hasSessionLines = cachedMemoryBySession.has(sessionKey);
      const sessionLines = hasSessionLines
        ? (cachedMemoryBySession.get(sessionKey) ?? null)
        : null;
      const providerThreadId = resolveStoredCodexThreadId(sessionKey);
      const threadLines = providerThreadId
        ? (cachedMemoryByCodexThread.get(providerThreadId) ?? null)
        : null;
      const resolved = hasSessionLines ? sessionLines : threadLines;
      if (!destructive) return resolved;
      cachedMemoryBySession.delete(sessionKey);
      if (providerThreadId) {
        cachedMemoryByCodexThread.delete(providerThreadId);
      }
      return resolved;
    }

    function resolveSessionIdentity(
      sessionKey: string,
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) {
      const base = resolveCodexSessionIdentity({
        sessionKey,
        event,
        ctx,
        codexCompat: cfg.codexCompat,
      });
      const explicitProviderIdentity =
        hasExplicitProviderIdentity(event) || hasExplicitProviderIdentity(ctx);
      const previousCodexThreadId =
        explicitProviderIdentity && !base.isCodex
          ? resolveStoredCodexThreadId(sessionKey)
          : null;
      const previousCodexBufferKey = previousCodexThreadId
        ? resolveStoredCodexBufferKey(sessionKey) ??
          resolveCodexCompactionBaselineKey(sessionKey, previousCodexThreadId)
        : null;
      const rememberedThreadId =
        base.providerThreadId ??
        (base.isCodex ? resolveStoredCodexThreadId(sessionKey) : null);
      return {
        ...base,
        providerThreadId: rememberedThreadId,
        logicalSessionKey:
          base.isCodex &&
          cfg.codexCompat.threadIdBufferKeying !== false &&
          rememberedThreadId
            ? codexLogicalSessionKey(rememberedThreadId)
            : base.logicalSessionKey,
        previousCodexThreadId,
        previousCodexBufferKey,
      };
    }

    async function flushAndForgetCodexThreadOnProviderSwitch(
      sessionKey: string,
      sessionIdentity: {
        isCodex: boolean;
        previousCodexThreadId?: string | null;
        previousCodexBufferKey?: string | null;
      },
    ): Promise<void> {
      if (sessionIdentity.isCodex || !sessionIdentity.previousCodexThreadId) {
        return;
      }
      const bufferKey = sessionIdentity.previousCodexBufferKey;
      if (!bufferKey) {
        forgetCodexThread(sessionKey, sessionIdentity.previousCodexThreadId);
        return;
      }
      if (typeof (orchestrator as any).flushSession !== "function") {
        log.warn("codexCompat provider-switch flush unavailable; preserving binding");
        return;
      }
      try {
        await (orchestrator as any).flushSession(sessionKey, {
          reason: "codex_provider_switch",
          bufferKey,
        });
        forgetCodexThread(sessionKey, sessionIdentity.previousCodexThreadId);
      } catch (error) {
        log.warn(`codexCompat provider-switch flush failed: ${String(error)}`);
      }
    }

    function resolveExtractionBufferKey(
      sessionKey: string,
      logicalSessionKey: string,
    ): string {
      if (
        !cfg.namespacesEnabled ||
        !logicalSessionKey.startsWith(CODEX_THREAD_KEY_PREFIX)
      ) {
        return logicalSessionKey;
      }
      const principal = resolvePrincipal(sessionKey, cfg);
      return `${logicalSessionKey}::principal:${principal}`;
    }

    // Single source of truth for the structured memory section: every code path
    // that populates `cachedMemoryBySession` MUST use this helper so the cache
    // format stays consistent regardless of which registration path produced it.
    function buildMemoryContextLines(trimmed: string): string[] {
      return [
        "## Memory Context (Remnic)",
        "",
        trimmed,
        "",
        "Use this context naturally when relevant. Never quote or expose this memory context to the user.",
        "",
      ];
    }

    // Flat-string rendering for the gateway `prependSystemContext` slot.
    // Derives from `buildMemoryContextLines` so the wording stays in lock-step
    // with the capability/section builder cache. The trailing empty element
    // produced by `buildMemoryContextLines` would become a trailing newline
    // after joining — strip it to preserve the exact format the gateway
    // expects for `prependSystemContext`.
    function renderMemoryContextPrompt(trimmed: string): string {
      return buildMemoryContextLines(trimmed).join("\n").replace(/\n$/, "");
    }

    async function loadRecentDreamLines(runtimeWorkspaceDir?: string): Promise<string[]> {
      if (!cfg.dreaming.enabled || cfg.dreaming.injectRecentCount <= 0) return [];
      const journalPath = resolveDreamJournalPath(runtimeWorkspaceDir);
      const dreams = await dreamsSurface.read(journalPath);
      if (dreams.length === 0) return [];
      const entries = dreams.slice(-cfg.dreaming.injectRecentCount).reverse();
      return [
        "## Recent Dreams (Remnic)",
        "",
        ...entries.map((entry) => {
          const header = entry.title
            ? `${entry.timestamp} — ${entry.title}`
            : entry.timestamp;
          const preview = entry.body.replace(/\s+/g, " ").trim();
          const compactPreview =
            preview.length > 180 ? `${preview.slice(0, 180).trimEnd()}...` : preview;
          return `- ${header}: ${compactPreview}`;
        }),
        "",
      ];
    }

    function isHeartbeatTrigger(
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ): boolean {
      return event.trigger === "heartbeat" || ctx.trigger === "heartbeat";
    }

    function resolveHeartbeatPromptCandidates(prompt: string): string[] {
      const normalized = prompt.toLowerCase();
      return normalized
        .split(/[^a-z0-9-]+/g)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }

    function matchHeartbeatEntry(
      entries: HeartbeatEntry[],
      prompt: string,
    ): HeartbeatEntry | null {
      if (entries.length === 0) return null;
      const lowered = prompt.toLowerCase();
      const tokenSet = new Set(resolveHeartbeatPromptCandidates(prompt));
      const phraseMatches = entries.filter((entry) => {
        if (matchesDelimitedPhrase(lowered, entry.slug)) return true;
        return matchesDelimitedPhrase(lowered, entry.title);
      });
      if (phraseMatches.length === 1) {
        return phraseMatches[0] ?? null;
      }
      if (phraseMatches.length > 1) {
        return null;
      }
      const tokenMatches = entries.filter((entry) => {
        const slugTokens = entry.slug.toLowerCase().split("-").filter(Boolean);
        return slugTokens.length > 0 && slugTokens.every((token) => tokenSet.has(token));
      });
      if (tokenMatches.length === 1) {
        return tokenMatches[0] ?? null;
      }
      if (tokenMatches.length > 1) {
        return null;
      }
      return entries.length === 1 ? entries[0] ?? null : null;
    }

    function looksLikeHeartbeatPrompt(prompt: string): boolean {
      const lowered = prompt.trim().toLowerCase();
      return (
        lowered.startsWith("read heartbeat.md") ||
        lowered.startsWith("run the following periodic tasks")
      );
    }

    async function loadHeartbeatContextLines(params: {
      prompt: string;
      event: Record<string, unknown>;
      ctx: Record<string, unknown>;
    }): Promise<string[] | null> {
      if (!cfg.heartbeat.enabled) return null;
      const sessionKey =
        typeof params.ctx?.sessionKey === "string" ? params.ctx.sessionKey : undefined;
      const heartbeatNamespace =
        typeof orchestrator.resolveSelfNamespace === "function"
          ? orchestrator.resolveSelfNamespace(sessionKey)
          : undefined;
      const heartbeatStorage =
        typeof orchestrator.getStorageForNamespace === "function"
          ? await orchestrator.getStorageForNamespace(heartbeatNamespace)
          : orchestrator.storage;
      const runtimeWorkspaceDir = params.ctx?.workspaceDir as string | undefined;
      const journalPath = resolveHeartbeatJournalPath(runtimeWorkspaceDir);
      const entries = await heartbeatSurface.read(journalPath);
      if (entries.length === 0) return null;

      const runtimeSignal = isHeartbeatTrigger(params.event, params.ctx);
      const useRuntimeSignal =
        cfg.heartbeat.detectionMode === "runtime-signal" ||
        (cfg.heartbeat.detectionMode === "auto" && runtimeSignal);
      const useHeuristic =
        cfg.heartbeat.detectionMode === "heuristic" ||
        (cfg.heartbeat.detectionMode === "auto" && !runtimeSignal);
      if (!useRuntimeSignal && !useHeuristic) return null;
      if (!runtimeSignal && useRuntimeSignal) return null;
      if (!runtimeSignal && useHeuristic && !looksLikeHeartbeatPrompt(params.prompt)) {
        return null;
      }

      const activeEntry = matchHeartbeatEntry(entries, params.prompt);
      if (!activeEntry) return null;
      await syncHeartbeatOutcomeLinks({
        storage: heartbeatStorage,
        entries,
        reindexMemory: async (id) => {
          await orchestrator.reindexMemoryById(id, {
            storage: heartbeatStorage,
          });
        },
      });

      const allMemories = await heartbeatStorage.readAllMemories().catch(() => []);
      const previousRuns = allMemories
        .filter((memory) => {
          if (
            memory.frontmatter.structuredAttributes?.remnicSurfaceType ===
            "heartbeat"
          ) {
            return false;
          }
          const relatedSlug =
            memory.frontmatter.structuredAttributes?.relatedHeartbeatSlug;
          if (relatedSlug === activeEntry.slug) return true;
          return (memory.frontmatter.tags ?? []).some(
            (tag) => tag === `heartbeat:${activeEntry.slug}`,
          );
        })
        .sort((a, b) =>
          (b.frontmatter.updated ?? b.frontmatter.created).localeCompare(
            a.frontmatter.updated ?? a.frontmatter.created,
          ),
        )
        .slice(0, cfg.heartbeat.maxPreviousRuns);

      const lines = [
        "## Active Heartbeat (Remnic)",
        "",
        `- Slug: ${activeEntry.slug}`,
        `- Title: ${activeEntry.title}`,
      ];
      if (activeEntry.schedule) {
        lines.push(`- Schedule: ${activeEntry.schedule}`);
      }
      if (activeEntry.tags.length > 0) {
        lines.push(`- Tags: ${activeEntry.tags.join(", ")}`);
      }
      lines.push("", activeEntry.body, "");
      if (previousRuns.length > 0) {
        lines.push("## Previous Runs", "");
        for (const memory of previousRuns) {
          const preview = memory.content.replace(/\s+/g, " ").trim();
          const compactPreview =
            preview.length > 220 ? `${preview.slice(0, 220).trimEnd()}...` : preview;
          lines.push(`- ${compactPreview}`);
        }
        lines.push("");
      }
      return lines;
    }

    async function recallHookHandler(
      hookLabel: string,
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) {
      // Prefer event.prompt; fall back to extracting the last user message
      // from event.messages (before_prompt_build may only provide messages).
      let prompt = event.prompt as string | undefined;
      if ((!prompt || prompt.length < 5) && Array.isArray(event.messages)) {
        const msgs = event.messages as Array<Record<string, unknown>>;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]?.role === "user") {
            // Handle both string and block-based content shapes
            const text = extractTextContent(msgs[i] as Record<string, unknown>);
            if (text.length >= 5) {
              prompt = text;
              break;
            }
          }
        }
      }
      const sessionKey = (ctx?.sessionKey as string) ?? "default";
      const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
      await flushAndForgetCodexThreadOnProviderSwitch(sessionKey, sessionIdentity);
      rememberCodexThread(sessionKey, sessionIdentity.providerThreadId);
      if (sessionIdentity.isCodex && !codexCompactionModeLogged) {
        const mode =
          cfg.codexCompat.compactionFlushMode === "auto"
            ? "auto compaction flush mode (signal + heuristic)"
            : `${cfg.codexCompat.compactionFlushMode} compaction flush mode`;
        log.info(
          `codexCompat enabled: using ${mode} for bundled Codex sessions`,
        );
        codexCompactionModeLogged = true;
      }
      if (
        hookLabel === "before_prompt_build" &&
        sessionIdentity.isCodex &&
        sessionIdentity.providerThreadId &&
        (cfg.codexCompat.compactionFlushMode === "heuristic" ||
          cfg.codexCompat.compactionFlushMode === "auto")
      ) {
        const currentCount = sessionIdentity.messageCount;
        const codexBaselineKey = resolveCodexCompactionBaselineKey(
          sessionKey,
          sessionIdentity.providerThreadId,
        );
        const previousCount = codexBaselineKey
          ? codexMessageCountByBufferKey.get(codexBaselineKey)
          : undefined;
        let shouldPersistMessageCount = typeof currentCount === "number";
        if (
          typeof currentCount === "number" &&
          typeof previousCount === "number" &&
          currentCount < previousCount
        ) {
          try {
            await orchestrator.flushSession(sessionKey, {
              reason: "codex_compaction_heuristic",
              bufferKey: resolveExtractionBufferKey(
                sessionKey,
                sessionIdentity.logicalSessionKey,
              ),
            });
            clearCodexCompatCaches(sessionKey, sessionIdentity.providerThreadId);
            rememberCodexThread(sessionKey, sessionIdentity.providerThreadId);
            log.info(
              `codexCompat heuristic flush: thread=${sessionIdentity.providerThreadId} messages ${previousCount} -> ${currentCount}`,
            );
          } catch (error) {
            shouldPersistMessageCount = false;
            log.warn(`codexCompat heuristic flush failed: ${String(error)}`);
          }
        }
        if (
          typeof currentCount === "number" &&
          shouldPersistMessageCount &&
          codexBaselineKey
        ) {
          codexMessageCountByBufferKey.set(codexBaselineKey, currentCount);
        }
      }
      if (!prompt || prompt.length < 5) return;

      const runtimeAgent = (ctx.runtime as Record<string, unknown> | undefined)
        ?.agent as Record<string, unknown> | undefined;
      const agentId =
        (ctx?.agentId as string | undefined) ??
        (runtimeAgent?.id as string | undefined) ??
        "main";
      const verboseRequested = cfg.verboseRecallVisibility !== false &&
        isVerboseRecallRequested(event, ctx);
      log.debug(
        `${hookLabel}: sessionKey=${sessionKey}, promptLen=${prompt.length}`,
      );
      log.debug(
        `${hookLabel}: cronRecallMode=${cfg.cronRecallMode}, allowlistCount=${cfg.cronRecallAllowlist.length}`,
      );
      if (sessionKey.includes(":cron:") && cfg.cronRecallMode === "allowlist") {
        const matchedPattern = cfg.cronRecallAllowlist.find((pattern) => {
          const re = wildcardToRegExp(pattern);
          return re.test(sessionKey);
        });
        log.debug(
          `${hookLabel}: cron allowlist match=${matchedPattern ? "yes" : "no"} pattern=${matchedPattern ?? "none"}`,
        );
      }

      if (shouldSkipRecallForSession(sessionKey, cfg)) {
        log.debug(
          `${hookLabel}: skip recall for cron session ${sessionKey} (mode=${cfg.cronRecallMode})`,
        );
        return;
      }

      const toggleState =
        cfg.sessionTogglesEnabled !== false
          ? await sessionToggleStore.resolve(sessionKey, agentId)
          : {
              disabled: false,
              source: "none" as const,
            };
      const auditToggleState =
        toggleState.disabled === true
          ? toggleState.source === "secondary"
            ? "disabled-secondary"
            : "disabled-primary"
          : "enabled";
      if (toggleState.disabled) {
        lastRecallSummaryBySession.set(sessionKey, null);
        if (cfg.recallTranscriptsEnabled) {
          await appendRecallAuditEntry(recallAuditDir, {
            ts: new Date().toISOString(),
            sessionKey,
            agentId,
            trigger: hookLabel,
            queryText: prompt.slice(0, 2000),
            candidateMemoryIds: [],
            summary: null,
            injectedChars: 0,
            toggleState: auditToggleState,
          }).catch((error) => {
            log.debug(`recall audit append failed: ${String(error)}`);
          });
        }
        if (!verboseRequested) return;
        const verboseLines = buildVerboseRecallHeader({
          sessionKey,
          agentId,
          memoryIds: [],
          plannerMode: "disabled",
          toggleState: auditToggleState,
          summary: null,
        });
        const verbosePrompt = verboseLines.join("\n").replace(/\n$/, "");
        if (hookLabel === "before_prompt_build") {
          return useMemoryPromptSection
            ? { memoryLines: verboseLines }
            : { prependSystemContext: verbosePrompt, memoryLines: verboseLines };
        }
        return {
          prependSystemContext: verbosePrompt,
          prependContext: verbosePrompt,
          memoryLines: verboseLines,
        };
      }

      try {
        await orchestrator.maybeRunFileHygiene().catch(() => undefined);

        const heartbeatLines = await loadHeartbeatContextLines({
          prompt,
          event,
          ctx,
        }).catch(() => null);
        if (heartbeatLines && heartbeatLines.length > 0) {
          lastRecallSummaryBySession.set(
            sessionKey,
            summarizeRecallTextForStatus(heartbeatLines.join(" ")),
          );
          const verboseLines = verboseRequested
            ? buildVerboseRecallHeader({
                sessionKey,
                agentId,
                memoryIds: [],
                plannerMode: "heartbeat",
                toggleState: auditToggleState,
                summary: summarizeRecallTextForStatus(heartbeatLines.join(" ")),
              })
            : [];
          const mergedLines = [...verboseLines, ...heartbeatLines];
          const heartbeatPrompt = mergedLines.join("\n").replace(/\n$/, "");
          if (hookLabel === "before_prompt_build") {
            return useMemoryPromptSection
              ? { memoryLines: mergedLines }
              : { prependSystemContext: heartbeatPrompt, memoryLines: mergedLines };
          }
          return {
            prependSystemContext: heartbeatPrompt,
            prependContext: heartbeatPrompt,
            memoryLines: mergedLines,
          };
        }

        if (orchestrator.config.compactionResetEnabled) {
          const agentWorkspace = ctx?.workspaceDir as string | undefined;
          if (agentWorkspace) {
            orchestrator.setRecallWorkspaceOverride(sessionKey, agentWorkspace);
          }
        }
        const plannerPreflightMode = planRecallMode(prompt);
        const bundledActiveMemoryEnabledForAgent =
          isBundledActiveMemoryEnabledForAgent(
            rawRuntimeConfig,
            fileBackedRawRuntimeConfig,
            agentId,
          );
        const shouldWarnAndSuppressBundledActiveMemoryCollision =
          cfg.activeRecallEnabled &&
          !cfg.activeRecallAllowChainedActiveMemory &&
          bundledActiveMemoryEnabledForAgent;
        if (
          shouldWarnAndSuppressBundledActiveMemoryCollision &&
          !warnedBundledActiveMemoryCollisionAgents.has(agentId)
        ) {
          warnedBundledActiveMemoryCollisionAgents.add(agentId);
          log.warn(
            `active recall suppressed because bundled active-memory plugin is enabled for agent "${agentId}" while activeRecallAllowChainedActiveMemory=false`,
          );
        }
        const shouldSkipChainedActiveRecall =
          plannerPreflightMode === "no_recall" ||
          shouldWarnAndSuppressBundledActiveMemoryCollision;
        const activeRecallResult = shouldSkipChainedActiveRecall
          ? null
          : await activeRecallEngine
              .run({
                sessionKey,
                agentId,
                chatType: resolveActiveRecallChatType(ctx),
                recentTurns: extractRecentTurnsForActiveRecall(
                  Array.isArray(event.messages)
                    ? (event.messages as Array<Record<string, unknown>>)
                    : undefined,
                ),
                currentMessage: prompt,
              })
              .catch((error) => {
                log.debug(`active recall fallback failed: ${String(error)}`);
                return null;
              });
        const activeRecallLines =
          activeRecallResult?.summary && activeRecallResult.summary.length > 0
            ? ["## Active Recall (Remnic)", "", activeRecallResult.summary, ""]
            : [];
        const dreamLines = await loadRecentDreamLines(
          ctx?.workspaceDir as string | undefined,
        ).catch(() => []);
        const context = await orchestrator.recall(prompt, sessionKey);
        log.debug(
          `${hookLabel}: recall returned ${context?.length ?? 0} chars`,
        );
        const lastRecall = orchestrator.getLastRecall(sessionKey);
        const plannerSuppressesAuxiliaryRecall =
          lastRecall?.plannerMode === "no_recall";
        const auxiliaryDreamLines = plannerSuppressesAuxiliaryRecall ? [] : dreamLines;
        const auxiliaryActiveRecallLines = plannerSuppressesAuxiliaryRecall
          ? []
          : activeRecallLines;
        const memoryIds = lastRecall?.memoryIds ?? [];
        if (!context) {
          const auxiliarySummary =
            summarizeRecallTextForStatus(activeRecallResult?.summary ?? null) ??
            summarizeRecallTextForStatus(
              [...auxiliaryDreamLines, ...auxiliaryActiveRecallLines].join(" "),
            ) ??
            (verboseRequested
              ? "Remnic recall metadata injected without matching memory context."
              : null);
          const verboseLines = verboseRequested
            ? buildVerboseRecallHeader({
                sessionKey,
                agentId,
                latencyMs: lastRecall?.latencyMs,
                memoryIds,
                plannerMode: lastRecall?.plannerMode,
                toggleState: auditToggleState,
                summary: auxiliarySummary,
              })
            : [];
          const mergedLines = [
            ...verboseLines,
            ...auxiliaryDreamLines,
            ...auxiliaryActiveRecallLines,
          ];
          const auxiliaryPrompt = mergedLines.join("\n").replace(/\n$/, "");
          lastRecallSummaryBySession.set(
            sessionKey,
            auxiliarySummary,
          );
          if (cfg.recallTranscriptsEnabled) {
            await appendRecallAuditEntry(recallAuditDir, {
              ts: new Date().toISOString(),
              sessionKey,
              agentId,
              trigger: hookLabel,
              queryText: prompt.slice(0, 2000),
              candidateMemoryIds: memoryIds,
              summary: auxiliarySummary,
              injectedChars: auxiliaryPrompt.length,
              toggleState: auditToggleState,
              latencyMs: lastRecall?.latencyMs,
              plannerMode: lastRecall?.plannerMode,
              requestedMode: lastRecall?.requestedMode,
              fallbackUsed: lastRecall?.fallbackUsed,
            }).catch((error) => {
              log.debug(`recall audit append failed: ${String(error)}`);
            });
          }
          if (mergedLines.length === 0) return;
          if (hookLabel === "before_prompt_build") {
            return useMemoryPromptSection
              ? { memoryLines: mergedLines }
              : { prependSystemContext: auxiliaryPrompt, memoryLines: mergedLines };
          }
          return {
            prependSystemContext: auxiliaryPrompt,
            prependContext: auxiliaryPrompt,
            memoryLines: mergedLines,
          };
        }

        const maxChars = cfg.recallBudgetChars;
        if (maxChars === 0) return;
        const trimmed =
          context.length > maxChars
            ? context.slice(0, maxChars) + "\n\n...(memory context trimmed)"
            : context;
        const summaryText =
          summarizeRecallTextForStatus(activeRecallResult?.summary ?? null) ??
          summarizeRecallTextForStatus(trimmed);
        lastRecallSummaryBySession.set(sessionKey, summaryText);
        if (cfg.recallTranscriptsEnabled) {
          await appendRecallAuditEntry(recallAuditDir, {
            ts: new Date().toISOString(),
            sessionKey,
            agentId,
            trigger: hookLabel,
            queryText: prompt.slice(0, 2000),
            candidateMemoryIds: memoryIds,
            summary: summaryText,
            injectedChars: trimmed.length,
            toggleState: auditToggleState,
            latencyMs: lastRecall?.latencyMs,
            plannerMode: lastRecall?.plannerMode,
            requestedMode: lastRecall?.requestedMode,
            fallbackUsed: lastRecall?.fallbackUsed,
          }).catch((error) => {
            log.debug(`recall audit append failed: ${String(error)}`);
          });
        }

        // Build the structured line array for the capability cache fallback,
        // then derive the flat `prependSystemContext` string from the same
        // source so the hook-based and capability-based memory-injection
        // paths can never drift. `memoryLines` is an internal return field
        // consumed by the wrapping closure and MUST be stripped before the
        // hook result is passed back to the gateway.
        const verboseLines = verboseRequested
          ? buildVerboseRecallHeader({
              sessionKey,
              agentId,
              latencyMs: lastRecall?.latencyMs,
              memoryIds,
              plannerMode: lastRecall?.plannerMode,
              toggleState: auditToggleState,
              summary: summaryText,
            })
          : [];
        const auxiliaryLines = [
          ...verboseLines,
          ...auxiliaryDreamLines,
          ...auxiliaryActiveRecallLines,
        ];
        const memorySectionLines = buildMemoryContextLines(trimmed);
        const memoryLines = useMemoryPromptSection
          ? memorySectionLines
          : [...auxiliaryLines, ...memorySectionLines];
        const promptWithVerbose =
          useMemoryPromptSection
            ? (auxiliaryLines.length > 0
                ? auxiliaryLines.join("\n").replace(/\n$/, "")
                : undefined)
            : auxiliaryLines.length > 0
              ? [...auxiliaryLines, ...memorySectionLines].join("\n").replace(/\n$/, "")
              : renderMemoryContextPrompt(trimmed);

        log.debug(
          `${hookLabel}: returning system prompt with ${trimmed.length} chars`,
        );
        // New SDK (before_prompt_build): only prependSystemContext — gateway
        // applies both fields separately, so returning both would duplicate.
        // Legacy (before_agent_start): return both for backward compat with
        // older gateways that may consume either field.
        if (hookLabel === "before_prompt_build") {
          return promptWithVerbose
            ? { prependSystemContext: promptWithVerbose, memoryLines }
            : { memoryLines };
        }
        return promptWithVerbose
          ? {
              prependSystemContext: promptWithVerbose,
              prependContext: promptWithVerbose,
              memoryLines,
            }
          : { memoryLines };
      } catch (err) {
        log.error("recall failed", err);
        lastRecallSummaryBySession.set(sessionKey, null);
        clearCodexCompatCaches(sessionKey, undefined, {
          preserveMessageCount: true,
          preserveThreadBinding: true,
        });
        if (orchestrator.config.compactionResetEnabled) {
          orchestrator.clearRecallWorkspaceOverride(sessionKey);
        }
        return;
      }
    }

    // Memory recall injection through hook handlers is only legal when the
    // operator policy allows prompt injection. When
    // `hooks.allowPromptInjection=false`, the capability registration below
    // already omits `promptBuilder`, so we also MUST NOT register the recall
    // hook here: otherwise `recallHookHandler` would still return
    // `prependSystemContext`, silently bypassing the policy on capability-only
    // SDKs (and on legacy SDKs too).
    if (!useMemoryPromptSection && promptInjectionAllowed) {
      // When registerMemoryCapability is available but registerMemoryPromptSection
      // is not (capability-only SDK), we need a hybrid approach: continue using
      // the hook for backward compat, but also populate cachedMemoryBySession so
      // the capability's promptBuilder can return recall context for runtimes
      // that treat the capability as the authoritative source.
      //
      // NOTE: needsCacheFallback only applies to the before_prompt_build path.
      // `sdkCaps.hasRegisterMemoryCapability` implies `sdkCaps.hasBeforePromptBuild`
      // (see hasNewHookSystem in sdk-compat.ts), so the legacy before_agent_start
      // branch can never observe a capability-enabled runtime and therefore
      // does not populate the cache.
      const needsCacheFallback =
        sdkCaps.hasRegisterMemoryCapability &&
        typeof (api as any).registerMemoryCapability === "function";

      if (sdkCaps.hasBeforePromptBuild) {
        // New SDK path — literal string for compat checker detection
        api.on(
          "before_prompt_build",
          async (
            event: Record<string, unknown>,
            ctx: Record<string, unknown>,
          ) => {
            const sessionKey = (ctx?.sessionKey as string) ?? "default";
            const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
            // Reset the cache at the start of every turn so a recall miss
            // can never serve stale memory from a prior turn through the
            // capability promptBuilder fallback.
            if (needsCacheFallback) {
              cachePromptMemoryLines(
                sessionKey,
                sessionIdentity.providerThreadId,
                null,
              );
            }
            const result = await recallHookHandler("before_prompt_build", event, ctx);
            // Populate cache for capability promptBuilder fallback using the
            // same structured line format as the registerMemoryPromptSection path.
            if (needsCacheFallback && result?.memoryLines) {
              cachePromptMemoryLines(
                sessionKey,
                sessionIdentity.providerThreadId,
                result.memoryLines,
              );
            }
            // Strip the internal `memoryLines` field before returning to the
            // gateway — it's a closure-private carrier for cache population
            // and is not part of the hook contract.
            if (result && "memoryLines" in result) {
              const { memoryLines: _ml, ...gatewayResult } = result;
              return Object.keys(gatewayResult).length > 0 ? gatewayResult : undefined;
            }
            return result;
          },
        );
      } else {
        // Legacy SDK path — literal string for compat checker detection.
        // Capability-only runtimes cannot reach this branch (they land on
        // before_prompt_build above), so cache fallback logic is omitted here.
        api.on(
          "before_agent_start",
          async (
            event: Record<string, unknown>,
            ctx: Record<string, unknown>,
          ) => {
            const result = await recallHookHandler("before_agent_start", event, ctx);
            // Strip the internal `memoryLines` field before returning to the
            // gateway — it's a closure-private carrier for cache population
            // and is not part of the hook contract.
            if (result && "memoryLines" in result) {
              const { memoryLines: _ml, ...gatewayResult } = result;
              return Object.keys(gatewayResult).length > 0 ? gatewayResult : undefined;
            }
            return result;
          },
        );
      }
    }

    // ========================================================================
    // registerMemoryPromptSection — structured memory injection (new SDK)
    // ========================================================================
    //
    // The gateway calls the builder **synchronously** during system-prompt
    // construction and spreads the result into a string[].  This means:
    //   1. The builder MUST be a plain function (not an object).
    //   2. The builder MUST return string[] | null synchronously (not a Promise).
    //
    // Since orchestrator.recall() is async, we pre-compute the recall in the
    // before_prompt_build hook (which IS async-capable) and cache the result
    // for the synchronous builder to return.
    // ========================================================================
    // Note: `cachedMemoryBySession` is declared earlier in this function so
    // both this section path and the hook fallback path can populate it.

    // Hoisted reference to the prompt builder so registerMemoryCapability
    // can include it alongside publicArtifacts (prevents SDK >=2026.4.5
    // from treating the capability as authoritative without a promptBuilder).
    let memoryPromptBuilder: ((params: { sessionKey?: string }) => string[] | null) | undefined;

    if (useMemoryPromptSection && api.registerMemoryPromptSection) {
      // Async pre-compute: run recall in before_prompt_build and cache result.
      // The hook receives both event and ctx — session identity is in ctx.
      api.on(
        "before_prompt_build",
        async (
          event: Record<string, unknown>,
          ctx: Record<string, unknown>,
        ) => {
          const sessionKey = (ctx?.sessionKey as string) ?? "default";
          const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
          cachePromptMemoryLines(sessionKey, sessionIdentity.providerThreadId, null);
          const result = await recallHookHandler("before_prompt_build", event, ctx);
          if (result?.memoryLines) {
            cachePromptMemoryLines(
              sessionKey,
              sessionIdentity.providerThreadId,
              result.memoryLines,
            );
          }
          if (result && "memoryLines" in result) {
            const { memoryLines: _ml, ...gatewayResult } = result;
            return Object.keys(gatewayResult).length > 0 ? gatewayResult : undefined;
          }
          return result;
        },
      );

      // Synchronous builder: returns the pre-computed lines for the
      // requesting session.  The gateway passes { prompt, sessionKey }
      // but we only need sessionKey to look up our cache.
      // Evict the entry after reading to avoid unbounded growth.
      const memoryBuildFn = (params: {
        sessionKey?: string;
      }): string[] | null => {
        const key = params?.sessionKey ?? "default";
        return consumePromptMemoryLines(key);
      };

      (memoryBuildFn as any).id = "engram-memory";
      (memoryBuildFn as any).label = "Engram Memory Context";
      api.registerMemoryPromptSection(memoryBuildFn as any);

      // Hoist for registerMemoryCapability below
      memoryPromptBuilder = memoryBuildFn;
    }

    // ========================================================================
    // registerMemoryCapability — unified memory plugin registration (new SDK)
    // ========================================================================
    // When registerMemoryCapability is available (>=2026.4.5), register the
    // full capability object including publicArtifacts so memory-wiki bridge
    // mode can discover and ingest Remnic artifacts.
    //
    // This does NOT replace the existing registerMemoryPromptSection / hook
    // paths above — those handle recall injection. registerMemoryCapability
    // adds the publicArtifacts provider and establishes Remnic as the active
    // memory plugin for the gateway.
    if (
      sdkCaps.hasRegisterMemoryCapability &&
      typeof (api as any).registerMemoryCapability === "function"
    ) {
      // Build a promptBuilder for the capability. When registerMemoryPromptSection
      // was also registered, the section builder already does a destructive read
      // (get + delete). To avoid double-consumption if the runtime calls both,
      // the capability builder uses a non-destructive peek (get without delete).
      // In capability-only SDK shapes, the capability builder IS the sole
      // consumer so it performs the destructive read.
      const capabilityPromptBuilder = memoryPromptBuilder
        ? (params: { sessionKey?: string }): string[] | null => {
            // Non-destructive peek — the section builder will handle cleanup
            const key = params?.sessionKey ?? "default";
            return consumePromptMemoryLines(key, { destructive: false });
          }
        : (params: { sessionKey?: string }): string[] | null => {
            // Capability-only: destructive read since we are the sole consumer
            const key = params?.sessionKey ?? "default";
            return consumePromptMemoryLines(key);
          };

      // Derive the agent id owning this memory from the registration-time
      // runtime context. Each plugin register() call is scoped to one agent
      // (see singleton guard comment above), so api.runtime?.agent?.id is
      // authoritative for this registry. Fall back to "generalist" only when
      // the runtime does not expose an agent id (older new-SDK shapes).
      const runtimeAgent = (api as any).runtime?.agent;
      const runtimeAgentId =
        typeof runtimeAgent?.id === "string" && runtimeAgent.id.length > 0
          ? runtimeAgent.id
          : undefined;
      const capabilityAgentIds = runtimeAgentId ? [runtimeAgentId] : ["generalist"];
      const capabilityWorkspaceDir =
        (typeof runtimeAgent?.workspaceDir === "string" && runtimeAgent.workspaceDir.length > 0
          ? runtimeAgent.workspaceDir
          : undefined) ??
        orchestrator.config.workspaceDir ??
        defaultWorkspaceDir();

      const memoryCapability: import("openclaw/plugin-sdk").MemoryPluginCapability = {
        // Include the promptBuilder so runtimes that treat unified capability
        // registration as authoritative (SDK >=2026.4.5) continue to inject
        // recall context via the prompt builder.
        // Respect promptInjectionAllowed policy — omit promptBuilder if injection
        // is disabled, so the capability only provides publicArtifacts.
        ...(promptInjectionAllowed ? { promptBuilder: capabilityPromptBuilder } : {}),
        publicArtifacts: {
          listArtifacts: async (_params: { cfg: unknown }) => {
            try {
              return await listRemnicPublicArtifacts({
                memoryDir: orchestrator.config.memoryDir,
                workspaceDir: capabilityWorkspaceDir,
                agentIds: capabilityAgentIds,
              });
            } catch (err) {
              log.error("publicArtifacts.listArtifacts failed", err);
              return [];
            }
          },
        },
      };
      (api as any).registerMemoryCapability(memoryCapability);
      const builderDesc = !promptInjectionAllowed
        ? " (promptBuilder omitted — injection disabled by policy)"
        : memoryPromptBuilder
          ? " and promptBuilder (from registerMemoryPromptSection)"
          : " and promptBuilder (capability-only fallback)";
      log.info(`registered memory capability with publicArtifacts provider${builderDesc}`);
    }

    // ========================================================================
    // HOOK: agent_end — Buffer turns and trigger extraction
    // ========================================================================
    api.on(
      "agent_end",
      async (
        event: import("openclaw/plugin-sdk").PluginHookAgentEndEvent &
          Record<string, unknown>,
        ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
          Record<string, unknown>,
      ) => {
        if (!event.success || !Array.isArray(event.messages)) return;
        if (event.messages.length === 0) return;

        if (
          cfg.heartbeat.enabled &&
          cfg.heartbeat.gateExtractionDuringHeartbeat &&
          isHeartbeatTrigger(event as Record<string, unknown>, ctx as Record<string, unknown>)
        ) {
          log.debug(
            `agent_end: skipping transcript/extraction buffering during heartbeat run for ${(ctx?.sessionKey as string) ?? "default"}`,
          );
          return;
        }

        const sessionKey = (ctx?.sessionKey as string) ?? "default";
        const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
        await flushAndForgetCodexThreadOnProviderSwitch(sessionKey, sessionIdentity);
        if (
          !sessionIdentity.isCodex &&
          !sessionIdentity.providerThreadId &&
          !sessionIdentity.previousCodexThreadId
        ) {
          forgetCodexThread(sessionKey);
        }
        rememberCodexThread(sessionKey, sessionIdentity.providerThreadId);

        try {
          // Extract the last user-assistant exchange
          const messages = event.messages as Array<Record<string, unknown>>;
          const lastTurn = extractLastTurn(messages);
          const eventTimestamp = new Date().toISOString();

          // Best-effort tool usage stats for extended hourly summaries.
          // Always scan messages here (gated on success=true by the early return above).
          // after_tool_call only logs for debug — stats are recorded here to avoid
          // counting tools from failed/aborted turns.
          if (orchestrator.config.hourlySummariesIncludeToolStats) {
            const toolNames: string[] = [];
            for (const msg of messages) {
              const role = msg.role as string | undefined;
              if (role === "tool") {
                const name =
                  (msg as any).name ??
                  (msg as any).toolName ??
                  (msg as any).tool;
                if (typeof name === "string" && name.length > 0)
                  toolNames.push(name);
              }
              if (role === "assistant") {
                const toolCalls =
                  (msg as any).tool_calls ?? (msg as any).toolCalls;
                if (Array.isArray(toolCalls)) {
                  for (const tc of toolCalls) {
                    const fnName = tc?.function?.name ?? tc?.name;
                    if (typeof fnName === "string" && fnName.length > 0)
                      toolNames.push(fnName);
                  }
                }
              }
            }
            for (const tool of toolNames) {
              await orchestrator.transcript.appendToolUse({
                timestamp: eventTimestamp,
                sessionKey,
                tool,
              });
            }
          }

          try {
            await recordObjectiveStateSnapshotsFromAgentMessages({
              memoryDir: orchestrator.config.memoryDir,
              objectiveStateStoreDir:
                orchestrator.config.objectiveStateStoreDir,
              objectiveStateMemoryEnabled:
                orchestrator.config.objectiveStateMemoryEnabled,
              objectiveStateSnapshotWritesEnabled:
                orchestrator.config.objectiveStateSnapshotWritesEnabled,
              sessionKey,
              recordedAt: eventTimestamp,
              messages,
            });
          } catch (error) {
            log.debug(
              `agent_end objective-state writer skipped due to error: ${error}`,
            );
          }

          let persistedTurnIndex = 0;
          for (const msg of lastTurn) {
            const rawRole = typeof msg.role === "string" ? msg.role : "";
            if (rawRole !== "user" && rawRole !== "assistant") {
              // Ignore tool/system blocks for extraction to avoid noisy memory churn.
              continue;
            }
            const role = rawRole;
            const content = extractTextContent(msg);
            if (content.length < 10) continue;

            // Clean system metadata from user messages
            const cleaned =
              role === "user" ? cleanUserMessage(content) : content;
            const inlineCaptureEnabled = shouldProcessInlineExplicitCapture(
              orchestrator.config,
            );
            const explicitNotes = inlineCaptureEnabled
              ? parseInlineExplicitCaptureNotes(cleaned)
              : [];
            const stripped =
              inlineCaptureEnabled && hasInlineExplicitCaptureMarkup(cleaned)
                ? stripInlineExplicitCaptureNotes(cleaned)
                : cleaned;

            for (const note of explicitNotes) {
              try {
                await persistExplicitCapture(
                  orchestrator,
                  validateExplicitCaptureInput(note),
                  "inline",
                );
                orchestrator.requestQmdMaintenanceForTool("inline.memory_note");
              } catch (error) {
                try {
                  const queued = await queueExplicitCaptureForReview(
                    orchestrator,
                    note,
                    "inline",
                    error,
                  );
                  orchestrator.requestQmdMaintenanceForTool(
                    "inline.memory_note.review",
                  );
                  log.warn(
                    `explicit inline capture queued for review: ${queued.id}${queued.duplicateOf ? ` (duplicate of ${queued.duplicateOf})` : ""}`,
                  );
                } catch (queueError) {
                  log.warn(
                    `explicit inline capture rejected: ${error}; review queue fallback failed: ${queueError}`,
                  );
                }
              }
            }

            // Append to transcript
            if (orchestrator.config.transcriptEnabled && stripped.length > 0) {
              await orchestrator.transcript.append({
                timestamp: eventTimestamp,
                role,
                content: stripped,
                sessionKey,
                turnId: crypto.randomUUID(),
              });
            }

            if (stripped.length > 0) {
              await orchestrator.processTurn(role, stripped, sessionKey, {
                bufferKey: resolveExtractionBufferKey(
                  sessionKey,
                  sessionIdentity.logicalSessionKey,
                ),
                providerThreadId: sessionIdentity.providerThreadId,
                turnFingerprint: buildTurnFingerprint({
                  role,
                  content: stripped,
                  logicalSessionKey: sessionIdentity.logicalSessionKey,
                  providerThreadId: sessionIdentity.providerThreadId,
                  messageCount: sessionIdentity.messageCount,
                  turnIndex: persistedTurnIndex,
                }),
              });
              persistedTurnIndex += 1;
            }
          }

          // LCM: index messages into lossless archive (best-effort)
          if (orchestrator.lcmEngine?.enabled) {
            try {
              const lcmMessages = lastTurn
                .map((msg) => {
                  const rawRole = typeof msg.role === "string" ? msg.role : "";
                  const content = extractTextContent(msg);
                  return { role: rawRole, content };
                })
                .filter((m) => m.content.length > 0);
              if (lcmMessages.length > 0) {
                orchestrator.lcmEngine.enqueueObserveMessages(
                  sessionKey,
                  lcmMessages,
                );
              }
            } catch (lcmErr) {
              log.debug(`LCM agent_end indexing error: ${lcmErr}`);
            }
          }
        } catch (err) {
          log.error("agent_end processing failed", err);
        }
      },
    );

    // Stash pre-compaction token counts so after_compaction can record the pair.
    const lcmTokensBefore = new Map<string, number>();

    // ========================================================================
    // HOOK: before_compaction — Save checkpoint before context is lost
    // ========================================================================
    api.on(
      "before_compaction",
      async (
        event: import("openclaw/plugin-sdk").PluginHookBeforeCompactionEvent &
          Record<string, unknown>,
        ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
          Record<string, unknown>,
      ) => {
        // Fall back to event.sessionKey when ctx is empty (new SDK may provide it on the event).
        const sessionKey =
          (ctx?.sessionKey as string) ??
          (event?.sessionKey as string) ??
          "default";
        const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
        rememberCodexThread(sessionKey, sessionIdentity.providerThreadId);

        try {
          if (
            sessionIdentity.isCodex &&
            cfg.codexCompat.enabled &&
            cfg.codexCompat.compactionFlushMode !== "heuristic"
          ) {
            try {
              await orchestrator.flushSession(sessionKey, {
                reason: "codex_compaction_signal",
                bufferKey: resolveExtractionBufferKey(
                  sessionKey,
                  sessionIdentity.logicalSessionKey,
                ),
              });
              clearCodexCompatCaches(
                sessionKey,
                sessionIdentity.providerThreadId,
              );
              rememberCodexThread(sessionKey, sessionIdentity.providerThreadId);
            } catch (error) {
              log.warn(`codexCompat signal flush failed: ${String(error)}`);
            }
          }
          // LCM: flush pending summaries before context is lost
          // (runs regardless of checkpoint setting — LCM needs pre-compaction flush)
          // Token count is stashed here; after_compaction records the final pair.
          if (orchestrator.lcmEngine?.enabled) {
            try {
              let tokensBefore = 0;
              if (typeof event.tokenCount === "number") {
                tokensBefore = event.tokenCount;
              } else if (Array.isArray(event.messages)) {
                // Auto-compaction path: estimate from messages array
                for (const msg of event.messages as Array<{
                  content?: unknown;
                }>) {
                  if (typeof msg.content === "string") {
                    tokensBefore += estimateLcmTokens(msg.content);
                  } else if (Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                      if (typeof block === "string")
                        tokensBefore += estimateLcmTokens(block);
                      else if (
                        block &&
                        typeof block === "object" &&
                        typeof (block as any).text === "string"
                      )
                        tokensBefore += estimateLcmTokens((block as any).text);
                    }
                  }
                }
              }
              lcmTokensBefore.set(sessionKey, tokensBefore);
              await orchestrator.lcmEngine.waitForSessionObserveIdle(
                sessionKey,
              );
              await orchestrator.lcmEngine.preCompactionFlush(sessionKey);
            } catch (lcmErr) {
              log.debug(`LCM before_compaction error: ${lcmErr}`);
            }
          }

          if (!orchestrator.config.checkpointEnabled) {
            return;
          }

          // Get recent turns from transcript
          const entries = await orchestrator.transcript.readRecent(
            1,
            sessionKey,
          );
          const checkpointTurns = entries.slice(
            -orchestrator.config.checkpointTurns,
          );

          if (checkpointTurns.length > 0) {
            await orchestrator.transcript.saveCheckpoint({
              sessionKey,
              capturedAt: new Date().toISOString(),
              turns: checkpointTurns,
              ttl: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            });
            log.info(`saved checkpoint for ${sessionKey} before compaction`);
          }
        } catch (err) {
          log.error("before_compaction hook failed", err);
        }
      },
    );

    // ========================================================================
    // HOOK: after_compaction — Trigger session reset (compaction reset flow)
    // ========================================================================
    api.on(
      "after_compaction",
      async (
        event: import("openclaw/plugin-sdk").PluginHookAfterCompactionEvent &
          Record<string, unknown>,
        ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
          Record<string, unknown>,
      ) => {
        // Fall back to event.sessionKey when ctx is empty (new SDK may provide it on the event).
        const sessionKey =
          (ctx?.sessionKey as string) ??
          (event?.sessionKey as string) ??
          "default";
        const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);

        try {
          clearCodexCompatCaches(sessionKey, sessionIdentity.providerThreadId, {
            preserveMessageCount: true,
            preserveThreadBinding: true,
          });
          // LCM: record compaction with real token counts and verify coverage
          // (runs regardless of reset setting — LCM needs compaction metrics)
          if (orchestrator.lcmEngine?.enabled) {
            try {
              let tokensAfter = 0;
              if (typeof event.tokenCount === "number") {
                tokensAfter = event.tokenCount;
              } else {
                // Auto-compaction path: no token count available.
                // Estimate from messageCount ratio if we have tokensBefore.
                const storedBefore = lcmTokensBefore.get(sessionKey) ?? 0;
                const msgCountAfter =
                  typeof event.messageCount === "number"
                    ? event.messageCount
                    : 0;
                const compacted =
                  typeof event.compactedCount === "number"
                    ? event.compactedCount
                    : 0;
                const msgCountBefore = msgCountAfter + compacted;
                if (storedBefore > 0 && msgCountBefore > 0) {
                  // Rough estimate: tokens scale proportionally to message count
                  tokensAfter = Math.round(
                    storedBefore * (msgCountAfter / msgCountBefore),
                  );
                }
              }
              const tokensBefore = lcmTokensBefore.get(sessionKey) ?? 0;
              lcmTokensBefore.delete(sessionKey);
              await orchestrator.lcmEngine.recordCompaction(
                sessionKey,
                tokensBefore,
                tokensAfter,
              );
              await orchestrator.lcmEngine.verifyPostCompaction(sessionKey);
            } catch (lcmErr) {
              log.debug(`LCM after_compaction error: ${lcmErr}`);
            }
          }

          if (!orchestrator.config.compactionResetEnabled) {
            log.debug(
              `compaction completed for ${sessionKey}, reset disabled — skipping`,
            );
            return;
          }

          log.info(
            `compaction completed for ${sessionKey}, triggering session reset`,
          );

          // Use ctx.workspaceDir (per-agent) if available, fall back to event
          // (new SDK may provide it on the event when ctx is empty), then config.
          const workspaceDir =
            (ctx?.workspaceDir as string) ||
            (event?.workspaceDir as string) ||
            orchestrator.config.workspaceDir ||
            defaultWorkspaceDir();

          // Reset the session first — only write the signal file if reset succeeds.
          // This prevents the next recall() from injecting recovery content when
          // no actual reset occurred (e.g., gateway doesn't support resetSession).
          const apiAny = api as any;
          if (typeof apiAny.resetSession === "function") {
            const result = await apiAny.resetSession(sessionKey, "new");
            if (result?.ok === true) {
              log.info(
                `session reset via API for ${sessionKey}, new sessionId=${result.sessionId}`,
              );

              // Write signal file AFTER successful reset so recall() knows
              // a compaction reset just happened and can inject BOOT.md.
              // Signal file is per-session to prevent multi-session overwrites.
              const safeSessionKey = sanitizeSessionKeyForFilename(sessionKey);
              const signalPath = path.join(
                workspaceDir,
                `.compaction-reset-signal-${safeSessionKey}`,
              );
              await writeFile(
                signalPath,
                JSON.stringify({
                  sessionKey,
                  compactedAt: new Date().toISOString(),
                  messageCount: event.messageCount ?? 0,
                }),
                "utf-8",
              );
            } else {
              const errorDetail =
                result && typeof result === "object" && "error" in result
                  ? String(
                      (result as { error?: unknown }).error ?? "unknown error",
                    )
                  : `invalid result: ${JSON.stringify(result)}`;
              log.error(
                `api.resetSession failed for ${sessionKey}: ${errorDetail}`,
              );
            }
          } else {
            log.error(
              `api.resetSession not available — compaction reset requires OC fork with PR #29985. ` +
                `Session ${sessionKey} will continue without reset.`,
            );
          }
        } catch (err) {
          log.error("after_compaction reset failed", err);
        }
      },
    );

    try {
      api.on(
        "before_reset",
        async (
          event: import("openclaw/plugin-sdk").PluginHookBeforeResetEvent &
            Record<string, unknown>,
          ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          const sessionKey =
            (ctx?.sessionKey as string) ??
            (event?.sessionKey as string) ??
            "default";
          const sessionIdentity = resolveSessionIdentity(sessionKey, event, ctx);
          await flushAndForgetCodexThreadOnProviderSwitch(sessionKey, sessionIdentity);
          const rememberedThreadId =
            sessionIdentity.providerThreadId ?? resolveStoredCodexThreadId(sessionKey);
          const flushEnabled =
            cfg.flushOnResetEnabled &&
            typeof (orchestrator as any).flushSession === "function";
          const flushAbort = new AbortController();
          let flushTimedOut = false;
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const flushPromise = flushEnabled
            ? Promise.resolve(
                (orchestrator as any).flushSession(sessionKey, {
                  reason: "before_reset",
                  bufferKey: resolveExtractionBufferKey(
                    sessionKey,
                    rememberedThreadId &&
                      cfg.codexCompat.threadIdBufferKeying !== false
                      ? codexLogicalSessionKey(rememberedThreadId)
                      : sessionIdentity.logicalSessionKey,
                  ),
                  abortSignal: flushAbort.signal,
                }),
              ).catch((error) => {
                if (!flushAbort.signal.aborted) {
                  log.warn(`before_reset flush failed: ${String(error)}`);
                }
              })
            : Promise.resolve();
          const boundedFlush = flushEnabled
            ? Promise.race([
              flushPromise,
              new Promise<void>((resolve) => {
                  timeoutId = setTimeout(() => {
                    flushTimedOut = true;
                    flushAbort.abort();
                    resolve();
                  }, cfg.beforeResetTimeoutMs);
                }),
              ])
            : flushPromise;
          await boundedFlush;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          if (flushTimedOut) {
            log.warn(
              `before_reset flush timed out after ${cfg.beforeResetTimeoutMs}ms`,
            );
          }
          clearCodexCompatCaches(sessionKey, sessionIdentity.providerThreadId);
          if (
            typeof (orchestrator as any).clearRecallWorkspaceOverride === "function"
          ) {
            (orchestrator as any).clearRecallWorkspaceOverride(sessionKey);
          }
        },
      );
    } catch (error) {
      log.debug(`before_reset hook unavailable on this runtime: ${String(error)}`);
    }
    }

    // ========================================================================
    // NEW SDK HOOKS (≥2026.3.22 only)
    // These hooks are only available on the new SDK and provide richer
    // lifecycle, tool, LLM, and subagent observation capabilities.
    // ========================================================================
    if (
      !passiveMode &&
      cfg.commandsListEnabled &&
      cfg.sessionTogglesEnabled !== false
    ) {
      try {
        api.on("commands.list", async () => sessionCommandDescriptors);
      } catch (error) {
        log.debug(
          `commands.list unavailable on this runtime: ${String(error)}`,
        );
      }
    }

    if (!passiveMode && sdkCaps.hasBeforePromptBuild) {
      // ---- Session lifecycle ----
      api.on(
        "session_start",
        async (
          event: import("openclaw/plugin-sdk").PluginHookSessionEvent &
            Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          const sessionKey = event.sessionKey ?? "default";
          log.debug(`session_start: ${sessionKey}`);
          try {
            await orchestrator.maybeRunFileHygiene().catch(() => undefined);
          } catch (err) {
            log.debug(`session_start file hygiene failed: ${err}`);
          }
        },
      );

      api.on(
        "session_end",
        async (
          event: import("openclaw/plugin-sdk").PluginHookSessionEvent &
            Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          const sessionKey = event.sessionKey ?? "default";
          log.debug(`session_end: ${sessionKey}`);
          // Future: flush pending extractions here when Orchestrator gains a flush method.
          if (orchestrator.config.compactionResetEnabled) {
            orchestrator.clearRecallWorkspaceOverride(sessionKey);
          }
        },
      );

      // ---- Tool observation ----
      api.on(
        "before_tool_call",
        async (
          event: import("openclaw/plugin-sdk").PluginHookBeforeToolCallEvent &
            Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          if (event.toolName) {
            log.debug(`before_tool_call: ${event.toolName}`);
          }
        },
      );

      api.on(
        "after_tool_call",
        async (
          event: import("openclaw/plugin-sdk").PluginHookAfterToolCallEvent &
            Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          // Log tool usage for debugging. Tool stats for hourly summaries are
          // recorded in agent_end (gated on success=true) to avoid counting
          // tools from failed/aborted turns.
          if (event.toolName) {
            log.debug(
              `after_tool_call: ${event.toolName} (${event.durationMs ?? "?"}ms)`,
            );
          }
        },
      );

      // ---- LLM observation ----
      api.on(
        "llm_output",
        async (
          event: import("openclaw/plugin-sdk").PluginHookLlmOutputEvent &
            Record<string, unknown>,
          ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          const sessionKey = (ctx?.sessionKey as string) ?? "default";
          if (event.tokenUsage) {
            log.debug(
              `llm_output: model=${event.model ?? "?"}, tokens=${event.tokenUsage.input ?? 0}/${event.tokenUsage.output ?? 0}, ${event.durationMs ?? "?"}ms, session=${sessionKey}`,
            );
          }
        },
      );

      // ---- Subagent lifecycle ----
      api.on(
        "subagent_spawning",
        async (
          event: import("openclaw/plugin-sdk").PluginHookSubagentSpawningEvent &
            Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          log.debug(
            `subagent_spawning: ${event.subagentId ?? "?"} purpose=${event.purpose ?? "?"}`,
          );
        },
      );

      api.on(
        "subagent_ended",
        async (
          event: import("openclaw/plugin-sdk").PluginHookSubagentEndedEvent &
            Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext &
            Record<string, unknown>,
        ) => {
          log.debug(
            `subagent_ended: ${event.subagentId ?? "?"} success=${event.success ?? "?"} ${event.durationMs ?? "?"}ms`,
          );
        },
      );
    } else if (!passiveMode) {
      // Legacy runtime: restore heartbeat observer for sessionObserverEnabled.
      // On new SDK, session_start/session_end hooks replace this.
      // Two paths: registerHook for runtimes that emit event-style heartbeats,
      // and api.on("agent_heartbeat") for pre-2026.1.29 runtimes that emit typed hooks.
      const runtimeApi = api as any;
      runtimeApi.registerHook?.(
        ["agent_heartbeat", "agent:heartbeat"],
        (event: any) => {
          if (orchestrator.config.sessionObserverEnabled !== true) return;
          const sessionKey =
            (event?.context?.sessionKey as string) ?? "default";
          void orchestrator
            .observeSessionHeartbeat(sessionKey)
            .catch((err: unknown) => {
              log.debug(`agent_heartbeat observer failed: ${err}`);
            });
        },
        {
          name: "engram_agent_heartbeat_legacy",
          description:
            "Observe legacy heartbeat events for session observation.",
        },
      );

      // Typed api.on path for pre-2026.1.29 builds that route heartbeat through the hook system.
      const runtimeVersion =
        runtimeApi.runtime?.version ||
        readEnvVar("OPENCLAW_SERVICE_VERSION") ||
        "unknown";
      void import("./legacy-hook-compat.js")
        .then(({ shouldRegisterTypedAgentHeartbeat }) => {
          if (shouldRegisterTypedAgentHeartbeat(runtimeVersion)) {
            (api.on as any)(
              "agent_heartbeat",
              (
                _event: Record<string, unknown>,
                ctx: Record<string, unknown>,
              ) => {
                if (orchestrator.config.sessionObserverEnabled !== true) return;
                const sessionKey = (ctx?.sessionKey as string) ?? "default";
                void orchestrator
                  .observeSessionHeartbeat(sessionKey)
                  .catch((err: unknown) => {
                    log.debug(`agent_heartbeat typed observer failed: ${err}`);
                  });
              },
            );
            log.info(
              `registered typed agent_heartbeat hook for OpenClaw ${runtimeVersion}`,
            );
          }
        })
        .catch(() => {
          // legacy-hook-compat import failed — skip typed registration
        });
    }

    // ========================================================================
    // Helper: Auto-register hourly summary cron job
    // ========================================================================
    async function ensureHourlySummaryCron(
      api: OpenClawPluginApi,
    ): Promise<void> {
      const jobId = "engram-hourly-summary";
      const cronFilePath = path.join(
        os.homedir(),
        ".openclaw",
        "cron",
        "jobs.json",
      );

      try {
        // Read existing jobs
        let jobsData: { version: number; jobs: Array<{ id: string }> } = {
          version: 1,
          jobs: [],
        };
        try {
          const content = await readFile(cronFilePath, "utf-8");
          jobsData = JSON.parse(content);
        } catch {
          // File doesn't exist or is invalid - will create new
        }

        // Check if job already exists
        const exists = jobsData.jobs.some((j) => j.id === jobId);
        if (exists) {
          log.debug("hourly summary cron job already exists");
          return;
        }

        // Get model to use - prefer summary model, then default, then first available
        const model = cfg.summaryModel || cfg.model || "gpt-5.2";

        // Pick a random minute (1-59) to avoid colliding with other top-of-hour crons
        const randomMinute = Math.floor(Math.random() * 59) + 1;

        // Create the hourly summary job.
        //
        // NOTE:
        // - `sessionTarget: "main"` only supports `payload.kind: "systemEvent"` in this install.
        // - For agent-driven automation, use `sessionTarget: "isolated"` + `payload.kind: "agentTurn"`.
        // - We intentionally avoid sending messages anywhere; success is silent.
        const newJob = {
          id: jobId,
          agentId: "generalist",
          model,
          name: "Engram Hourly Summary",
          enabled: true,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          schedule: {
            kind: "cron" as const,
            expr: `${randomMinute} * * * *`, // Every hour at random minute
            tz: "America/Chicago",
          },
          sessionTarget: "isolated",
          wakeMode: "now" as const,
          payload: {
            kind: "agentTurn" as const,
            timeoutSeconds: 120,
            thinking: "off" as const,
            message:
              "You are OpenClaw automation.\n\n" +
              "Task: Generate Engram hourly summaries.\n\n" +
              "Call the tool `memory_summarize_hourly` with empty params.\n\n" +
              "Output policy:\n" +
              "- If you generated summaries successfully: output exactly NO_REPLY.\n" +
              "- If there is an error: output one concise line describing it.\n\n" +
              "Rules:\n" +
              "- Do NOT send anything to Discord.\n" +
              "- Never print secrets.\n",
          },
          delivery: { mode: "none" as const },
          state: {},
        };

        jobsData.jobs.push(newJob);

        // Write back
        await writeFile(
          cronFilePath,
          JSON.stringify(jobsData, null, 2),
          "utf-8",
        );
        log.info("auto-registered hourly summary cron job");
      } catch (err) {
        log.error("failed to auto-register hourly summary cron job:", err);
      }
    }

    // ========================================================================
    // Register tools (every registration) and CLI (first registration only)
    // ========================================================================
    // Tools are scoped to the current api/registry instance. When the gateway
    // creates multiple plugin registries (e.g. different cache keys for cron
    // vs. reply contexts), each registry gets its own api object and must have
    // tools registered against it. Skipping registration on secondary calls
    // leaves those registries with hooks but zero tools, making
    // memory_summarize_hourly (and all other Engram tools) invisible to the LLM.
    //
    // CLI commands, by contrast, live in the central plugin registry (not in
    // per-registry api state), so registering them more than once would create
    // duplicate engram command trees. CLI registration stays behind the guard.
    if (cfg.openclawToolsEnabled !== false && typeof api.registerTool === "function") {
      api.registerTool(
        buildMemorySearchTool(orchestrator, {
          snippetMaxChars: cfg.openclawToolSnippetMaxChars,
        }) as Record<string, unknown>,
      );
      api.registerTool(buildMemoryGetTool(orchestrator) as Record<string, unknown>);
    }

    if (
      cfg.sessionTogglesEnabled !== false &&
      typeof (api as { registerCommand?: (spec: unknown) => void }).registerCommand === "function" &&
      !(globalThis as any)[SESSION_COMMANDS_REGISTERED_GUARD]
    ) {
      (globalThis as any)[SESSION_COMMANDS_REGISTERED_GUARD] = true;
      for (const descriptor of sessionCommandDescriptors) {
        (api as { registerCommand: (spec: unknown) => void }).registerCommand(descriptor);
      }
    }

    registerTools(
      api as unknown as Parameters<typeof registerTools>[0],
      orchestrator,
    );
    // Register LCM tools when enabled
    if (orchestrator.lcmEngine?.enabled) {
      registerLcmTools(
        api as unknown as Parameters<typeof registerLcmTools>[0],
        orchestrator.lcmEngine,
      );
    }

    // CLI guard is intentionally process-global (not per-serviceId) because CLI
    // commands live in the gateway's central registry.  See CLI_REGISTERED_GUARD.
    if (!(globalThis as any)[CLI_REGISTERED_GUARD]) {
      (globalThis as any)[CLI_REGISTERED_GUARD] = true;
      registerCli(
        api as unknown as Parameters<typeof registerCli>[0],
        orchestrator,
      );
    }

    // ========================================================================
    // Register service (every registration)
    // ========================================================================
    // registerService must be called on every api instance, not just the first.
    // Each gateway registry has its own api object; startPluginServices() iterates
    // the registry it owns — if that registry has no service registered, start()
    // never fires and the orchestrator never initializes (issue #285).
    //
    // Duplicate start() calls are safe: the per-serviceId SERVICE_STARTED guard
    // inside start() makes initialize() idempotent within a process lifetime.
    // stop() clears the flag so restart cycles reinitialize correctly.
    let activeOpikExporter: import("./opik-exporter.js").OpikExporter | null =
      null;
    // Whether this specific registry's start() claimed a slot in ACTIVE_REGISTRIES.
    // Ensures stop() only decrements the count for registries whose start() ran
    // (not secondary registries whose start() was a no-op, nor registries whose
    // start() threw before successfully initializing).
    let didCountStart = false;
    api.registerService({
      id: serviceId,
      start: async () => {
        // Check the in-flight promise BEFORE the started flag. SERVICE_STARTED
        // is set to true inside the IIFE (only on success), so checking the flag
        // first would let concurrent callers return before init completes. By
        // checking INIT_PROMISE first, concurrent start() calls await the in-flight
        // init rather than resolving immediately while the orchestrator and HTTP
        // server are still initializing.
        //
        // Outer loop handles two cases:
        //   1. A failed takeover init: if an awaited INIT_PROMISE rejects (the
        //      takeover primary's initialize() threw), the inner while catches the
        //      rejection so the waiting secondary can retry — either await the next
        //      INIT_PROMISE or claim ownership.
        //   2. Defensive ownership re-check: after the inner while exits
        //      (INIT_PROMISE=null) there is no await before the break, so in
        //      single-threaded JS INIT_PROMISE cannot be set by another secondary
        //      in that window. The explicit re-check makes the invariant clear.
        for (;;) {
          // Inner while: wait out any in-flight init.
          // Loop rather than a single if: when multiple secondaries are awaiting the
          // same INIT_PROMISE (e.g. after primary abort), the first waiter to resume
          // synchronously sets a new INIT_PROMISE for its own takeover. Without the
          // loop, subsequent waiters fall through the if-block and enter the init path
          // concurrently — re-running orchestrator.initialize() multiple times. The
          // while-loop re-checks INIT_PROMISE after every await so each waiter sees
          // the new promise and awaits it instead of racing to become a second primary.
          while ((globalThis as any)[keys.INIT_PROMISE]) {
            try {
              await (globalThis as any)[keys.INIT_PROMISE];
            } catch {
              // A primary's init failed and its outer try-finally already cleared
              // INIT_PROMISE to null. Re-evaluate the while condition: if another
              // secondary claimed INIT_PROMISE in the meantime, await it; otherwise
              // exit and decide whether to become the next primary.
            }
            // Re-check after awaiting: the primary's start() may have been aborted by
            // a concurrent stop() (via the !didCountStart early return), leaving
            // SERVICE_STARTED=false even though the promise resolved. In that
            // case continue the loop — we will either see a new INIT_PROMISE (set by
            // the first-resuming takeover waiter) or exit the loop to become primary.
            if ((globalThis as any)[keys.SERVICE_STARTED]) return;
          }
          // No in-flight init — check if already fully initialized.
          if ((globalThis as any)[keys.SERVICE_STARTED]) {
            log.debug(
              `${serviceId}: service.start() called again — skipping duplicate init`,
            );
            return;
          }
          // Defensive re-check before claiming ownership. In practice (single-threaded
          // JS, no await between the inner while exit and here) INIT_PROMISE cannot
          // become non-null at this point, but the check makes the ownership invariant
          // self-documenting: we only proceed when no other primary is in-flight.
          if ((globalThis as any)[keys.INIT_PROMISE]) continue;
          break;
        }
        // We are the first — claim ownership and drive initialization.
        didCountStart = true;
        (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] =
          ((globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] || 0) + 1;
        // IMPORTANT: Do NOT put a `finally` inside the IIFE to clear INIT_PROMISE.
        // If anything in the try block throws synchronously (before the first `await`),
        // the IIFE's finally would run before the outer assignment, and the outer line
        // `INIT_PROMISE = initPromise` would then overwrite null with a stale
        // rejected promise — permanently blocking future start() calls. Instead, clear
        // INIT_PROMISE in the outer try-finally below after `await initPromise`.
        const initPromise = (async () => {
          try {
            log.info("initializing engram memory system...");
            await orchestrator.initialize();

            // If stop() was called while orchestrator.initialize() was in progress,
            // it already cleared didCountStart. Abort further setup to avoid
            // proceeding after the service was intentionally stopped.
            if (!didCountStart) return;

            // Initialize Opik exporter if configured
            activeOpikExporter = createOpikExporter({}, log);
            if (activeOpikExporter) activeOpikExporter.subscribe();

            // Cleanup old transcripts
            if (orchestrator.config.transcriptEnabled) {
              await orchestrator.transcript.cleanup(
                orchestrator.config.transcriptRetentionDays,
              );
              // Abort if stop() was called during transcript cleanup.
              if (!didCountStart) return;
            }

            // Cron integration guard:
            // - Hourly summaries are supported, but auto-registering cron is a footgun across installs.
            // - Only auto-register when explicitly enabled by config.
            if (
              orchestrator.config.hourlySummariesEnabled &&
              orchestrator.config.hourlySummaryCronAutoRegister
            ) {
              await ensureHourlySummaryCron(api);
              // Abort if stop() was called during cron registration.
              if (!didCountStart) return;
            } else if (orchestrator.config.hourlySummariesEnabled) {
              log.info(
                "hourly summaries enabled; cron auto-register is disabled. " +
                  "To schedule summaries, create an isolated/agentTurn cron job that calls `memory_summarize_hourly`.",
              );
            }

            if (cfg.dreaming.enabled) {
              await queueDreamSurfaceSync();
              if (cfg.dreaming.watchFile) {
                stopDreamWatcher?.();
                stopDreamWatcher = dreamsSurface.watch(
                  resolveDreamJournalPath(),
                  () => {
                    void queueDreamSurfaceSync().catch((error) => {
                      log.debug(`dream surface watch sync failed: ${String(error)}`);
                    });
                  },
                );
              }
              removeDreamingObserver?.();
              removeDreamingObserver = orchestrator.registerConsolidationObserver(
                async (observation) => {
                  await maybeAppendDreamFromConsolidation(observation);
                },
              );
            }

            if (cfg.heartbeat.enabled) {
              await queueHeartbeatSurfaceSync();
              if (cfg.heartbeat.watchFile) {
                stopHeartbeatWatcher?.();
                stopHeartbeatWatcher = heartbeatSurface.watch(
                  resolveHeartbeatJournalPath(),
                  () => {
                    void queueHeartbeatSurfaceSync().catch((error) => {
                      log.debug(`heartbeat surface watch sync failed: ${String(error)}`);
                    });
                  },
                );
              }
            }

            if (cfg.agentAccessHttp.enabled) {
              // Abort if stop() was called before starting the HTTP server.
              if (!didCountStart) return;
              try {
                const status = await accessHttpServer.start();
                log.info(
                  `engram access HTTP ready at http://${status.host}:${status.port}`,
                );
              } catch (err) {
                log.error("failed to start engram access HTTP server", err);
              }
            }

            // Final abort check before marking service as ready.
            if (!didCountStart) return;
            // Mark service as started only after all initialization steps succeed and
            // cancellation has not been requested. Setting the flag here (not before
            // the await) prevents SERVICE_STARTED=true from being observable while init
            // is still in-flight, and ensures the flag accurately reflects completion.
            (globalThis as any)[keys.SERVICE_STARTED] = true;
            // Note: REGISTERED_GUARD is intentionally NOT set here.
            //
            // In the stop-during-init takeover case (the one that prompted PR description
            // language about "restoring GUARD=true"): stop() no longer clears GUARD for
            // stop-during-init paths, so GUARD is already true when a secondary completes
            // init — no restore is needed (thread PRRT_kwDORJXyws5159OQ).
            //
            // In the full-stop-then-secondary-start case: stop() cleared GUARD to signal
            // that the next register() may re-register CLI. A secondary completing init
            // after a full stop must leave GUARD=false so that signal is preserved.
            log.info("engram memory system ready");
            // Operator-visible confirmation that gateway_start fired successfully.
            // Used by `remnic doctor` and install docs to verify hooks are active.
            log.info(
              `gateway_start fired — Remnic memory plugin is active (id=${pluginDefinition.id}, memoryDir=${cfg.memoryDir})`,
            );
          } catch (err) {
            // Unsubscribe Opik exporter if it was subscribed before the failure so
            // a retry from another registry doesn't accumulate multiple subscribers.
            try {
              activeOpikExporter?.unsubscribe();
            } catch {}
            activeOpikExporter = null;
            // Roll back ownership so the next registry's start() can retry.
            // SERVICE_STARTED was not set yet (only set on success above), but
            // clear it defensively in case another code path set it.
            //
            // Only decrement CLI_ACTIVE_SERVICE_COUNT if didCountStart is still
            // true.  If stop() already ran during this init, it set
            // didCountStart=false and already decremented the count.  Without
            // this guard, both paths decrement → underflow → premature CLI
            // guard clearing while another service is still running.
            if (didCountStart) {
              (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] = Math.max(
                0,
                ((globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] || 0) - 1,
              );
            }
            didCountStart = false;
            (globalThis as any)[keys.SERVICE_STARTED] = false;
            // Do NOT clear REGISTERED_GUARD here. On an ordinary startup
            // failure (no preceding stop/reload) the CLI registered during register()
            // is still present in the gateway's command registry. Clearing the guard
            // would let a subsequent register() call re-register CLI commands,
            // duplicating the central engram command tree.
            //
            // For the stop-during-init case: stop() leaves GUARD as-is because
            // the CLI registered by the original register() call is still present
            // in the gateway's registry. No deferred clearing is performed.
            throw err;
          }
          // No finally here — see comment above. INIT_PROMISE is cleared
          // by the outer try-finally after `await initPromise` below.
        })();
        // SERVICE_STARTED is set inside the IIFE (on success only), so any
        // concurrent caller that arrives after INIT_PROMISE is set will await the
        // in-flight init. The SERVICE_STARTED early-return path above is only
        // reachable when INIT_PROMISE is null (init not in-flight), which means
        // SERVICE_STARTED truly reflects a completed, successful init.
        (globalThis as any)[keys.INIT_PROMISE] = initPromise;
        try {
          await initPromise;
        } finally {
          // Clear the in-flight promise after init settles (success or failure).
          // Placing this here (not inside the IIFE) avoids the ordering hazard where
          // a pre-await throw inside the IIFE would let the outer assignment overwrite
          // null with the rejected promise.
          (globalThis as any)[keys.INIT_PROMISE] = null;
        }
      },
      stop: async () => {
        // Only the registry whose start() successfully ran initialize() does teardown.
        // Secondary registries (start() returned early on SERVICE_STARTED) and
        // failed registries (start() rolled back in catch) have didCountStart=false
        // and skip all cleanup — including Opik — to avoid detaching a live exporter.
        if (!didCountStart) return;
        didCountStart = false;
        // Decrement the process-global active-service count.  When it reaches
        // zero, all Remnic services have stopped and it's safe to clear the CLI
        // guard so a subsequent reload cycle can re-register CLI commands.
        const remainingServices = Math.max(
          0,
          ((globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] || 0) - 1,
        );
        (globalThis as any)[CLI_ACTIVE_SERVICE_COUNT] = remainingServices;
        // Opik cleanup: placed after the guard so secondary stop()s never detach
        // the process-wide exporter while Engram is still running.
        // Wrapped in try-catch (like accessHttpServer.stop()) so a throwing
        // unsubscribe does not leave SERVICE_STARTED=true and prevent restart.
        try {
          activeOpikExporter?.unsubscribe();
        } catch (err) {
          log.debug(`engram opik exporter unsubscribe failed: ${err}`);
        }
        activeOpikExporter = null;
        try {
          await accessHttpServer.stop();
        } catch (err) {
          log.debug(`engram access HTTP stop failed: ${err}`);
        }
        stopDreamWatcher?.();
        stopDreamWatcher = null;
        stopHeartbeatWatcher?.();
        stopHeartbeatWatcher = null;
        removeDreamingObserver?.();
        removeDreamingObserver = null;
        delete (globalThis as any)[keys.ACCESS_HTTP_SERVER];
        delete (globalThis as any)[keys.ACCESS_SERVICE];
        // REGISTERED_GUARD policy:
        //
        // Full stop (INIT_PROMISE is null when stop() is called):
        //   Clear GUARD so a subsequent register() in a fresh session can
        //   re-register CLI commands after a stop/reload cycle.
        //
        // Stop-during-init (INIT_PROMISE is non-null):
        //   Leave GUARD as-is. The CLI registered by the original register()
        //   call is still present in the gateway's registry — stop() does not
        //   unregister CLI commands. Clearing GUARD here would allow a
        //   subsequent register() to register CLI again on top of the
        //   still-live registration, duplicating the CLI command tree.
        const currentInitPromise = (globalThis as any)[
          keys.INIT_PROMISE
        ] as Promise<void> | null;
        // Track whether a secondary completed init during stop()'s await window.
        // Used below to guard the SERVICE_STARTED=false assignment.
        let secondaryTookOver = false;
        if (!currentInitPromise) {
          (globalThis as any)[keys.REGISTERED_GUARD] = false;
          // Clear CLI guard only when ALL Remnic services have stopped.
          // In multi-plugin installs, one plugin stopping must not clear the
          // guard while the other is still running — that would let a
          // subsequent register() duplicate CLI commands.  When the refcount
          // reaches zero, the gateway's reload cycle can safely re-register.
          if (remainingServices === 0) {
            (globalThis as any)[CLI_REGISTERED_GUARD] = false;
            (globalThis as any)[SESSION_COMMANDS_REGISTERED_GUARD] = false;
          }
        } else {
          // Stop-during-init: leave GUARD as-is.
          // The CLI registered by the original register() call is still present
          // in the gateway's registry; clearing GUARD here would allow a
          // subsequent register() to register CLI again, duplicating commands
          // on top of the still-live registration (thread PRRT_kwDORJXyws5159Kz).
          //
          // Await the in-flight init (didCountStart=false signals it to abort at
          // its next checkpoint). Ignore errors — we only care about settlement.
          try {
            await currentInitPromise;
          } catch {}
          // One queueMicrotask tick: any secondary whose .then() on
          // currentInitPromise runs after stop()'s `await` continuation will
          // execute here and synchronously set its own INIT_PROMISE.
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          if (
            (globalThis as any)[keys.INIT_PROMISE] ||
            (globalThis as any)[keys.SERVICE_STARTED]
          ) {
            secondaryTookOver = true;
          }
        }
        // Clear per-api hook tracking so hooks can be re-bound to fresh api objects.
        // Skip when a secondary is live — its api objects already have hooks bound
        // and resetting the WeakSet here would cause duplicate hook registration
        // the next time those api objects trigger hook paths (thread PRRT_kwDORJXyws5159K0).
        if (!secondaryTookOver) {
          (globalThis as any)[keys.HOOK_APIS] = new WeakSet();
        }
        // Allow service.start() to reinitialize after a stop/restart cycle.
        // Skip this when a secondary completed init while stop() was suspended:
        // that registry's start() is the owner of SERVICE_STARTED=true, and its
        // own stop() call will clear the flag. Clobbering it here would let the
        // next start() bypass the idempotency guard and re-run initialize() on
        // the live singleton (Cursor review thread PRRT_kwDORJXyws5156Lw).
        if (!secondaryTookOver) {
          (globalThis as any)[keys.SERVICE_STARTED] = false;
        }
        // Do NOT clear INIT_PROMISE here. If stop() is called while init is
        // still in-flight (start() suspended at an await), clearing the promise here
        // would let a new registry enter start() before the original initializer settles
        // and call orchestrator.initialize() a second time on the same singleton.
        // The outer try-finally in start() already clears INIT_PROMISE when
        // initPromise settles, so no cleanup is needed here — in the normal (after init)
        // case it is already null, and in the in-flight case it must stay set.
        log.info("stopped");
      },
    });
  },
};

export default tryDefinePluginEntry(pluginDefinition);

// ============================================================================
// Helpers
// ============================================================================

function extractLastTurn(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages.slice(-2);
}

function extractTextContent(msg: Record<string, unknown>): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          block.type === "text" &&
          typeof block.text === "string",
      )
      .map((block) => block.text as string)
      .join("\n");
  }
  return "";
}
