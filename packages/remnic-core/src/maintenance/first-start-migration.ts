/**
 * First-start lifecycle migration (issue #686 retention-completion).
 *
 * When `lifecyclePolicyEnabled` is true but the memoryDir has never been
 * touched by the lifecycle policy (i.e. the state marker
 * `.lifecycle-init-done` does not exist), run a one-time, rate-limited
 * demotion sweep so the hot tier isn't flooded on the first real cron pass.
 *
 * Design constraints:
 *   - Capped at `FIRST_START_DEMOTION_CAP` (default 50) demotions per run
 *     so a large pre-existing corpus doesn't stall startup.
 *   - Resumable: subsequent invocations see the marker and skip.
 *   - The marker is written AFTER all mutations succeed so a crash during
 *     migration doesn't leave a false "done" marker (CLAUDE.md rule #12).
 *   - Dry-run mode reports candidates without mutating anything or writing
 *     the marker (safe to call from tests).
 */

import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import type { StorageManager } from "../storage.js";
import type { PluginConfig } from "../types.js";
import {
  decideTierTransition,
  type TierRoutingPolicy,
} from "../tier-routing.js";
import {
  applyUtilityPromotionRuntimePolicy,
  loadUtilityRuntimeValues,
} from "../utility-runtime.js";

export const FIRST_START_DEMOTION_CAP = 50;
export const LIFECYCLE_INIT_DONE_MARKER = ".lifecycle-init-done";

export interface FirstStartMigrationOptions {
  storage: StorageManager;
  config: PluginConfig;
  /** Override the per-run demotion cap (default: FIRST_START_DEMOTION_CAP). */
  demotionCap?: number;
  /** When true, report candidates but do not mutate or write the marker. */
  dryRun?: boolean;
  /** Override clock for tests. */
  now?: () => Date;
}

export interface FirstStartMigrationResult {
  skipped: boolean;
  skipReason?: string;
  dryRun: boolean;
  candidateCount: number;
  demotedCount: number;
  /** Number of individual demotion failures. When > 0, the init-done marker is
   *  NOT written so the next start can retry the failed demotions. */
  failureCount: number;
  cappedAt: number;
}

function markerPath(memoryDir: string): string {
  return path.join(memoryDir, "state", LIFECYCLE_INIT_DONE_MARKER);
}

async function markerExists(memoryDir: string): Promise<boolean> {
  try {
    await access(markerPath(memoryDir));
    return true;
  } catch {
    return false;
  }
}

async function writeMarker(memoryDir: string, now: Date): Promise<void> {
  const p = markerPath(memoryDir);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ createdAt: now.toISOString() }), "utf-8");
}

async function buildTierRoutingPolicy(config: PluginConfig): Promise<TierRoutingPolicy> {
  const basePolicy: TierRoutingPolicy = {
    enabled: config.qmdTierMigrationEnabled,
    demotionMinAgeDays: config.qmdTierDemotionMinAgeDays,
    demotionValueThreshold: config.qmdTierDemotionValueThreshold,
    promotionValueThreshold: config.qmdTierPromotionValueThreshold,
  };
  const runtime = await loadUtilityRuntimeValues({
    memoryDir: config.memoryDir,
    memoryUtilityLearningEnabled: config.memoryUtilityLearningEnabled,
    promotionByOutcomeEnabled: config.promotionByOutcomeEnabled,
  });
  return applyUtilityPromotionRuntimePolicy(basePolicy, runtime);
}

/**
 * Run the first-start migration sweep.  No-ops when:
 *   - `lifecyclePolicyEnabled` is false, or
 *   - `qmdTierMigrationEnabled` is false (no tier migration configured), or
 *   - the state marker already exists (already ran).
 *
 * Returns a structured result describing what happened.
 */
export async function runFirstStartMigration(
  options: FirstStartMigrationOptions,
): Promise<FirstStartMigrationResult> {
  const {
    storage,
    config,
    demotionCap = FIRST_START_DEMOTION_CAP,
    dryRun = false,
  } = options;
  const now = (options.now ?? (() => new Date()))();

  if (!config.lifecyclePolicyEnabled) {
    return {
      skipped: true,
      skipReason: "lifecyclePolicyEnabled is false",
      dryRun,
      candidateCount: 0,
      demotedCount: 0,
      failureCount: 0,
      cappedAt: demotionCap,
    };
  }

  if (!config.qmdTierMigrationEnabled) {
    return {
      skipped: true,
      skipReason: "qmdTierMigrationEnabled is false",
      dryRun,
      candidateCount: 0,
      demotedCount: 0,
      failureCount: 0,
      cappedAt: demotionCap,
    };
  }

  if (await markerExists(config.memoryDir)) {
    return {
      skipped: true,
      skipReason: "lifecycle-init-done marker already present",
      dryRun,
      candidateCount: 0,
      demotedCount: 0,
      failureCount: 0,
      cappedAt: demotionCap,
    };
  }

  const policy = await buildTierRoutingPolicy(config);
  const hotMemories = await storage.readAllMemories();

  // Find hot memories that should be demoted to cold
  const demotionCandidates = hotMemories.filter((m) => {
    const decision = decideTierTransition(m, "hot", policy, now);
    return decision.changed && decision.nextTier === "cold";
  });

  const candidateCount = demotionCandidates.length;
  // Apply cap
  const batch = demotionCandidates.slice(0, demotionCap);

  if (dryRun) {
    return {
      skipped: false,
      dryRun: true,
      candidateCount,
      demotedCount: 0,
      failureCount: 0,
      cappedAt: demotionCap,
    };
  }

  let demotedCount = 0;
  let failureCount = 0;
  for (const memory of batch) {
    try {
      await storage.migrateMemoryToTier(memory, "cold");
      demotedCount += 1;
    } catch {
      // Non-fatal — individual migration failures are counted but do not abort
      // the sweep. We track them so the marker is only written when ALL
      // attempted demotions succeeded (CLAUDE.md rule #12: don't write a
      // success marker after a partial failure).
      failureCount += 1;
    }
  }

  // Write marker AFTER all mutations succeed (CLAUDE.md rule #12).
  // If any demotion failed, skip the marker so the next start retries.
  if (failureCount === 0) {
    await writeMarker(config.memoryDir, now);
  }

  return {
    skipped: false,
    dryRun: false,
    candidateCount,
    demotedCount,
    failureCount,
    cappedAt: demotionCap,
  };
}
