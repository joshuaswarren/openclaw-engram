export { loadDaySummaryPrompt } from "./day-summary.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createRequire } from "node:module";
import { parseConfig } from "./config.js";
import { initLogger } from "./logger.js";
import { log } from "./logger.js";
import { detectSdkCapabilities, type SdkCapabilities } from "./sdk-compat.js";
import { Orchestrator, sanitizeSessionKeyForFilename, defaultWorkspaceDir } from "./orchestrator.js";
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

const ENGRAM_REGISTERED_GUARD = "__openclawEngramRegistered";
/** Tracks which api objects have already had hooks bound to prevent duplicate handlers. */
const ENGRAM_HOOK_APIS = "__openclawEngramHookApis";
const ENGRAM_ACCESS_SERVICE = "__openclawEngramAccessService";
const ENGRAM_ACCESS_HTTP_SERVER = "__openclawEngramAccessHttpServer";
/**
 * Guards service.start() against duplicate invocation when multiple api instances
 * each register the service (all registries get registerService, but initialize
 * must only run once per process lifetime). Cleared by stop() so restart cycles
 * re-initialize correctly.
 */
const ENGRAM_SERVICE_STARTED = "__openclawEngramServiceStarted";
/**
 * Holds the in-flight initialization Promise while the first registry's start()
 * is running. Concurrent start() calls from other registries await this promise
 * so they do not resolve before the orchestrator and HTTP server are fully ready.
 * Set to null after init completes (success or failure) and cleared on stop().
 */
const ENGRAM_INIT_PROMISE = "__openclawEngramInitPromise";

// Workaround: Read config directly from openclaw.json since gateway may not pass it.
// IMPORTANT: Do not log raw config contents (may include secrets).
// Shared helper: read and parse the full plugin entry from openclaw.json.
function loadPluginEntryFromFile(): Record<string, unknown> | undefined {
  try {
    const explicitConfigPath =
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH ||
      process.env.OPENCLAW_CONFIG_PATH;
    // Gateway may run without HOME env under service managers.
    const homeDir = process.env.HOME ?? os.homedir();
    const configPath =
      explicitConfigPath && explicitConfigPath.length > 0
        ? explicitConfigPath
        : path.join(homeDir, ".openclaw", "openclaw.json");
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    return config?.plugins?.entries?.["openclaw-engram"] as Record<string, unknown> | undefined;
  } catch (err) {
    log.warn(`Failed to load config from file: ${err}`);
    return undefined;
  }
}

function loadPluginConfigFromFile(): Record<string, unknown> | undefined {
  return loadPluginEntryFromFile()?.config as Record<string, unknown> | undefined;
}

/**
 * Read the plugin hooks policy from both the API config and the file-backed
 * config, since the gateway may not pass the full config to the plugin.
 */
