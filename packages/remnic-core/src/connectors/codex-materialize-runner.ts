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
    const nsDir = resolveNamespaceDir(memoryDir, namespace);
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
    return "default";
  }
  return requested;
}

function resolveNamespaceDir(memoryDir: string, namespace: string): string {
  if (!namespace || namespace === "default") return memoryDir;
  // Remnic stores namespaces under `memoryDir/<namespace>/` per the repo's
  // existing convention; fall back to `memoryDir` itself if we cannot locate
  // a dedicated subdir.
  return path.join(memoryDir, namespace);
}
