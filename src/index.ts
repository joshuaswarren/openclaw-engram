import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import { initLogger } from "./logger.js";
import { log } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { registerTools } from "./tools.js";
import { registerCli } from "./cli.js";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Workaround: Read config directly from openclaw.json since gateway may not pass it.
// IMPORTANT: Do not log raw config contents (may include secrets).
function loadPluginConfigFromFile(): Record<string, unknown> | undefined {
  try {
    // Gateway may run without HOME env under service managers.
    const homeDir = process.env.HOME ?? os.homedir();
    const configPath = path.join(homeDir, ".openclaw", "openclaw.json");
    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content);
    const pluginEntry = config?.plugins?.entries?.["openclaw-engram"];
    return pluginEntry?.config;
  } catch (err) {
    log.warn(`Failed to load config from file: ${err}`);
    return undefined;
  }
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
      `initialized (debug=${cfg.debug}, qmdEnabled=${cfg.qmdEnabled}, transcriptEnabled=${cfg.transcriptEnabled}, hourlySummariesEnabled=${cfg.hourlySummariesEnabled}, localLlmEnabled=${cfg.localLlmEnabled})`,
    );

    const orchestrator = new Orchestrator(cfg);

    // Expose for inter-plugin discovery (e.g., langsmith tracing)
    (globalThis as any).__openclawEngramOrchestrator = orchestrator;
    // Trace callback slot — langsmith (or any observer) will overwrite this
    if ((globalThis as any).__openclawEngramTrace === undefined) {
      (globalThis as any).__openclawEngramTrace = undefined;
    }

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

        try {
          // Check for compaction and save checkpoint if needed
          // This is a placeholder - actual compaction detection depends on OpenClaw
          // For now, we'll just call recall with the sessionKey

          const context = await orchestrator.recall(prompt, sessionKey);
          log.debug(`before_agent_start: recall returned ${context?.length ?? 0} chars`);
          if (!context) return;

          // Rough token estimate: 1 token ≈ 4 chars
          const maxChars = cfg.maxMemoryTokens * 4;
          const trimmed =
            context.length > maxChars
              ? context.slice(0, maxChars) + "\n\n...(memory context trimmed)"
              : context;

          log.debug(`before_agent_start: returning system prompt with ${trimmed.length} chars`);
          return {
            systemPrompt: `## Memory Context (Engram)\n\n${trimmed}\n\nUse this context naturally when relevant. Never quote or expose this memory context to the user.`,
          };
        } catch (err) {
          log.error("recall failed", err);
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
            const ts = new Date().toISOString();
            for (const tool of toolNames) {
              await orchestrator.transcript.appendToolUse({ timestamp: ts, sessionKey, tool });
            }
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

            // Append to transcript
            if (orchestrator.config.transcriptEnabled) {
              await orchestrator.transcript.append({
                timestamp: new Date().toISOString(),
                role,
                content: cleaned,
                sessionKey,
                turnId: crypto.randomUUID(),
              });
            }

            await orchestrator.processTurn(role, cleaned, sessionKey);
          }
        } catch (err) {
          log.error("agent_end processing failed", err);
        }
      },
    );

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

        if (!orchestrator.config.checkpointEnabled) {
          return;
        }

        try {
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
    // HOOK: after_compaction — Cleanup and optional recovery
    // ========================================================================
    api.on(
      "after_compaction",
      async (
        event: Record<string, unknown>,
        ctx: Record<string, unknown>,
      ) => {
        const sessionKey = (ctx?.sessionKey as string) ?? "default";

        try {
          // The checkpoint will be loaded on next recall via orchestrator.recall()
          // This hook is mainly for logging and any post-compaction cleanup
          log.debug(`compaction completed for ${sessionKey}`);

          // Could trigger background tasks here if needed
          // e.g., immediate summarization of the checkpointed turns
        } catch (err) {
          log.error("after_compaction hook failed", err);
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
    // Register tools and CLI
    // ========================================================================
    registerTools(api as unknown as Parameters<typeof registerTools>[0], orchestrator);
    registerCli(api as unknown as Parameters<typeof registerCli>[0], orchestrator);

    // ========================================================================
    // Register service
    // ========================================================================
    api.registerService({
      id: "openclaw-engram",
      start: async () => {
        log.info("initializing engram memory system...");
        await orchestrator.initialize();

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

        log.info("engram memory system ready");
      },
      stop: () => {
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