function readPluginHooksPolicy(apiConfig: unknown): Record<string, unknown> | undefined {
  // Try api.config first
  const fromApi = (apiConfig as any)?.plugins?.entries?.["openclaw-engram"]?.hooks;
  if (fromApi && typeof fromApi === "object") return fromApi;
  // Fall back to file-backed config
  return loadPluginEntryFromFile()?.hooks as Record<string, unknown> | undefined;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function shouldSkipRecallForSession(
  sessionKey: string,
  cfg: { cronRecallMode: "all" | "none" | "allowlist"; cronRecallAllowlist: string[] },
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
    const { definePluginEntry } = _require("openclaw/plugin-sdk/plugin-entry") as {
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
  id: "openclaw-engram",
  name: "Engram (Local Memory)",
  description:
    "Local-first memory plugin. Uses GPT-5.2 for intelligent extraction and QMD for storage/retrieval.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    // Initialize logger early (debug off until config is parsed).
    initLogger(api.logger, false);

    // Detect SDK capabilities for dual-path hook registration.
    sdkCaps = detectSdkCapabilities(api as unknown as Record<string, unknown>);
    log.info(
      `SDK detection: version=${sdkCaps.sdkVersion}, beforePromptBuild=${sdkCaps.hasBeforePromptBuild}, memoryPromptSection=${sdkCaps.hasRegisterMemoryPromptSection}, typedHooks=${sdkCaps.hasTypedHooks}`,
    );

    // Skip heavy initialization in setup-only mode (new SDK channel setup flows)
    if (sdkCaps.registrationMode === "setup-only") {
      log.info("registrationMode=setup-only — skipping full initialization");
      return;
    }

    // Workaround: Load config from file since gateway may not pass it
    const fileConfig = loadPluginConfigFromFile();
    const cfg = parseConfig({
      ...api.pluginConfig,
      ...fileConfig, // Merge file config as workaround
      gatewayConfig: api.config, // Pass gateway config for fallback AI
    });
    // Re-initialize with correct debug setting
    initLogger(api.logger, cfg.debug);
    log.info(
      `initialized (debug=${cfg.debug}, qmdEnabled=${cfg.qmdEnabled}, transcriptEnabled=${cfg.transcriptEnabled}, hourlySummariesEnabled=${cfg.hourlySummariesEnabled}, localLlmEnabled=${cfg.localLlmEnabled}${cfg.localLlmFastEnabled ? `, fastLlm=${cfg.localLlmFastModel || "(primary)"}` : ""})`,
    );

    // Singleton guard: the gateway calls register() once per agent (each with a
    // different plugin registry). Reuse the orchestrator (heavy object) but always
    // re-register hooks — each api.on() call binds to the caller's registry, so
    // skipping registration leaves later registries with zero hooks.
    const existing = (globalThis as any).__openclawEngramOrchestrator as Orchestrator | undefined;
    const orchestrator = existing?.recall ? existing : new Orchestrator(cfg);
    const isFirstRegistration = !(globalThis as any)[ENGRAM_REGISTERED_GUARD];
    (globalThis as any)[ENGRAM_REGISTERED_GUARD] = true;

    // Per-api hook deduplication: if the same api object calls register() twice
    // (e.g., during reload edge cases), skip re-binding hooks to avoid double-
    // fired handlers (double recall, double extraction, double reset).
    const hookApis: WeakSet<object> = ((globalThis as any)[ENGRAM_HOOK_APIS] ??= new WeakSet());
    if (hookApis.has(api)) {
      log.debug("register: this api already has hooks bound — skipping duplicate hook registration");
      return;
    }
    hookApis.add(api);

    if (!isFirstRegistration) {
      log.debug("register called again (new registry); re-registering hooks with shared orchestrator");
    }

    // Expose for inter-plugin discovery (e.g., langsmith tracing)
    (globalThis as any).__openclawEngramOrchestrator = orchestrator;
    // Trace callback slot — langsmith (or any observer) will overwrite this
    if ((globalThis as any).__openclawEngramTrace === undefined) {
      (globalThis as any).__openclawEngramTrace = undefined;
    }

    const existingAccessService =
      (globalThis as any)[ENGRAM_ACCESS_SERVICE] as EngramAccessService | undefined;
    const accessService =
      existingAccessService && (existingAccessService as EngramAccessService)
        ? existingAccessService
        : new EngramAccessService(orchestrator);
    (globalThis as any)[ENGRAM_ACCESS_SERVICE] = accessService;

    const existingAccessHttpServer =
      (globalThis as any)[ENGRAM_ACCESS_HTTP_SERVER] as EngramAccessHttpServer | undefined;
    const accessHttpServer =
      existingAccessHttpServer && (existingAccessHttpServer as EngramAccessHttpServer)
        ? existingAccessHttpServer
        : new EngramAccessHttpServer({
            service: accessService,
            host: cfg.agentAccessHttp.host,
            port: cfg.agentAccessHttp.port,
            authToken: cfg.agentAccessHttp.authToken,
            principal: cfg.agentAccessHttp.principal,
            maxBodyBytes: cfg.agentAccessHttp.maxBodyBytes,
          });
    (globalThis as any)[ENGRAM_ACCESS_HTTP_SERVER] = accessHttpServer;

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
    const hooksPolicy = readPluginHooksPolicy(api.config);
    const promptInjectionAllowed = hooksPolicy?.allowPromptInjection !== false;

    // True when the section builder will be registered (capability + policy).
    // Must be determined before the hook registration block below.
    const useMemoryPromptSection =
      sdkCaps.hasRegisterMemoryPromptSection &&
      typeof api.registerMemoryPromptSection === "function" &&
      promptInjectionAllowed;

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
      if (!prompt || prompt.length < 5) return;

      const sessionKey = (ctx?.sessionKey as string) ?? "default";
      log.debug(`${hookLabel}: sessionKey=${sessionKey}, promptLen=${prompt.length}`);
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

      try {
        await orchestrator.maybeRunFileHygiene().catch(() => undefined);

        if (orchestrator.config.compactionResetEnabled) {
          const agentWorkspace = ctx?.workspaceDir as string | undefined;
          if (agentWorkspace) {
            orchestrator.setRecallWorkspaceOverride(sessionKey, agentWorkspace);
          }
        }
        const context = await orchestrator.recall(prompt, sessionKey);
        log.debug(`${hookLabel}: recall returned ${context?.length ?? 0} chars`);
        if (!context) return;

        const maxChars = cfg.recallBudgetChars;
        if (maxChars === 0) return;
        const trimmed =
          context.length > maxChars
            ? context.slice(0, maxChars) + "\n\n...(memory context trimmed)"
            : context;

        const memoryContextPrompt =
          `## Memory Context (Engram)\n\n${trimmed}\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.`;

        log.debug(`${hookLabel}: returning system prompt with ${trimmed.length} chars`);
        // New SDK (before_prompt_build): only prependSystemContext — gateway
        // applies both fields separately, so returning both would duplicate.
        // Legacy (before_agent_start): return both for backward compat with
        // older gateways that may consume either field.
        if (hookLabel === "before_prompt_build") {
          return { prependSystemContext: memoryContextPrompt };
        }
        return {
          prependSystemContext: memoryContextPrompt,
          prependContext: memoryContextPrompt,
        };
      } catch (err) {
        log.error("recall failed", err);
        if (orchestrator.config.compactionResetEnabled) {
          orchestrator.clearRecallWorkspaceOverride(sessionKey);
        }
        return;
      }
    }

    if (!useMemoryPromptSection) {
      if (sdkCaps.hasBeforePromptBuild) {
        // New SDK path — literal string for compat checker detection
        api.on("before_prompt_build", async (event: Record<string, unknown>, ctx: Record<string, unknown>) =>
          recallHookHandler("before_prompt_build", event, ctx));
      } else {
        // Legacy SDK path — literal string for compat checker detection
        api.on("before_agent_start", async (event: Record<string, unknown>, ctx: Record<string, unknown>) =>
          recallHookHandler("before_agent_start", event, ctx));
      }
    }

    // ========================================================================
    // registerMemoryPromptSection — structured memory injection (new SDK)
    // ========================================================================
    if (useMemoryPromptSection && api.registerMemoryPromptSection) {
      const memoryBuildFn = async ({ prompt, sessionKey }: { prompt: string; sessionKey: string }) => {
        if (!prompt || prompt.length < 5) return null;
        if (shouldSkipRecallForSession(sessionKey, cfg)) return null;
        try {
          await orchestrator.maybeRunFileHygiene().catch(() => undefined);
          const context = await orchestrator.recall(prompt, sessionKey);
          if (!context) return null;
          const maxChars = cfg.recallBudgetChars;
          if (maxChars === 0) return null;
          const trimmed = context.length > maxChars
            ? context.slice(0, maxChars) + "\n\n...(memory context trimmed)"
            : context;
          return `## Memory Context (Engram)\n\n${trimmed}\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.`;
        } catch (err) {
          log.error("registerMemoryPromptSection build failed", err);
          return null;
        }
      };

      // Compat: the gateway stores whatever is passed here as `_builder`
      // and later calls `_builder(params)`.  Pass the bare function so it
      // works on all gateway versions (<=2026.3.22 and newer).  Attach
      // metadata as properties so a future gateway that inspects them can
      // still read id/label without a breaking API change.
      (memoryBuildFn as any).id = "engram-memory";
      (memoryBuildFn as any).label = "Engram Memory Context";
      api.registerMemoryPromptSection(memoryBuildFn as any);
    }

    // ========================================================================
    // HOOK: agent_end — Buffer turns and trigger extraction
    // ========================================================================
    api.on(
      "agent_end",
      async (
        event: import("openclaw/plugin-sdk").PluginHookAgentEndEvent & Record<string, unknown>,
        ctx: import("openclaw/plugin-sdk").PluginHookAgentContext & Record<string, unknown>,
      ) => {
        if (!event.success || !Array.isArray(event.messages)) return;
        if (event.messages.length === 0) return;

        const sessionKey = (ctx?.sessionKey as string) ?? "default";

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
                const name = (msg as any).name ?? (msg as any).toolName ?? (msg as any).tool;
                if (typeof name === "string" && name.length > 0) toolNames.push(name);
              }
              if (role === "assistant") {
                const toolCalls = (msg as any).tool_calls ?? (msg as any).toolCalls;
                if (Array.isArray(toolCalls)) {
                  for (const tc of toolCalls) {
                    const fnName = tc?.function?.name ?? tc?.name;
                    if (typeof fnName === "string" && fnName.length > 0) toolNames.push(fnName);
                  }
                }
              }
            }
            for (const tool of toolNames) {
              await orchestrator.transcript.appendToolUse({ timestamp: eventTimestamp, sessionKey, tool });
            }
          }

          try {
            await recordObjectiveStateSnapshotsFromAgentMessages({
              memoryDir: orchestrator.config.memoryDir,
              objectiveStateStoreDir: orchestrator.config.objectiveStateStoreDir,
              objectiveStateMemoryEnabled: orchestrator.config.objectiveStateMemoryEnabled,
              objectiveStateSnapshotWritesEnabled: orchestrator.config.objectiveStateSnapshotWritesEnabled,
              sessionKey,
              recordedAt: eventTimestamp,
              messages,
            });
          } catch (error) {
            log.debug(`agent_end objective-state writer skipped due to error: ${error}`);
          }

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
            const inlineCaptureEnabled = shouldProcessInlineExplicitCapture(orchestrator.config);
            const explicitNotes = inlineCaptureEnabled
              ? parseInlineExplicitCaptureNotes(cleaned)
              : [];
            const stripped = inlineCaptureEnabled && hasInlineExplicitCaptureMarkup(cleaned)
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
                  orchestrator.requestQmdMaintenanceForTool("inline.memory_note.review");
                  log.warn(
                    `explicit inline capture queued for review: ${queued.id}${queued.duplicateOf ? ` (duplicate of ${queued.duplicateOf})` : ""}`,
                  );
                } catch (queueError) {
                  log.warn(`explicit inline capture rejected: ${error}; review queue fallback failed: ${queueError}`);
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
              await orchestrator.processTurn(role, stripped, sessionKey);
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
                await orchestrator.lcmEngine.observeMessages(sessionKey, lcmMessages);
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
        event: import("openclaw/plugin-sdk").PluginHookBeforeCompactionEvent & Record<string, unknown>,
        ctx: import("openclaw/plugin-sdk").PluginHookAgentContext & Record<string, unknown>,
      ) => {
        // Fall back to event.sessionKey when ctx is empty (new SDK may provide it on the event).
        const sessionKey = (ctx?.sessionKey as string) ?? (event?.sessionKey as string) ?? "default";

        try {
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
                for (const msg of event.messages as Array<{ content?: unknown }>) {
                  if (typeof msg.content === "string") {
                    tokensBefore += estimateLcmTokens(msg.content);
                  } else if (Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                      if (typeof block === "string") tokensBefore += estimateLcmTokens(block);
                      else if (block && typeof block === "object" && typeof (block as any).text === "string")
                        tokensBefore += estimateLcmTokens((block as any).text);
                    }
                  }
                }
              }
              lcmTokensBefore.set(sessionKey, tokensBefore);
              await orchestrator.lcmEngine.preCompactionFlush(sessionKey);
            } catch (lcmErr) {
              log.debug(`LCM before_compaction error: ${lcmErr}`);
            }
          }

          if (!orchestrator.config.checkpointEnabled) {
            return;
          }

          // Get recent turns from transcript
          const entries = await orchestrator.transcript.readRecent(1, sessionKey);
          const checkpointTurns = entries.slice(-orchestrator.config.checkpointTurns);

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
        event: import("openclaw/plugin-sdk").PluginHookAfterCompactionEvent & Record<string, unknown>,
        ctx: import("openclaw/plugin-sdk").PluginHookAgentContext & Record<string, unknown>,
      ) => {
        // Fall back to event.sessionKey when ctx is empty (new SDK may provide it on the event).
        const sessionKey = (ctx?.sessionKey as string) ?? (event?.sessionKey as string) ?? "default";

        try {
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
                const msgCountAfter = typeof event.messageCount === "number" ? event.messageCount : 0;
                const compacted = typeof event.compactedCount === "number" ? event.compactedCount : 0;
                const msgCountBefore = msgCountAfter + compacted;
                if (storedBefore > 0 && msgCountBefore > 0) {
                  // Rough estimate: tokens scale proportionally to message count
                  tokensAfter = Math.round(storedBefore * (msgCountAfter / msgCountBefore));
                }
              }
              const tokensBefore = lcmTokensBefore.get(sessionKey) ?? 0;
              lcmTokensBefore.delete(sessionKey);
              await orchestrator.lcmEngine.recordCompaction(sessionKey, tokensBefore, tokensAfter);
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
                  ? String((result as { error?: unknown }).error ?? "unknown error")
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

    // ========================================================================
    // NEW SDK HOOKS (≥2026.3.22 only)
    // These hooks are only available on the new SDK and provide richer
    // lifecycle, tool, LLM, and subagent observation capabilities.
    // ========================================================================
    if (sdkCaps.hasBeforePromptBuild) {
      // ---- Session lifecycle ----
      api.on(
        "session_start",
        async (
          event: import("openclaw/plugin-sdk").PluginHookSessionEvent & Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext & Record<string, unknown>,
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
          event: import("openclaw/plugin-sdk").PluginHookSessionEvent & Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext & Record<string, unknown>,
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
          event: import("openclaw/plugin-sdk").PluginHookBeforeToolCallEvent & Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext & Record<string, unknown>,
        ) => {
          if (event.toolName) {
            log.debug(`before_tool_call: ${event.toolName}`);
          }
        },
      );

      api.on(
        "after_tool_call",
        async (
          event: import("openclaw/plugin-sdk").PluginHookAfterToolCallEvent & Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext & Record<string, unknown>,
        ) => {
          // Log tool usage for debugging. Tool stats for hourly summaries are
          // recorded in agent_end (gated on success=true) to avoid counting
          // tools from failed/aborted turns.
          if (event.toolName) {
            log.debug(`after_tool_call: ${event.toolName} (${event.durationMs ?? "?"}ms)`);
          }
        },
      );

      // ---- LLM observation ----
      api.on(
        "llm_output",
        async (
          event: import("openclaw/plugin-sdk").PluginHookLlmOutputEvent & Record<string, unknown>,
          ctx: import("openclaw/plugin-sdk").PluginHookAgentContext & Record<string, unknown>,
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
          event: import("openclaw/plugin-sdk").PluginHookSubagentSpawningEvent & Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext & Record<string, unknown>,
        ) => {
          log.debug(`subagent_spawning: ${event.subagentId ?? "?"} purpose=${event.purpose ?? "?"}`);
        },
      );

      api.on(
        "subagent_ended",
        async (
          event: import("openclaw/plugin-sdk").PluginHookSubagentEndedEvent & Record<string, unknown>,
          _ctx: import("openclaw/plugin-sdk").PluginHookAgentContext & Record<string, unknown>,
        ) => {
          log.debug(
            `subagent_ended: ${event.subagentId ?? "?"} success=${event.success ?? "?"} ${event.durationMs ?? "?"}ms`,
          );
        },
      );
    } else {
      // Legacy runtime: restore heartbeat observer for sessionObserverEnabled.
      // On new SDK, session_start/session_end hooks replace this.
      // Two paths: registerHook for runtimes that emit event-style heartbeats,
      // and api.on("agent_heartbeat") for pre-2026.1.29 runtimes that emit typed hooks.
      const runtimeApi = api as any;
      runtimeApi.registerHook?.(
        ["agent_heartbeat", "agent:heartbeat"],
        (event: any) => {
          if (orchestrator.config.sessionObserverEnabled !== true) return;
          const sessionKey = (event?.context?.sessionKey as string) ?? "default";
          void orchestrator.observeSessionHeartbeat(sessionKey).catch((err: unknown) => {
            log.debug(`agent_heartbeat observer failed: ${err}`);
          });
        },
        { name: "engram_agent_heartbeat_legacy", description: "Observe legacy heartbeat events for session observation." },
      );

      // Typed api.on path for pre-2026.1.29 builds that route heartbeat through the hook system.
      const runtimeVersion = runtimeApi.runtime?.version || process.env.OPENCLAW_SERVICE_VERSION || "unknown";
      void import("./legacy-hook-compat.js").then(({ shouldRegisterTypedAgentHeartbeat }) => {
        if (shouldRegisterTypedAgentHeartbeat(runtimeVersion)) {
          (api.on as any)("agent_heartbeat", (_event: Record<string, unknown>, ctx: Record<string, unknown>) => {
            if (orchestrator.config.sessionObserverEnabled !== true) return;
            const sessionKey = (ctx?.sessionKey as string) ?? "default";
            void orchestrator.observeSessionHeartbeat(sessionKey).catch((err: unknown) => {
              log.debug(`agent_heartbeat typed observer failed: ${err}`);
            });
          });
          log.info(`registered typed agent_heartbeat hook for OpenClaw ${runtimeVersion}`);
        }
      }).catch(() => {
        // legacy-hook-compat import failed — skip typed registration
      });
    }

    // ========================================================================
    // Helper: Auto-register hourly summary cron job
    // ========================================================================
    async function ensureHourlySummaryCron(api: OpenClawPluginApi): Promise<void> {
      const jobId = "engram-hourly-summary";
      const cronFilePath = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");

      try {
        // Read existing jobs
        let jobsData: { version: number; jobs: Array<{ id: string }> } = { version: 1, jobs: [] };
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
        // - We intentionally avoid posting anywhere; success is silent.
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
              "- Do NOT post to Discord.\n" +
              "- Never print secrets.\n",
          },
          delivery: { mode: "none" as const },
          state: {},
        };

        jobsData.jobs.push(newJob);

        // Write back
        await writeFile(cronFilePath, JSON.stringify(jobsData, null, 2), "utf-8");
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
    registerTools(api as unknown as Parameters<typeof registerTools>[0], orchestrator);
    // Register LCM tools when enabled
    if (orchestrator.lcmEngine?.enabled) {
      registerLcmTools(api as unknown as Parameters<typeof registerLcmTools>[0], orchestrator.lcmEngine);
    }

    if (isFirstRegistration) {
      registerCli(api as unknown as Parameters<typeof registerCli>[0], orchestrator);
    }

    // ========================================================================
    // Register service (every registration)
    // ========================================================================
    // registerService must be called on every api instance, not just the first.
    // Each gateway registry has its own api object; startPluginServices() iterates
    // the registry it owns — if that registry has no service registered, start()
    // never fires and the orchestrator never initializes (issue #285).
    //
    // Duplicate start() calls are safe: the ENGRAM_SERVICE_STARTED guard inside
    // start() makes initialize() idempotent within a process lifetime. stop()
    // clears the flag so restart cycles reinitialize correctly.
    let activeOpikExporter: import("./opik-exporter.js").OpikExporter | null = null;
    // Whether this specific registry's start() claimed a slot in ACTIVE_REGISTRIES.
    // Ensures stop() only decrements the count for registries whose start() ran
    // (not secondary registries whose start() was a no-op, nor registries whose
    // start() threw before successfully initializing).
    let didCountStart = false;
    api.registerService({
      id: "openclaw-engram",
      start: async () => {
        // Check the in-flight promise BEFORE the started flag. ENGRAM_SERVICE_STARTED
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
          while ((globalThis as any)[ENGRAM_INIT_PROMISE]) {
            try {
              await (globalThis as any)[ENGRAM_INIT_PROMISE];
            } catch {
              // A primary's init failed and its outer try-finally already cleared
              // ENGRAM_INIT_PROMISE to null. Re-evaluate the while condition: if
              // another secondary claimed INIT_PROMISE in the meantime, await it;
              // otherwise exit and decide whether to become the next primary.
            }
            // Re-check after awaiting: the primary's start() may have been aborted by
            // a concurrent stop() (via the !didCountStart early return), leaving
            // ENGRAM_SERVICE_STARTED=false even though the promise resolved. In that
            // case continue the loop — we will either see a new INIT_PROMISE (set by
            // the first-resuming takeover waiter) or exit the loop to become primary.
            if ((globalThis as any)[ENGRAM_SERVICE_STARTED]) return;
          }
          // No in-flight init — check if already fully initialized.
          if ((globalThis as any)[ENGRAM_SERVICE_STARTED]) {
            log.debug("openclaw-engram: service.start() called again — skipping duplicate init");
            return;
          }
          // Defensive re-check before claiming ownership. In practice (single-threaded
          // JS, no await between the inner while exit and here) INIT_PROMISE cannot
          // become non-null at this point, but the check makes the ownership invariant
          // self-documenting: we only proceed when no other primary is in-flight.
          if ((globalThis as any)[ENGRAM_INIT_PROMISE]) continue;
          break;
        }
        // We are the first — claim ownership and drive initialization.
        didCountStart = true;
        // IMPORTANT: Do NOT put a `finally` inside the IIFE to clear ENGRAM_INIT_PROMISE.
        // If anything in the try block throws synchronously (before the first `await`),
        // the IIFE's finally would run before the outer assignment, and the outer line
        // `ENGRAM_INIT_PROMISE = initPromise` would then overwrite null with a stale
        // rejected promise — permanently blocking future start() calls. Instead, clear
        // ENGRAM_INIT_PROMISE in the outer try-finally below after `await initPromise`.
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
              await orchestrator.transcript.cleanup(orchestrator.config.transcriptRetentionDays);
              // Abort if stop() was called during transcript cleanup.
              if (!didCountStart) return;
            }

            // Cron integration guard:
            // - Hourly summaries are supported, but auto-registering cron is a footgun across installs.
            // - Only auto-register when explicitly enabled by config.
            if (orchestrator.config.hourlySummariesEnabled && orchestrator.config.hourlySummaryCronAutoRegister) {
              await ensureHourlySummaryCron(api);
              // Abort if stop() was called during cron registration.
              if (!didCountStart) return;
            } else if (orchestrator.config.hourlySummariesEnabled) {
              log.info(
                "hourly summaries enabled; cron auto-register is disabled. " +
                "To schedule summaries, create an isolated/agentTurn cron job that calls `memory_summarize_hourly`.",
              );
            }

            if (cfg.agentAccessHttp.enabled) {
              // Abort if stop() was called before starting the HTTP server.
              if (!didCountStart) return;
              try {
                const status = await accessHttpServer.start();
                log.info(`engram access HTTP ready at http://${status.host}:${status.port}`);
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
            (globalThis as any)[ENGRAM_SERVICE_STARTED] = true;
            // Note: ENGRAM_REGISTERED_GUARD is intentionally NOT set here.
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
          } catch (err) {
            // Unsubscribe Opik exporter if it was subscribed before the failure so
            // a retry from another registry doesn't accumulate multiple subscribers.
            try { activeOpikExporter?.unsubscribe(); } catch {}
            activeOpikExporter = null;
            // Roll back ownership so the next registry's start() can retry.
            // SERVICE_STARTED was not set yet (only set on success above), but
            // clear it defensively in case another code path set it.
            didCountStart = false;
            (globalThis as any)[ENGRAM_SERVICE_STARTED] = false;
            // Do NOT clear ENGRAM_REGISTERED_GUARD here. On an ordinary startup
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
          // No finally here — see comment above. ENGRAM_INIT_PROMISE is cleared
          // by the outer try-finally after `await initPromise` below.
        })();
        // ENGRAM_SERVICE_STARTED is set inside the IIFE (on success only), so any
        // concurrent caller that arrives after INIT_PROMISE is set will await the
        // in-flight init. The SERVICE_STARTED early-return path above is only
        // reachable when INIT_PROMISE is null (init not in-flight), which means
        // SERVICE_STARTED truly reflects a completed, successful init.
        (globalThis as any)[ENGRAM_INIT_PROMISE] = initPromise;
        try {
          await initPromise;
        } finally {
          // Clear the in-flight promise after init settles (success or failure).
          // Placing this here (not inside the IIFE) avoids the ordering hazard where
          // a pre-await throw inside the IIFE would let the outer assignment overwrite
          // null with the rejected promise.
          (globalThis as any)[ENGRAM_INIT_PROMISE] = null;
        }
      },
      stop: async () => {
        // Only the registry whose start() successfully ran initialize() does teardown.
        // Secondary registries (start() returned early on ENGRAM_SERVICE_STARTED) and
        // failed registries (start() rolled back in catch) have didCountStart=false
        // and skip all cleanup — including Opik — to avoid detaching a live exporter.
        if (!didCountStart) return;
        didCountStart = false;
        // Opik cleanup: placed after the guard so secondary stop()s never detach
        // the process-wide exporter while Engram is still running.
        // Wrapped in try-catch (like accessHttpServer.stop()) so a throwing
        // unsubscribe does not leave ENGRAM_SERVICE_STARTED=true and prevent restart.
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
        delete (globalThis as any)[ENGRAM_ACCESS_HTTP_SERVER];
        delete (globalThis as any)[ENGRAM_ACCESS_SERVICE];
        // ENGRAM_REGISTERED_GUARD policy:
        //
        // Full stop (ENGRAM_INIT_PROMISE is null when stop() is called):
        //   Clear GUARD so a subsequent register() in a fresh session can
        //   re-register CLI commands after a stop/reload cycle.
        //
        // Stop-during-init (ENGRAM_INIT_PROMISE is non-null):
        //   Leave GUARD as-is. The CLI registered by the original register()
        //   call is still present in the gateway's registry — stop() does not
        //   unregister CLI commands. Clearing GUARD here would allow a
        //   subsequent register() to register CLI again on top of the
        //   still-live registration, duplicating the CLI command tree.
        const currentInitPromise = (globalThis as any)[ENGRAM_INIT_PROMISE] as Promise<void> | null;
        // Track whether a secondary completed init during stop()'s await window.
        // Used below to guard the SERVICE_STARTED=false assignment.
        let secondaryTookOver = false;
        if (!currentInitPromise) {
          (globalThis as any)[ENGRAM_REGISTERED_GUARD] = false;
        } else {
          // Stop-during-init: leave GUARD as-is.
          // The CLI registered by the original register() call is still present
          // in the gateway's registry; clearing GUARD here would allow a
          // subsequent register() to register CLI again, duplicating commands
          // on top of the still-live registration (thread PRRT_kwDORJXyws5159Kz).
          //
          // Await the in-flight init (didCountStart=false signals it to abort at
          // its next checkpoint). Ignore errors — we only care about settlement.
          try { await currentInitPromise; } catch {}
          // One queueMicrotask tick: any secondary whose .then() on
          // currentInitPromise runs after stop()'s `await` continuation will
          // execute here and synchronously set its own INIT_PROMISE.
          await new Promise<void>((resolve) => queueMicrotask(resolve));
          if (
            (globalThis as any)[ENGRAM_INIT_PROMISE] ||
            (globalThis as any)[ENGRAM_SERVICE_STARTED]
          ) {
            secondaryTookOver = true;
          }
        }
        // Clear per-api hook tracking so hooks can be re-bound to fresh api objects.
        // Skip when a secondary is live — its api objects already have hooks bound
        // and resetting the WeakSet here would cause duplicate hook registration
        // the next time those api objects trigger hook paths (thread PRRT_kwDORJXyws5159K0).
        if (!secondaryTookOver) {
          (globalThis as any)[ENGRAM_HOOK_APIS] = new WeakSet();
        }
        // Allow service.start() to reinitialize after a stop/restart cycle.
        // Skip this when a secondary completed init while stop() was suspended:
        // that registry's start() is the owner of SERVICE_STARTED=true, and its
        // own stop() call will clear the flag. Clobbering it here would let the
        // next start() bypass the idempotency guard and re-run initialize() on
        // the live singleton (Cursor review thread PRRT_kwDORJXyws5156Lw).
        if (!secondaryTookOver) {
          (globalThis as any)[ENGRAM_SERVICE_STARTED] = false;
        }
        // Do NOT clear ENGRAM_INIT_PROMISE here. If stop() is called while init is
        // still in-flight (start() suspended at an await), clearing the promise here
        // would let a new registry enter start() before the original initializer settles
        // and call orchestrator.initialize() a second time on the same singleton.
        // The outer try-finally in start() already clears ENGRAM_INIT_PROMISE when
        // initPromise settles, so no cleanup is needed here — in the normal (post-init)
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

function cleanUserMessage(content: string): string {
  let cleaned = content;
  // Remove memory context blocks
  cleaned = cleaned.replace(
    /<supermemory-context[^>]*>[\s\S]*?<\/supermemory-context>\s*/gi,
    "",
  );
  cleaned = cleaned.replace(
    /## Memory Context \(Engram\)[\s\S]*?(?=\n## |\n$)/gi,
    "",
  );
  // Remove platform headers
  cleaned = cleaned.replace(/^\[\w+\s+.+?\s+id:\d+\s+[^\]]+\]\s*/, "");
  // Remove trailing message IDs
  cleaned = cleaned.replace(/\s*\[message_id:\s*[^\]]+\]\s*$/, "");
  return cleaned.trim();
}
