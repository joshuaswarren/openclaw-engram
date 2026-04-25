/**
 * Cluster causal trajectories into candidate procedure memories (issue #519).
 */

import type { PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import type { CausalTrajectoryRecord } from "../causal-trajectory.js";
import {
  readCausalTrajectoryRecords,
  filterTrajectoriesByLookbackDays,
} from "../causal-trajectory.js";
import { buildProcedurePersistBody, normalizeProcedureSteps, type ProcedureStep } from "./procedure-types.js";
import { clusterByKey } from "./reinforcement-core.js";
import { log } from "../logger.js";

/** Must match truncation on `procedure_cluster` structured attribute (dedupe + storage). */
const PROCEDURE_CLUSTER_ATTR_MAX = 500;

export interface ProcedureMiningResult {
  clustersProcessed: number;
  proceduresWritten: number;
  skippedReason?: string;
}

function clusterKey(record: CausalTrajectoryRecord): string {
  const goal = record.goal.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  const refs = [...(record.entityRefs ?? [])].map((r) => r.trim().toLowerCase()).sort();
  return `${goal}|${refs.join(",")}`;
}

function successRate(group: CausalTrajectoryRecord[]): number {
  if (group.length === 0) return 0;
  const ok = group.filter((g) => g.outcomeKind === "success" || g.outcomeKind === "partial").length;
  return ok / group.length;
}

/** Derive ordered pseudo-steps from trajectory text (v1 heuristic; no tool-call array on records). */
function pseudoStepsFromCluster(group: CausalTrajectoryRecord[]): ProcedureStep[] {
  const sentences: string[] = [];
  const pushUnique = (raw: string) => {
    const t = raw.trim();
    if (t.length < 8) return;
    if (!sentences.includes(t)) sentences.push(t);
  };
  for (const g of group) {
    const parts = [g.actionSummary, g.observationSummary, g.outcomeSummary]
      .join(" ")
      .split(/[.!?]\s+|;|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12);
    for (const p of parts) pushUnique(p);
    if (sentences.length >= 5) break;
  }
  if (sentences.length < 2 && group[0]) {
    pushUnique(`${group[0].goal.trim()} — confirm prerequisites and context.`);
    pushUnique("Execute the planned actions, then record the outcome.");
  }
  return sentences.slice(0, 6).map((intent, i) => ({
    order: i + 1,
    intent,
  }));
}

async function hasExistingClusterWrite(
  storage: StorageManager,
  cluster: string,
): Promise<boolean> {
  const clusterKey = cluster.slice(0, PROCEDURE_CLUSTER_ATTR_MAX);
  const memories = await storage.readAllMemories();
  for (const m of memories) {
    if (m.frontmatter.category !== "procedure") continue;
    const c = m.frontmatter.structuredAttributes?.procedure_cluster;
    if (c === clusterKey) return true;
  }
  return false;
}

/**
 * Mine recurring successful trajectories into `procedure` memories (pending_review
 * by default; active when auto-promotion thresholds are met).
 */
export async function runProcedureMining(options: {
  memoryDir: string;
  storage: StorageManager;
  config: PluginConfig;
}): Promise<ProcedureMiningResult> {
  const cfg = options.config.procedural;
  if (!cfg?.enabled) {
    return { clustersProcessed: 0, proceduresWritten: 0, skippedReason: "procedural_disabled" };
  }
  if (cfg.minOccurrences <= 0) {
    return { clustersProcessed: 0, proceduresWritten: 0, skippedReason: "minOccurrences_zero" };
  }

  const trajectoryDir =
    typeof options.config.causalTrajectoryStoreDir === "string" &&
    options.config.causalTrajectoryStoreDir.trim().length > 0
      ? options.config.causalTrajectoryStoreDir.trim()
      : undefined;
  const { trajectories } = await readCausalTrajectoryRecords({
    memoryDir: options.memoryDir,
    causalTrajectoryStoreDir: trajectoryDir,
  });
  const recent = filterTrajectoriesByLookbackDays(trajectories, cfg.lookbackDays);

  const clusters = clusterByKey(recent, clusterKey);

  let clustersProcessed = 0;
  let proceduresWritten = 0;

  for (const [key, group] of clusters) {
    if (group.length < cfg.minOccurrences) continue;
    const rate = successRate(group);
    if (rate < cfg.successFloor) continue;

    clustersProcessed += 1;

    if (await hasExistingClusterWrite(options.storage, key)) {
      log.debug(`procedure-miner: skip duplicate cluster key=${key.slice(0, 40)}…`);
      continue;
    }

    const steps = normalizeProcedureSteps(pseudoStepsFromCluster(group));
    if (steps.length < 2) continue;

    const title = `When you work on goals like: ${group[0].goal.trim().slice(0, 140)}`;
    const body = buildProcedurePersistBody(title, steps);

    const promote =
      cfg.autoPromoteEnabled === true && group.length >= cfg.autoPromoteOccurrences && rate >= cfg.successFloor;

    await options.storage.writeMemory("procedure", body, {
      source: "procedure-miner",
      status: promote ? "active" : "pending_review",
      tags: ["procedure-miner", "causal-trajectory"],
      structuredAttributes: {
        procedure_cluster: key.slice(0, PROCEDURE_CLUSTER_ATTR_MAX),
        trajectory_ids: group
          .map((g) => g.trajectoryId)
          .join(",")
          .slice(0, 1900),
        trajectory_count: String(group.length),
        success_rate: rate.toFixed(4),
      },
    });
    proceduresWritten += 1;
  }

  return { clustersProcessed, proceduresWritten };
}
