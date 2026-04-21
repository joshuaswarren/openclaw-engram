/**
 * Contradiction-detection benchmark (issue #647).
 *
 * Pure-synthetic bench — no LLM calls.  Uses a deterministic heuristic
 * classifier to simulate the contradiction judge on the fixture pairs
 * and measures per-verdict precision, recall, and F1 against the
 * ground-truth labels.
 *
 * The heuristic is deliberately simple (token-overlap + antonym
 * detection) so that the bench measures structural correctness of
 * the pipeline wiring, not LLM quality.  A real LLM-based variant
 * can be added later as a separate bench mode.
 */

import { randomUUID } from "node:crypto";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  CONTRADICTION_DETECTION_FIXTURE,
  CONTRADICTION_DETECTION_SMOKE_FIXTURE,
  type ContradictionBenchCase,
  type ContradictionFixtureVerdict,
} from "./fixture.js";

// ── Definition ────────────────────────────────────────────────────────────────

export const contradictionDetectionDefinition: BenchmarkDefinition = {
  id: "contradiction-detection",
  title: "Contradiction Detection",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "contradiction-detection",
    version: "1.0.0",
    description:
      "Synthetic benchmark for contradiction-judge precision/recall across " +
      "four verdict classes (contradicts, duplicates, independent, needs-user). " +
      "Uses a deterministic heuristic classifier — no LLM calls.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #647.",
  },
};

// ── Verdict constants ─────────────────────────────────────────────────────────

const ALL_VERDICTS: ContradictionFixtureVerdict[] = [
  "contradicts",
  "duplicates",
  "independent",
  "needs-user",
];

// ── Deterministic heuristic judge ─────────────────────────────────────────────
//
// A simple text-based classifier that uses token overlap and keyword
// signals.  This is NOT a replacement for the real LLM judge — it
// exists so the bench can run without an LLM and measure structural
// correctness of the pipeline.

const CONTRA_SIGNALS = [
  " not ",
  " switched ",
  " deprecated ",
  " instead of ",
  " replaced ",
  " no longer ",
  " disabled by default",
  " enabled by default",
];

function heuristicVerdict(
  textA: string,
  textB: string,
): ContradictionFixtureVerdict {
  const a = textA.toLowerCase();
  const b = textB.toLowerCase();

  // Check for contradiction signals
  const aHasContra = CONTRA_SIGNALS.some((s) => a.includes(s));
  const bHasContra = CONTRA_SIGNALS.some((s) => b.includes(s));
  if (aHasContra || bHasContra) {
    // If the texts share significant token overlap, the signal
    // likely indicates a genuine contradiction.
    const overlap = tokenOverlap(a, b);
    if (overlap > 0.3) return "contradicts";
  }

  // Check for near-duplicate
  const overlap = tokenOverlap(a, b);
  if (overlap > 0.7) return "duplicates";

  // Some topic overlap but not duplicate and not contradictory
  if (overlap > 0.2) return "independent";

  // Very little overlap
  return "independent";
}

function tokenOverlap(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) {
    if (setB.has(t)) shared++;
  }
  return shared / Math.max(setA.size, setB.size);
}

// ── Per-verdict metrics ───────────────────────────────────────────────────────

interface VerdictMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

function computeVerdictMetrics(
  cases: ContradictionBenchCase[],
  predicted: ContradictionFixtureVerdict[],
  verdict: ContradictionFixtureVerdict,
): VerdictMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (let i = 0; i < cases.length; i++) {
    const expected = cases[i].expectedVerdict;
    const pred = predicted[i];
    if (expected === verdict && pred === verdict) tp++;
    else if (expected !== verdict && pred === verdict) fp++;
    else if (expected === verdict && pred !== verdict) fn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { tp, fp, fn, precision, recall, f1 };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runContradictionDetectionBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);
  const tasks: TaskResult[] = [];

  // Run heuristic on each case
  const predicted: ContradictionFixtureVerdict[] = cases.map((c) =>
    heuristicVerdict(c.textA, c.textB),
  );

  // Per-case task results
  for (let i = 0; i < cases.length; i++) {
    const sample = cases[i];
    const pred = predicted[i];
    const correct = pred === sample.expectedVerdict ? 1 : 0;

    const startedAt = performance.now();
    const latencyMs = Math.round(performance.now() - startedAt);

    tasks.push({
      taskId: sample.id,
      question: sample.title,
      expected: sample.expectedVerdict,
      actual: pred,
      scores: { accuracy: correct },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: {
        textA: sample.textA.slice(0, 120),
        textB: sample.textB.slice(0, 120),
        categoryA: sample.categoryA,
        categoryB: sample.categoryB,
      },
    });
  }

  // Per-verdict metrics
  const verdictScores: Record<string, number> = {};
  for (const v of ALL_VERDICTS) {
    const m = computeVerdictMetrics(cases, predicted, v);
    verdictScores[`precision_${v}`] = m.precision;
    verdictScores[`recall_${v}`] = m.recall;
    verdictScores[`f1_${v}`] = m.f1;
  }

  // Overall accuracy
  const correctCount = tasks.filter((t) => t.scores.accuracy === 1).length;
  verdictScores.overall_accuracy = cases.length > 0 ? correctCount / cases.length : 0;

  // Add a synthetic aggregate task so verdict-level scores appear in aggregates
  tasks.push({
    taskId: "_aggregate_verdict_metrics",
    question: "Per-verdict precision/recall/F1",
    expected: "see scores",
    actual: "see scores",
    scores: verdictScores,
    latencyMs: 0,
    tokens: { input: 0, output: 0 },
  });

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);

  return {
    meta: {
      id: randomUUID(),
      benchmark: options.benchmark.id,
      benchmarkTier: options.benchmark.tier,
      version: options.benchmark.meta.version,
      remnicVersion,
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: options.mode,
      runCount: 1,
      seeds: [options.seed ?? 0],
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "direct",
      remnicConfig: options.remnicConfig ?? {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

// ── Case loader ───────────────────────────────────────────────────────────────

function loadCases(
  mode: "quick" | "full",
  limit?: number,
): ContradictionBenchCase[] {
  const baseCases =
    mode === "quick"
      ? CONTRADICTION_DETECTION_SMOKE_FIXTURE
      : CONTRADICTION_DETECTION_FIXTURE;

  if (limit === undefined) return baseCases;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("contradiction-detection limit must be a positive integer");
  }
  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error(
      "contradiction-detection fixture is empty after applying the requested limit.",
    );
  }
  return limited;
}
