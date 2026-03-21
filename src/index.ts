export { loadDaySummaryPrompt } from "./day-summary.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import { initLogger } from "./logger.js";
import { log } from "./logger.js";
import { Orchestrator, sanitizeSessionKeyForFilename, defaultWorkspaceDir } from "./orchestrator.js";
import { registerTools } from "./tools.js";
import { registerLcmTools } from "./lcm/index.js";
import { estimateTokens as estimateLcmTokens } from "./lcm/archive.js";
import { registerCli } from "./cli.js";
import { recordObjectiveStateSnapshotsFromAgentMessages } from "./objective-state-writers.js";
import { EngramAccessService } from "./access-service.js";
import { EngramAccessHttpServer } from "./access-http.js";
import { shouldRegisterTypedAgentHeartbeat } from "./legacy-hook-compat.js";
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

type LegacyHeartbeatHookEvent = {
  context?: Record<string, unknown>;
};

type LegacyHeartbeatRuntimeApi = OpenClawPluginApi & {
  registerHook?: (
    events: string | string[],
    handler: (event: LegacyHeartbeatHookEvent) => void,
    opts?: {
      name?: string;
      description?: string;
    },
  ) => void;
  runtime?: {
    version?: string;
  };
};

// Workaround: Read config directly from openclaw.json since gateway may not pass it.
// IMPORTANT: Do not log raw config contents (may include secrets).
function loadPluginConfigFromFile(): Record<string, unknown> | undefined {
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
    const pluginEntry = config?.plugins?.entries?.["openclaw-engram"];
    return pluginEntry?.config;
  } catch (err) {
    log.warn(`Failed to load config from file: ${err}`);
    return undefined;
  }
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

function observeSessionHeartbeat(
  orchestrator: Orchestrator,
  ctx: Record<string, unknown> | undefined,
): void {
  if (orchestrator.config.sessionObserverEnabled !== true) return;
  const sessionKey = (ctx?.sessionKey as string) ?? "default";
  void orchestrator.observeSessionHeartbeat(sessionKey).catch((err) => {
    log.debug(`agent_heartbeat observer failed: ${err}`);
  });
}

