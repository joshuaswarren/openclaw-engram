import type { PluginConfig } from "../types.js";
import type { SearchBackend } from "./port.js";
import { NoopSearchBackend } from "./noop-backend.js";
import { RemoteSearchBackend } from "./remote-backend.js";
import { LanceDbBackend } from "./lancedb-backend.js";
import { MeilisearchBackend } from "./meilisearch-backend.js";
import { OramaBackend } from "./orama-backend.js";
import { EmbedHelper } from "./embed-helper.js";
import { QmdClient, type QmdClientOptions } from "../qmd.js";
import { log } from "../logger.js";

/**
 * Resolve non-QMD backends from config.
 * Returns a SearchBackend for "noop" or "remote", or undefined to signal "use QMD".
 */
function resolveNonQmdBackend(config: PluginConfig): SearchBackend | undefined {
  const backend = config.searchBackend ?? "qmd";

  if (backend === "noop") {
    return new NoopSearchBackend();
  }

  if (backend === "remote") {
    const baseUrl = config.remoteSearchBaseUrl || "http://localhost:8181";
    if (!config.remoteSearchBaseUrl) {
      log.warn("searchBackend is 'remote' but remoteSearchBaseUrl is not configured; using default http://localhost:8181");
    }
    return new RemoteSearchBackend({
      baseUrl,
      apiKey: config.remoteSearchApiKey,
      timeoutMs: config.remoteSearchTimeoutMs,
    });
  }

  if (backend === "lancedb") {
    const embedHelper = new EmbedHelper(config);
    return new LanceDbBackend({
      dbPath: config.lanceDbPath!,
      collection: config.qmdCollection,
      embedHelper,
      memoryDir: config.memoryDir,
      embeddingDimension: config.lanceEmbeddingDimension!,
    });
  }

  if (backend === "meilisearch") {
    return new MeilisearchBackend({
      host: config.meilisearchHost!,
      apiKey: config.meilisearchApiKey,
      collection: config.qmdCollection,
      timeoutMs: config.meilisearchTimeoutMs,
      autoIndex: config.meilisearchAutoIndex,
      memoryDir: config.memoryDir,
    });
  }

  if (backend === "orama") {
    const embedHelper = new EmbedHelper(config);
    return new OramaBackend({
      dbPath: config.oramaDbPath!,
      collection: config.qmdCollection,
      embedHelper,
      memoryDir: config.memoryDir,
      embeddingDimension: config.oramaEmbeddingDimension!,
    });
  }

  return undefined;
}

/** Shared QMD options derived from plugin config. */
function qmdOptions(config: PluginConfig): QmdClientOptions {
  return {
    slowLog: {
      enabled: config.slowLogEnabled,
      thresholdMs: config.slowLogThresholdMs,
    },
    updateTimeoutMs: config.qmdUpdateTimeoutMs,
    updateMinIntervalMs: config.qmdUpdateMinIntervalMs,
    qmdPath: config.qmdPath,
    daemonUrl: config.qmdDaemonEnabled ? config.qmdDaemonUrl : undefined,
    daemonRecheckIntervalMs: config.qmdDaemonRecheckIntervalMs,
  };
}

/**
 * Create a SearchBackend from plugin config.
 *
 * - "noop" → NoopSearchBackend
 * - "remote" → RemoteSearchBackend (HTTP REST)
 * - "qmd" (default) → QmdClient if qmdEnabled, else NoopSearchBackend
 */
export function createSearchBackend(config: PluginConfig): SearchBackend {
  const nonQmd = resolveNonQmdBackend(config);
  if (nonQmd) return nonQmd;

  // Default: QMD — fall back to noop if qmdEnabled is false
  if (!config.qmdEnabled) {
    return new NoopSearchBackend();
  }

  return new QmdClient(config.qmdCollection, config.qmdMaxResults, qmdOptions(config));
}

/**
 * Create a SearchBackend for conversation index use.
 * Returns undefined if conversation index is not enabled or not using qmd backend.
 */
export function createConversationSearchBackend(config: PluginConfig): SearchBackend | undefined {
  if (!config.conversationIndexEnabled || config.conversationIndexBackend !== "qmd") {
    return undefined;
  }

  const nonQmd = resolveNonQmdBackend(config);
  // Noop means search is intentionally off — return undefined so conversation init skips entirely.
  if (nonQmd instanceof NoopSearchBackend) return undefined;
  if (nonQmd) return nonQmd;

  // QMD is the only remaining option — respect qmdEnabled to avoid spawning the binary
  if (!config.qmdEnabled) return undefined;

  return new QmdClient(
    config.conversationIndexQmdCollection,
    Math.max(6, config.conversationRecallTopK),
    qmdOptions(config),
  );
}
