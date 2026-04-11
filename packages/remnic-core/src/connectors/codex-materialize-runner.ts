/**
 * codex-materialize-runner.ts — Thin I/O bridge for the Codex materializer.
 *
 * The pure rendering logic lives in {@link ./codex-materialize.js}. This file
 * is the place callers (consolidation hooks, CLI, session-end hook) go when
 * they want the whole "load memories from storage → render → write" flow.
 *
 * Kept deliberately small so #378 never has to reach into orchestrator.ts /
 * importance.ts — the two files Wave 1 agents are editing concurrently.
 */

import path from "node:path";
import { existsSync } from "node:fs";

import { log } from "../logger.js";
import { StorageManager } from "../storage.js";
import type { PluginConfig, MemoryFile } from "../types.js";
import {
  materializeForNamespace,
  type MaterializeResult,
  type RolloutSummaryInput,
} from "./codex-materialize.js";

/** Options accepted by the runner. */
export interface RunMaterializeOptions {
  /** Remnic config — we only read the `codexMaterialize*` fields. */
  config: PluginConfig;
  /** Namespace to materialize. Overrides the config's `codexMaterializeNamespace`. */
  namespace?: string;
  /** Override the memory directory (defaults to `config.memoryDir`). */
  memoryDir?: string;
  /** Override `<codex_home>` (useful for tests). */
  codexHome?: string;
  /** Optional pre-loaded memories (bypasses disk read — used in tests). */
  memories?: MemoryFile[];
  /** Optional rollout summaries supplied by the caller. */
  rolloutSummaries?: RolloutSummaryInput[];
  /** Current time injection for deterministic runs. */
  now?: Date;
  /** Reason string — logged for observability. */
  reason?: "consolidation" | "session_end" | "manual" | "cli";
}

/**
 * Run the Codex materialization end-to-end. Returns `null` when the feature
 * is disabled in config or when the user hasn't opted in via the sentinel.
 * Never throws for "expected" skips; only throws on schema validation or I/O
 * errors that callers actually need to surface.
 */
export async function runCodexMaterialize(
  options: RunMaterializeOptions,
): Promise<MaterializeResult | null> {
  const cfg = options.config;
  if (!cfg.codexMaterializeMemories) {
    log.debug(`[codex-materialize] skipped — codexMaterializeMemories=false`);
    return null;
  }

  // Per-trigger gate: session-end runs must honor codexMaterializeOnSessionEnd.
  // session-end.sh passes reason="session_end"; when the user has turned off the
  // session-end trigger we short-circuit here without touching disk.
  if (options.reason === "session_end" && cfg.codexMaterializeOnSessionEnd === false) {
    log.debug(
      `[codex-materialize] skipped — session-end disabled via codexMaterializeOnSessionEnd=false`,
    );
    return null;
  }

  const namespace = resolveNamespace(options.namespace, cfg);
  const memoryDir = options.memoryDir ?? cfg.memoryDir;
  if (!memoryDir) {
    log.warn(`[codex-materialize] skipped — no memoryDir available`);
    return null;
  }

  let memories: MemoryFile[];
  if (options.memories) {
    memories = options.memories;
  } else {
    const nsDir = resolveNamespaceDir(memoryDir, namespace, cfg);
    const storage = new StorageManager(nsDir);
    try {
      memories = await storage.readAllMemories();
    } catch (error) {
      log.warn(
        `[codex-materialize] skipped — failed to read memories from ${nsDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  try {
    const result = materializeForNamespace(namespace, {
      memories,
      codexHome: options.codexHome,
      maxSummaryTokens: cfg.codexMaterializeMaxSummaryTokens,
      rolloutRetentionDays: cfg.codexMaterializeRolloutRetentionDays,
      rolloutSummaries: options.rolloutSummaries,
      now: options.now,
    });
    if (options.reason) {
      log.debug(
        `[codex-materialize] ran reason=${options.reason} wrote=${result.wrote} files=${result.filesWritten.length}`,
      );
    }
    return result;
  } catch (error) {
    log.warn(
      `[codex-materialize] run failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function resolveNamespace(override: string | undefined, cfg: PluginConfig): string {
  const requested = (override ?? cfg.codexMaterializeNamespace ?? "auto").trim();
  if (requested.length === 0 || requested === "auto") {
    // When the caller asks for "auto", fall back to the configured default
    // namespace (if any) so storage-root resolution lines up with what
    // NamespaceStorageRouter would do for the same install.
    return cfg.defaultNamespace && cfg.defaultNamespace.length > 0
      ? cfg.defaultNamespace
      : "default";
  }
  return requested;
}

/**
 * Resolve the on-disk storage root for a namespace, matching
 * `NamespaceStorageRouter` in `packages/remnic-core/src/namespaces/storage.ts`.
 *
 * Contract:
 *  - When namespaces are disabled, every namespace maps to `memoryDir` itself.
 *  - When namespaces are enabled, non-default namespaces always live under
 *    `memoryDir/namespaces/<namespace>`.
 *  - The default namespace prefers `memoryDir/namespaces/<defaultNamespace>`
 *    when that directory already exists (migrated install); otherwise it
 *    falls back to the legacy `memoryDir` root so materialization does not
 *    silently switch directories out from under an existing install.
 */
function resolveNamespaceDir(
  memoryDir: string,
  namespace: string,
  cfg: PluginConfig,
): string {
  if (!cfg.namespacesEnabled) return memoryDir;

  const ns = namespace || cfg.defaultNamespace || "default";
  const namespacedRoot = path.join(memoryDir, "namespaces", ns);

  if (ns === cfg.defaultNamespace) {
    return existsSync(namespacedRoot) ? namespacedRoot : memoryDir;
  }
  return namespacedRoot;
}
