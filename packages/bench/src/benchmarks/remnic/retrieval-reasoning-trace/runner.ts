/**
 * Reasoning-trace retrieval benchmark (issue #564 PR 4).
 *
 * Feeds a synthetic fixture of 15 past memories (2 reasoning traces + 13
 * ordinary facts) into the retrieval boost helper with the flag on and
 * off, and reports:
 *
 * - `boost_recall_at_1`: on positive problem-solving cases, the reasoning
 *   trace lands at rank 1 after boost.
 * - `boost_false_positive_rate_at_1`: on negative / ordinary-lookup
 *   cases, the boost must leave rank 1 unchanged.
 * - `heuristic_classification_correct`: looksLikeProblemSolvingQuery
 *   agrees with the fixture's labeled expectation.
 * - `latency_p50_ms` / `latency_p95_ms`: pure boost-call latency.
 *
 * No orchestrator, no search backend — the bench exercises the pure
 * `applyReasoningTraceBoost` helper directly so it stays fast and
 * deterministic.
 */

import { randomUUID } from "node:crypto";
import {
  applyReasoningTraceBoost,
  isReasoningTracePath,
  looksLikeProblemSolvingQuery,
} from "@remnic/core";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  REASONING_TRACE_BENCH_FIXTURE,
  type ReasoningTraceBenchCase,
} from "./fixture.js";

export const retrievalReasoningTraceDefinition: BenchmarkDefinition = {
  id: "retrieval-reasoning-trace",
  title: "Retrieval: Reasoning-Trace Boost",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "retrieval-reasoning-trace",
    version: "1.0.0",
    description:
      "Measures the reasoning_trace recall boost: recall@1 gain on problem-solving queries, false-positive rate on ordinary lookups, heuristic classification agreement, and boost-call latency (issue #564 PR 4).",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #564",
  },
};

interface CaseOutcome {
  baselineTop: string;
  baselineTopPath: string;
  boostedTop: string;
  boostedTopPath: string;
  classifiedAsProblemSolving: boolean;
  latencyMs: number;
}

function runCase(benchCase: ReasoningTraceBenchCase): CaseOutcome {
  // Baseline: the same helper with `enabled: false`, which is a no-op but
  // goes through the same code path so latency measurement is apples to
  // apples with the boosted call below.
  const baseline = applyReasoningTraceBoost(benchCase.candidates, {
    enabled: false,
    query: benchCase.query,
  });
  const baselineTop = baseline[0]?.docid ?? "";
  const baselineTopPath = baseline[0]?.path ?? "";

  const classifiedAsProblemSolving = looksLikeProblemSolvingQuery(benchCase.query);

  const start = performance.now();
  const boosted = applyReasoningTraceBoost(benchCase.candidates, {
    enabled: true,
    query: benchCase.query,
  });
  const latencyMs = performance.now() - start;
  const boostedTop = boosted[0]?.docid ?? "";
  const boostedTopPath = boosted[0]?.path ?? "";

  return {
    baselineTop,
    baselineTopPath,
    boostedTop,
    boostedTopPath,
    classifiedAsProblemSolving,
    latencyMs,
  };
}

function scoreCase(
  benchCase: ReasoningTraceBenchCase,
  outcome: CaseOutcome,
): Record<string, number> {
  const scores: Record<string, number> = {};

  // Heuristic classification: did looksLikeProblemSolvingQuery match the
  // fixture's labeled expectation?
  scores.heuristic_classification_correct =
    outcome.classifiedAsProblemSolving === benchCase.expectedProblemSolving ? 1 : 0;

  // Sanity: baseline top matches the fixture's expected pre-boost winner.
  scores.baseline_top_matches_fixture =
    outcome.baselineTop === benchCase.expectedTopWithoutBoost ? 1 : 0;

  if (!benchCase.expectsTraceTopAfterBoost) {
    // Guard case: boost must not change rank 1.
    scores.boost_noop_preserved =
      outcome.boostedTop === outcome.baselineTop ? 1 : 0;
  } else {
    // Positive case: the top-1 memory after boost must live under
    // reasoning-traces/. We measure "any trace at rank 1" rather than a
    // specific docid because the shipped boost is uniform across the
    // category — when two traces share the boosted tier, the higher-scored
    // one naturally wins.
    scores.boost_recall_at_1 = isReasoningTracePath(outcome.boostedTopPath) ? 1 : 0;
  }

  scores.latency_under_1ms = outcome.latencyMs < 1 ? 1 : 0;
  return scores;
}

function selectCases(
  mode: "quick" | "full",
  limit?: number,
): ReasoningTraceBenchCase[] {
  const effectiveLimit =
    limit !== undefined ? limit : mode === "quick" ? 2 : undefined;
  if (effectiveLimit === undefined) {
    return REASONING_TRACE_BENCH_FIXTURE;
  }
  if (!Number.isInteger(effectiveLimit) || effectiveLimit <= 0) {
    throw new Error(
      "retrieval-reasoning-trace limit must be a positive integer",
    );
  }
  const limited = REASONING_TRACE_BENCH_FIXTURE.slice(0, effectiveLimit);
  if (limited.length === 0) {
    throw new Error(
      "retrieval-reasoning-trace fixture is empty after applying the requested limit.",
    );
  }
  return limited;
}

export async function runRetrievalReasoningTraceBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const tasks: TaskResult[] = [];
  const latencies: number[] = [];
  const cases = selectCases(options.mode, options.limit);

  for (const benchCase of cases) {
    const outcome = runCase(benchCase);
    latencies.push(outcome.latencyMs);
    const scores = scoreCase(benchCase, outcome);
    tasks.push({
      taskId: benchCase.id,
      question: benchCase.query,
      expected: benchCase.expectsTraceTopAfterBoost
        ? "top-is-reasoning-trace"
        : `top-unchanged=${benchCase.expectedTopWithoutBoost}`,
      actual: `baseline-top=${outcome.baselineTop};boosted-top=${outcome.boostedTop}`,
      scores,
      latencyMs: Math.round(outcome.latencyMs * 100) / 100,
      tokens: { input: 0, output: 0 },
      details: {
        caseId: benchCase.id,
        candidateCount: benchCase.candidates.length,
        classifiedAsProblemSolving: outcome.classifiedAsProblemSolving,
      },
    });
  }

  latencies.sort((a, b) => a - b);
  const p50Raw = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95Raw =
    latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;
  const p50 = Math.round(p50Raw * 100) / 100;
  const p95 = Math.round(p95Raw * 100) / 100;

  const aggregated = aggregateTaskScores(tasks.map((task) => task.scores));
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
      aggregates: {
        ...aggregated,
        latency_p50_ms: { mean: p50, median: p50, stdDev: 0, min: p50, max: p50 },
        latency_p95_ms: { mean: p95, median: p95, stdDev: 0, min: p95, max: p95 },
      },
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}
