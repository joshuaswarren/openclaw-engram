import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import { initLogger } from "./logger.js";
import { log } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { registerTools } from "./tools.js";
import { registerCli } from "./cli.js";

export default {
  id: "openclaw-engram",
  name: "Engram (Local Memory)",
  description:
    "Local-first memory plugin. Uses GPT-5.2 for intelligent extraction and QMD for storage/retrieval.",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    initLogger(api.logger, cfg.debug);

    const orchestrator = new Orchestrator(cfg);

    // Expose for inter-plugin discovery (e.g., langsmith tracing)
    (globalThis as any).__openclawEngramOrchestrator = orchestrator;
    // Trace callback slot — langsmith (or any observer) will overwrite this
    if ((globalThis as any).__openclawEngramTrace === undefined) {
      (globalThis as any).__openclawEngramTrace = undefined;
    }

    // ========================================================================
    // HOOK: gateway_start — Initialize subsystems
    // ========================================================================
    api.on("gateway_start", async () => {
      log.info("initializing engram memory system...");
      await orchestrator.initialize();
      log.info("engram memory system ready");
    });

    // ========================================================================
    // HOOK: before_agent_start — Inject memory context
    // ========================================================================
    api.on(
      "before_agent_start",
      async (
        event: Record<string, unknown>,
        _ctx: Record<string, unknown>,
      ) => {
        const prompt = event.prompt as string | undefined;
        if (!prompt || prompt.length < 5) return;

        try {
          const context = await orchestrator.recall(prompt);
          if (!context) return;

          // Rough token estimate: 1 token ≈ 4 chars
          const maxChars = cfg.maxMemoryTokens * 4;
          const trimmed =
            context.length > maxChars
              ? context.slice(0, maxChars) + "\n\n...(memory context trimmed)"
              : context;

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

          for (const msg of lastTurn) {
            const role = msg.role as "user" | "assistant";
            const content = extractTextContent(msg);
            if (content.length < 10) continue;

            // Clean system metadata from user messages
            const cleaned =
              role === "user" ? cleanUserMessage(content) : content;

            await orchestrator.processTurn(role, cleaned, sessionKey);
          }
        } catch (err) {
          log.error("agent_end processing failed", err);
        }
      },
    );

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
      start: () => {
        log.info("started");
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
