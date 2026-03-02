import type { PluginConfig } from "../types.js";
import type { SearchBackend } from "./port.js";
import { NoopSearchBackend } from "./noop-backend.js";
import { RemoteSearchBackend } from "./remote-backend.js";
import { QmdClient } from "../qmd.js";

/**
 * Create a SearchBackend from plugin config.
 *
 * - "noop" → NoopSearchBackend
 * - "remote" → RemoteSearchBackend (HTTP REST)
 * - "qmd" (default) → QmdClient if qmdEnabled, else NoopSearchBackend
 */
export function createSearchBackend(config: PluginConfig): SearchBackend {
  const backend = config.searchBackend ?? "qmd";

  if (backend === "noop") {
    return new NoopSearchBackend();
  }

  if (backend === "remote") {
    return new RemoteSearchBackend({
      baseUrl: config.remoteSearchBaseUrl ?? "http://localhost:8181",
      apiKey: config.remoteSearchApiKey,
      timeoutMs: config.remoteSearchTimeoutMs,
    });
  }

  // Default: QMD — fall back to noop if qmdEnabled is false
  if (!config.qmdEnabled) {
    return new NoopSearchBackend();
  }

  return new QmdClient(config.qmdCollection, config.qmdMaxResults, {
    slowLog: {
      enabled: config.slowLogEnabled,
      thresholdMs: config.slowLogThresholdMs,
    },
    updateTimeoutMs: config.qmdUpdateTimeoutMs,
    updateMinIntervalMs: config.qmdUpdateMinIntervalMs,
    qmdPath: config.qmdPath,
    daemonUrl: config.qmdDaemonEnabled ? config.qmdDaemonUrl : undefined,
    daemonRecheckIntervalMs: config.qmdDaemonRecheckIntervalMs,
  });
}

/**
 * Create a SearchBackend for conversation index use.
 * Returns undefined if conversation index is not enabled or not using qmd backend.
 */
export function createConversationSearchBackend(config: PluginConfig): SearchBackend | undefined {
  if (!config.conversationIndexEnabled || config.conversationIndexBackend !== "qmd") {
    return undefined;
  }

  const backend = config.searchBackend ?? "qmd";

  if (backend === "noop") {
    return new NoopSearchBackend();
  }

  if (backend === "remote") {
    return new RemoteSearchBackend({
      baseUrl: config.remoteSearchBaseUrl ?? "http://localhost:8181",
      apiKey: config.remoteSearchApiKey,
      timeoutMs: config.remoteSearchTimeoutMs,
    });
  }

  // Default: QMD — fall back to noop if qmdEnabled is false
  if (!config.qmdEnabled) {
    return new NoopSearchBackend();
  }

  return new QmdClient(
    config.conversationIndexQmdCollection,
    Math.max(6, config.conversationRecallTopK),
    {
      slowLog: {
        enabled: config.slowLogEnabled,
        thresholdMs: config.slowLogThresholdMs,
      },
      updateTimeoutMs: config.qmdUpdateTimeoutMs,
      updateMinIntervalMs: config.qmdUpdateMinIntervalMs,
      qmdPath: config.qmdPath,
      daemonUrl: config.qmdDaemonEnabled ? config.qmdDaemonUrl : undefined,
      daemonRecheckIntervalMs: config.qmdDaemonRecheckIntervalMs,
    },
  );
}
