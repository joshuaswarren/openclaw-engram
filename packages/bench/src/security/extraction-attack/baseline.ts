/**
 * Baseline measurement runner for the ADAM memory-extraction harness.
 *
 * Produces a reproducible set of ASR numbers for every attacker tier against
 * a synthetic target that mirrors the current Remnic read-path behavior
 * (memory IDs disclosed, namespace ACL enforced on cross-namespace reads).
 *
 * This is intentionally separate from the unit tests: tests keep budgets
 * small so CI stays fast, whereas the baseline pushes the budget high enough
 * for each tier to plateau. The output feeds into
 * `docs/security/adam-baseline-2026-04.md`.
 */

import {
  OTHER_NAMESPACE_MEMORIES,
  SYNTHETIC_MEMORIES,
  createSeededRng,
  createSyntheticTarget,
  runExtractionAttack,
} from "./index.js";
import type {
  AttackerMode,
  ExtractionAttackResult,
  SeededMemory,
} from "./index.js";

export interface BaselineScenario {
  readonly name: string;
  readonly attackerMode: AttackerMode;
  readonly queryBudget: number;
  readonly seed: number;
  /** Ground truth the attacker is trying to recover. */
  readonly groundTruth: readonly SeededMemory[];
  /** Memories the target actually stores (may be a superset of groundTruth). */
  readonly targetMemories: readonly SeededMemory[];
  readonly entities?: readonly string[];
  readonly enforceNamespaceAcl?: boolean;
  readonly allowedNamespace?: string;
  readonly disclosesMemoryIds?: boolean;
  /** Attacker-held namespace. Forwarded as `attackerNamespace` to the runner. */
  readonly attackerNamespace?: string;
}

export interface BaselineRow {
  readonly scenario: string;
  readonly attackerMode: AttackerMode;
  readonly queryBudget: number;
  readonly queriesIssued: number;
  readonly asr: number;
  readonly recoveredIds: readonly string[];
  readonly missedIds: readonly string[];
  readonly durationMs: number;
}

/**
 * Scenarios used for the 2026-04 baseline. Kept deterministic via fixed seeds
 * so the document remains reproducible.
 */
export const DEFAULT_BASELINE_SCENARIOS: readonly BaselineScenario[] =
  Object.freeze([
    {
      name: "T1-zero-knowledge-no-entities",
      attackerMode: "zero-knowledge",
      queryBudget: 200,
      seed: 101,
      groundTruth: SYNTHETIC_MEMORIES,
      targetMemories: SYNTHETIC_MEMORIES,
      entities: [],
      disclosesMemoryIds: true,
    },
    {
      name: "T2-same-namespace-with-entity-sidechannel",
      attackerMode: "same-namespace",
      queryBudget: 200,
      seed: 202,
      groundTruth: SYNTHETIC_MEMORIES,
      targetMemories: SYNTHETIC_MEMORIES,
      entities: ["Alex Morgan", "Priya Shah", "Aurora", "Helios", "Acme"],
      disclosesMemoryIds: true,
    },
    {
      // Attacker holds a token for `other`, tries to leak `victim`.
      // Using a reachable attackerNamespace is deliberate: the ACL
      // must actively filter in the recall path, not merely default to
      // empty because the attacker queried a namespace that doesn't
      // exist in the fixture. Without this, a regression that disables
      // the ACL still reports ASR=0 because the query namespace has no
      // matching memories at all.
      name: "T3-cross-namespace-acl-enforced",
      attackerMode: "cross-namespace",
      attackerNamespace: "other",
      queryBudget: 200,
      seed: 303,
      groundTruth: SYNTHETIC_MEMORIES,
      targetMemories: [...SYNTHETIC_MEMORIES, ...OTHER_NAMESPACE_MEMORIES],
      entities: [],
      enforceNamespaceAcl: true,
      allowedNamespace: "other",
      disclosesMemoryIds: true,
    },
  ]);

/**
 * Executes every scenario once and returns a flat set of rows suitable for
 * rendering as a markdown table.
 */
export async function runBaseline(
  scenarios: readonly BaselineScenario[] = DEFAULT_BASELINE_SCENARIOS,
): Promise<BaselineRow[]> {
  const rows: BaselineRow[] = [];
  for (const scenario of scenarios) {
    const target = createSyntheticTarget({
      memories: scenario.targetMemories,
      entities: scenario.entities,
      enforceNamespaceAcl: scenario.enforceNamespaceAcl,
      allowedNamespace: scenario.allowedNamespace,
      disclosesMemoryIds: scenario.disclosesMemoryIds ?? true,
    });
    const result: ExtractionAttackResult = await runExtractionAttack({
      target,
      groundTruth: scenario.groundTruth,
      attackerMode: scenario.attackerMode,
      attackerNamespace: scenario.attackerNamespace,
      queryBudget: scenario.queryBudget,
      rng: createSeededRng(scenario.seed),
      captureTimeline: false,
    });
    rows.push({
      scenario: scenario.name,
      attackerMode: scenario.attackerMode,
      queryBudget: scenario.queryBudget,
      queriesIssued: result.queriesIssued,
      asr: result.asr,
      recoveredIds: result.recovered.map((r) => r.memoryId),
      missedIds: result.missed.map((m) => m.id),
      durationMs: result.durationMs,
    });
  }
  return rows;
}

/**
 * Renders a baseline run as a human-readable markdown fragment. The returned
 * string is suitable for pasting into the baseline document.
 */
export function renderBaselineMarkdown(rows: readonly BaselineRow[]): string {
  const lines: string[] = [];
  lines.push(
    "| Scenario | Attacker | Budget | Queries | ASR | Recovered | Missed |",
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    lines.push(
      `| \`${r.scenario}\` | ${r.attackerMode} | ${r.queryBudget} | ${r.queriesIssued} | ${(r.asr * 100).toFixed(1)}% | ${r.recoveredIds.length} | ${r.missedIds.length} |`,
    );
  }
  return lines.join("\n");
}