export default {
  id: "openclaw-engram",
  name: "Engram (Local Memory)",
  description:
    "Local-first memory plugin. Uses GPT-5.2 for intelligent extraction and QMD for storage/retrieval.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    // Initialize logger early (debug off until config is parsed).
    initLogger(api.logger, false);

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
    // HOOK: before_agent_start — Inject memory context
    // ========================================================================
    api.on(
      "before_agent_start",
      async (
        event: Record<string, unknown>,
        ctx: Record<string, unknown>,
      ) => {
        const prompt = event.prompt as string | undefined;
        if (!prompt || prompt.length < 5) return;

        const sessionKey = (ctx?.sessionKey as string) ?? "default";
        log.debug(`before_agent_start: sessionKey=${sessionKey}, promptLen=${prompt.length}`);
        log.debug(
          `before_agent_start: cronRecallMode=${cfg.cronRecallMode}, allowlistCount=${cfg.cronRecallAllowlist.length}`,
        );
        if (sessionKey.includes(":cron:") && cfg.cronRecallMode === "allowlist") {
          const matchedPattern = cfg.cronRecallAllowlist.find((pattern) => {
            const re = wildcardToRegExp(pattern);
            return re.test(sessionKey);
          });
          log.debug(
            `before_agent_start: cron allowlist match=${matchedPattern ? "yes" : "no"} pattern=${matchedPattern ?? "none"}`,
          );
        }

        if (shouldSkipRecallForSession(sessionKey, cfg)) {
          log.debug(
            `before_agent_start: skip recall for cron session ${sessionKey} (mode=${cfg.cronRecallMode})`,
          );
          return;
        }

        try {
          // Optional: keep bootstrap workspace files small and warn about truncation risk.
          await orchestrator.maybeRunFileHygiene().catch(() => undefined);

          // Check for compaction and save checkpoint if needed
          // This is a placeholder - actual compaction detection depends on OpenClaw
          // For now, we'll just call recall with the sessionKey

          // Pass per-agent workspace so compaction reset reads the right BOOT.md.
          // Only set when compaction reset is enabled to avoid unbounded Map growth
          // when recall is skipped (e.g., no_recall planner decision).
          if (orchestrator.config.compactionResetEnabled) {
            const agentWorkspace = ctx?.workspaceDir as string | undefined;
            if (agentWorkspace) {
              orchestrator.setRecallWorkspaceOverride(sessionKey, agentWorkspace);
            }
          }
          const context = await orchestrator.recall(prompt, sessionKey);
          log.debug(`before_agent_start: recall returned ${context?.length ?? 0} chars`);
          if (!context) return;

          // Final safety cap; recall assembly also enforces this budget.
          const maxChars = cfg.recallBudgetChars;
          if (maxChars === 0) return;
          const trimmed =
            context.length > maxChars
              ? context.slice(0, maxChars) + "\n\n...(memory context trimmed)"
              : context;

          const memoryContextPrompt =
            `## Memory Context (Engram)\n\n${trimmed}\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.`;

          log.debug(`before_agent_start: returning system prompt with ${trimmed.length} chars`);
          return {
            prependSystemContext: memoryContextPrompt,
            // Backward-compat path for gateway builds that consume prependContext.
            prependContext: memoryContextPrompt,
          };
        } catch (err) {
          log.error("recall failed", err);
          // Clean up workspace override to prevent Map leak on exception.
          if (orchestrator.config.compactionResetEnabled) {
            orchestrator.clearRecallWorkspaceOverride(sessionKey);
          }
          return;
        }
      },
    );

    // ========================================================================
    // HOOK: agent_end — Buffer turns and trigger extraction
    // ========================================================================
    api.on(
      "agent_end",
      async (
        event: Record<string, unknown>,
        ctx: Record<string, unknown>,
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

    // ========================================================================
    // HOOK: agent_heartbeat — Observe active session growth (non-blocking)
    // ========================================================================
    // Keep the historical heartbeat observer for older/custom runtimes without
    // warning on current published OpenClaw builds where the typed hook is gone.
    const runtimeApi = api as LegacyHeartbeatRuntimeApi;

    runtimeApi.registerHook?.(
      ["agent_heartbeat", "agent:heartbeat"],
      (event: LegacyHeartbeatHookEvent) => {
        observeSessionHeartbeat(orchestrator, event.context);
      },
      {
        name: "engram_agent_heartbeat_legacy",
        description:
          "Observe legacy OpenClaw heartbeat events when the runtime still emits them.",
      },
    );

    const runtimeVersion =
      runtimeApi.runtime?.version ||
      process.env.OPENCLAW_SERVICE_VERSION ||
      "unknown";
    if (shouldRegisterTypedAgentHeartbeat(runtimeVersion)) {
      (
        api.on as unknown as (
          hookName: string,
          handler: (
            event: Record<string, unknown>,
            ctx: Record<string, unknown>,
          ) => void,
        ) => void
      )("agent_heartbeat", (_event, ctx) => {
        observeSessionHeartbeat(orchestrator, ctx);
      });
      log.info(
        `registered legacy typed agent_heartbeat hook for OpenClaw ${runtimeVersion}`,
      );
    } else {
      log.debug(
        `skipping legacy typed agent_heartbeat hook for OpenClaw ${runtimeVersion}; published builds from 2026.1.29 onward do not expose it`,
      );
    }

    // Stash pre-compaction token counts so after_compaction can record the pair.
    const lcmTokensBefore = new Map<string, number>();

    // ========================================================================
    // HOOK: before_compaction — Save checkpoint before context is lost
    // ========================================================================
    api.on(
      "before_compaction",
      async (
        event: Record<string, unknown>,
        ctx: Record<string, unknown>,
      ) => {
        const sessionKey = (ctx?.sessionKey as string) ?? "default";

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
        event: Record<string, unknown>,
        ctx: Record<string, unknown>,
      ) => {
        const sessionKey = (ctx?.sessionKey as string) ?? "default";

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

          // Use ctx.workspaceDir (per-agent) if available, fall back to config.
          const workspaceDir =
            (ctx?.workspaceDir as string) ||
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
        if ((globalThis as any)[ENGRAM_SERVICE_STARTED]) {
          log.debug("openclaw-engram: service.start() called again — skipping duplicate init");
          return;
        }
        // Mark this registry as the one that owns the initialized state.
        // Cleared in catch if init fails so another registry can retry.
        didCountStart = true;
        // Set flag before init so concurrent start() calls are deduplicated; clear on failure
        // so the next start() attempt (e.g. from another registry) can retry.
        (globalThis as any)[ENGRAM_SERVICE_STARTED] = true;
        try {
          log.info("initializing engram memory system...");
          await orchestrator.initialize();

          // Initialize Opik exporter if configured
          activeOpikExporter = createOpikExporter({}, log);
          if (activeOpikExporter) activeOpikExporter.subscribe();

          // Cleanup old transcripts
          if (orchestrator.config.transcriptEnabled) {
            await orchestrator.transcript.cleanup(orchestrator.config.transcriptRetentionDays);
          }

          // Cron integration guard:
          // - Hourly summaries are supported, but auto-registering cron is a footgun across installs.
          // - Only auto-register when explicitly enabled by config.
          if (orchestrator.config.hourlySummariesEnabled && orchestrator.config.hourlySummaryCronAutoRegister) {
            await ensureHourlySummaryCron(api);
          } else if (orchestrator.config.hourlySummariesEnabled) {
            log.info(
              "hourly summaries enabled; cron auto-register is disabled. " +
              "To schedule summaries, create an isolated/agentTurn cron job that calls `memory_summarize_hourly`.",
            );
          }

          if (cfg.agentAccessHttp.enabled) {
            try {
              const status = await accessHttpServer.start();
              log.info(`engram access HTTP ready at http://${status.host}:${status.port}`);
            } catch (err) {
              log.error("failed to start engram access HTTP server", err);
            }
          }

          log.info("engram memory system ready");
        } catch (err) {
          // Roll back so the next registry's start() can retry.
          didCountStart = false;
          (globalThis as any)[ENGRAM_SERVICE_STARTED] = false;
          throw err;
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
        activeOpikExporter?.unsubscribe();
        activeOpikExporter = null;
        try {
          await accessHttpServer.stop();
        } catch (err) {
          log.debug(`engram access HTTP stop failed: ${err}`);
        }
        delete (globalThis as any)[ENGRAM_ACCESS_HTTP_SERVER];
        delete (globalThis as any)[ENGRAM_ACCESS_SERVICE];
        // Allow tools/CLI/service to re-register after a stop/reload cycle.
        (globalThis as any)[ENGRAM_REGISTERED_GUARD] = false;
        // Clear per-api hook tracking so hooks can be re-bound to fresh api objects.
        (globalThis as any)[ENGRAM_HOOK_APIS] = new WeakSet();
        // Allow service.start() to reinitialize after a stop/restart cycle.
        (globalThis as any)[ENGRAM_SERVICE_STARTED] = false;
        log.info("stopped");
      },
    });
  },
};

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
