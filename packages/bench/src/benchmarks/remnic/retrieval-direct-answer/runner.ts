/**
 * Direct-answer latency benchmark (issue #518).
 *
 * Exercises the eligibility gate on a hand-crafted synthetic fixture
 * and reports precision (positive cases fire Tier 2), deferral recall
 * (negative cases defer to the hybrid path), and per-case latency.
 * Does not require an orchestrator or a search backend — candidates
 * are synthesized in-memory, so the bench stays deterministic and
 * fast.
 */

import { isDirectAnswerEligible, type DirectAnswerCandidate } from "@remnic/core";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  DIRECT_ANSWER_BENCH_FIXTURE,
  memoryFileFromCase,
  type DirectAnswerBenchCase,
} from "./fixture.js";

export const retrievalDirectAnswerDefinition: BenchmarkDefinition = {
  id: "retrieval-direct-answer",
  title: "Retrieval: Direct-Answer Gate",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "retrieval-direct-answer",
    version: "1.0.0",
    description:
      "Measures the direct-answer tier eligibility gate: precision on positive cases, deferral recall on negative cases, and per-case decision latency (issue #518).",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #518",
  },
};

const DEFAULT_CONFIG = {
  enabled: true,
  tokenOverlapFloor: 0.5,
  importanceFloor: 0.7,
  ambiguityMargin: 0.15,
  eligibleTaxonomyBuckets: [
    "decisions",
    "principles",
    "conventions",
    "runbooks",
    "entities",
  ],
};

function buildCandidates(benchCase: DirectAnswerBenchCase): DirectAnswerCandidate[] {
  return benchCase.candidates.map((c) => ({
    memory: memoryFileFromCase(c),
    trustZone: c.trustZone,
    taxonomyBucket: c.taxonomyBucket ?? null,
    importanceScore: c.importanceScore,
  }));
}

function scoreCase(benchCase: DirectAnswerBenchCase): { scores: Record<string, number>; actualVerdict: string; winnerId: string | null; latencyMs: number } {
  const candidates = buildCandidates(benchCase);
  const start = performance.now();
  const result = isDirectAnswerEligible({
    query: benchCase.query,
    candidates,
    config: DEFAULT_CONFIG,
    queryEntityRefs: benchCase.queryEntityRefs,
  });
  const latencyMs = performance.now() - start;
  const actualVerdict = result.eligible ? "eligible" : "defer";
  const winnerId = result.winner?.memory.frontmatter.id ?? null;

  const verdictCorrect = actualVerdict === benchCase.expected ? 1 : 0;
  const winnerCorrect =
    benchCase.expected === "eligible"
      ? winnerId === (benchCase.expectedWinnerId ?? null)
        ? 1
        : 0
      : 1; // non-eligible cases have no winner to check

  return {
    scores: {
      verdict_correct: verdictCorrect,
      winner_correct: winnerCorrect,
      latency_under_5ms: latencyMs < 5 ? 1 : 0,
    },
    actualVerdict,
    winnerId,
    latencyMs,
  };
}

export async function runRetrievalDirectAnswerBenchmark(
  _options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const tasks: TaskResult[] = [];
  const latencies: number[] = [];

  for (const benchCase of DIRECT_ANSWER_BENCH_FIXTURE) {
    const { scores, actualVerdict, winnerId, latencyMs } = scoreCase(benchCase);
    latencies.push(latencyMs);
    tasks.push({
      taskId: benchCase.id,
      question: benchCase.query,
      expected:
        benchCase.expected === "eligible"
          ? `eligible:${benchCase.expectedWinnerId ?? ""}`
          : "defer",
      actual: actualVerdict === "eligible" ? `eligible:${winnerId ?? ""}` : "defer",
      scores,
      latencyMs: Math.round(latencyMs * 100) / 100,
      tokens: { input: 0, output: 0 },
      details: {
        caseId: benchCase.id,
        candidateCount: benchCase.candidates.length,
      },
    });
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;

  const aggregated = aggregateTaskScores(tasks);

  return {
    runId: `retrieval-direct-answer-${Date.now()}`,
    benchmarkId: retrievalDirectAnswerDefinition.id,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    gitSha: await getGitSha(),
    remnicVersion: await getRemnicVersion(),
    mode: _options.mode,
    tasks,
    results: {
      summary: {
        taskCount: tasks.length,
        correctVerdicts: tasks.filter((t) => t.scores.verdict_correct === 1).length,
        correctWinners: tasks.filter((t) => t.scores.winner_correct === 1).length,
      },
      aggregates: {
        ...aggregated,
        latency_p50_ms: Math.round(p50 * 100) / 100,
        latency_p95_ms: Math.round(p95 * 100) / 100,
      },
    },
  };
}
