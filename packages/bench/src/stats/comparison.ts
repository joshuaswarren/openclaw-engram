import type {
  BenchmarkResult,
  ComparisonResult,
  ComparisonMetricDelta,
} from "../types.js";
import { pairedDeltaConfidenceInterval } from "./bootstrap.js";
import { cohensD, interpretEffectSize } from "./effect-size.js";

function percentChange(candidateValue: number, baselineValue: number): number {
  if (baselineValue === 0) {
    return candidateValue === 0 ? 0 : Math.sign(candidateValue) * Infinity;
  }
  return (candidateValue - baselineValue) / baselineValue;
}

function verdictFromMetricDeltas(
  metricDeltas: Record<string, ComparisonMetricDelta>,
  threshold: number,
): ComparisonResult["verdict"] {
  let hasImprovement = false;
  let hasRegression = false;

  for (const metric of Object.values(metricDeltas)) {
    if (metric.percentChange > threshold) {
      hasImprovement = true;
    }
    if (metric.percentChange < -threshold) {
      hasRegression = true;
    }
  }

  if (hasRegression) return "regression";
  if (hasImprovement) return "improvement";
  return "pass";
}

export function compareResults(
  baseline: BenchmarkResult,
  candidate: BenchmarkResult,
  threshold = 0.05,
): ComparisonResult {
  const metricDeltas: Record<string, ComparisonMetricDelta> = {};

  for (const [metricName, aggregate] of Object.entries(candidate.results.aggregates)) {
    const baselineAggregate = baseline.results.aggregates[metricName];
    if (!baselineAggregate) {
      continue;
    }

    const baselineScores = baseline.results.tasks.map(
      (task) => task.scores[metricName] ?? 0,
    );
    const candidateScores = candidate.results.tasks.map(
      (task) => task.scores[metricName] ?? 0,
    );

    const delta = aggregate.mean - baselineAggregate.mean;
    const metricDelta: ComparisonMetricDelta = {
      baseline: baselineAggregate.mean,
      candidate: aggregate.mean,
      delta,
      percentChange: percentChange(aggregate.mean, baselineAggregate.mean),
      effectSize: {
        cohensD: 0,
        interpretation: "negligible",
      },
    };

    const effectSizeValue = cohensD(candidateScores, baselineScores);
    metricDelta.effectSize = {
      cohensD: effectSizeValue,
      interpretation: interpretEffectSize(effectSizeValue),
    };

    if (candidateScores.length === baselineScores.length && candidateScores.length > 0) {
      metricDelta.ciOnDelta = pairedDeltaConfidenceInterval(
        candidateScores,
        baselineScores,
      );
    }

    metricDeltas[metricName] = metricDelta;
  }

  return {
    benchmark: candidate.meta.benchmark,
    metricDeltas,
    verdict: verdictFromMetricDeltas(metricDeltas, threshold),
  };
}
