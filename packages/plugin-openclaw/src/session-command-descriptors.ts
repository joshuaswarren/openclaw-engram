import type { SessionToggleStore } from "../../remnic-core/src/session-toggles.js";
import type { LastRecallSnapshot } from "../../remnic-core/src/recall-state.js";

export interface SessionCommandContext {
  sessionKey?: string;
  agentId?: string;
}

export interface SessionCommandRuntime {
  toggles: SessionToggleStore;
  getLastRecall(sessionKey: string): LastRecallSnapshot | null;
  getLastRecallSummary(sessionKey: string): string | null;
  flushSession(sessionKey: string): Promise<void>;
}

function describeToggleSource(source: "primary" | "secondary" | "none"): string {
  if (source === "primary") return "Remnic session override";
  if (source === "secondary") return "bundled active-memory override";
  return "global config";
}

function resolveSession(commandCtx: SessionCommandContext): { sessionKey: string; agentId: string } {
  return {
    sessionKey: commandCtx.sessionKey ?? "default",
    agentId: commandCtx.agentId ?? "main",
  };
}

export function buildSessionCommandDescriptors(
  pluginId: string,
  runtime: SessionCommandRuntime,
) {
  return [
    {
      name: "remnic",
      category: "memory",
      pluginId,
      subcommands: [
        {
          name: "off",
          description: "Disable Remnic recall for this session",
          args: [],
          handler: async (commandCtx: SessionCommandContext = {}) => {
            const { sessionKey, agentId } = resolveSession(commandCtx);
            await runtime.toggles.setDisabled(sessionKey, agentId, true);
            return `Remnic recall disabled for session ${sessionKey}.`;
          },
        },
        {
          name: "on",
          description: "Re-enable Remnic recall for this session",
          args: [],
          handler: async (commandCtx: SessionCommandContext = {}) => {
            const { sessionKey, agentId } = resolveSession(commandCtx);
            await runtime.toggles.setDisabled(sessionKey, agentId, false);
            return `Remnic recall re-enabled for session ${sessionKey}.`;
          },
        },
        {
          name: "status",
          description: "Show Remnic recall status and last injected summary",
          args: [],
          handler: async (commandCtx: SessionCommandContext = {}) => {
            const { sessionKey, agentId } = resolveSession(commandCtx);
            const resolved = await runtime.toggles.resolve(sessionKey, agentId);
            const lastRecall = runtime.getLastRecall(sessionKey);
            const summaryText = runtime.getLastRecallSummary(sessionKey);
            const summary = summaryText && summaryText.length > 0
              ? summaryText
              : lastRecall && lastRecall.memoryIds.length > 0
                ? `${lastRecall.memoryIds.length} memory item(s), latency ${lastRecall.latencyMs ?? "?"}ms`
                : "NONE";
            return [
              `Remnic recall is ${resolved.disabled ? "disabled" : "enabled"} for session ${sessionKey}.`,
              `Source: ${describeToggleSource(resolved.source)}.`,
              `Last recall: ${summary}.`,
            ].join(" ");
          },
        },
        {
          name: "clear",
          description: "Clear the session override and use global config again",
          args: [],
          handler: async (commandCtx: SessionCommandContext = {}) => {
            const { sessionKey, agentId } = resolveSession(commandCtx);
            await runtime.toggles.clear(sessionKey, agentId);
            return `Cleared the Remnic session override for ${sessionKey}.`;
          },
        },
        {
          name: "stats",
          description: "Show Remnic extraction and recall stats for this session",
          args: [],
          handler: async (commandCtx: SessionCommandContext = {}) => {
            const { sessionKey } = resolveSession(commandCtx);
            const lastRecall = runtime.getLastRecall(sessionKey);
            if (!lastRecall) {
              return `No Remnic recall stats are available for session ${sessionKey} yet.`;
            }
            return [
              `Session ${sessionKey}.`,
              `Planner mode: ${lastRecall.plannerMode ?? "unknown"}.`,
              `Latency: ${lastRecall.latencyMs ?? "?"}ms.`,
              `Memories: ${lastRecall.memoryIds.length}.`,
            ].join(" ");
          },
        },
        {
          name: "flush",
          description: "Force-flush the extraction buffer now",
          args: [],
          handler: async (commandCtx: SessionCommandContext = {}) => {
            const { sessionKey } = resolveSession(commandCtx);
            await runtime.flushSession(sessionKey);
            return `Flushed the Remnic buffer for session ${sessionKey}.`;
          },
        },
      ],
    },
  ];
}
