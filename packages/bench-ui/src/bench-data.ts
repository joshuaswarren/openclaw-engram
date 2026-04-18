import { compareMetricNames, compareStrings } from "./sort-utils";

export interface BenchMetricHighlight {
  name: string;
  mean: number;
}

export interface BenchAggregateMetric {
  name: string;
  mean: number | null;
  median: number | null;
  stdDev: number | null;
  min: number | null;
  max: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  ciLevel: number | null;
  effectSize: number | null;
  effectInterpretation: string | null;
}

export interface BenchTaskScoreEntry {
  name: string;
  value: number;
}

export interface BenchTaskSummary {
  taskId: string;
  question: string;
  expected: string;
  actual: string;
  latencyMs: number | null;
  totalTokens: number;
  primaryScore: number | null;
  scoreEntries: BenchTaskScoreEntry[];
}

export interface BenchResultSummary {
  id: string;
  benchmark: string;
  benchmarkTier: string;
  timestamp: string;
  mode: "quick" | "full";
  totalLatencyMs: number | null;
  meanQueryLatencyMs: number | null;
  taskCount: number;
  metricHighlights: BenchMetricHighlight[];
  primaryMetric: string | null;
  primaryScore: number | null;
  runCount: number;
  estimatedCostUsd: number | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  systemProvider: string;
  judgeProvider: string;
  providerKey: string;
  adapterMode: string;
  aggregateMetrics: BenchAggregateMetric[];
  taskSummaries: BenchTaskSummary[];
  filePath: string;
}

export interface BenchResultSummaryPayload {
  resultsDir: string;
  summaries: BenchResultSummary[];
}

export type TrendRange = "7d" | "30d" | "90d" | "all";

export interface BenchmarkCard {
  benchmark: string;
  latest: BenchResultSummary;
  previous: BenchResultSummary | null;
  delta: number | null;
}

export interface TrendPoint {
  runId: string;
  benchmark: string;
  label: string;
  timestamp: string;
  score: number;
}

export interface RunFilters {
  benchmark: string;
  systemProvider: string;
  judgeProvider: string;
  mode: string;
  range: TrendRange;
}

export interface CompareMetricRow {
  name: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  percentChange: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  effectSize: number | null;
  effectInterpretation: string | null;
}

export interface TaskDeltaRow {
  taskId: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  question: string;
  latencyMs: number | null;
}

export interface CompareModel {
  baseline: BenchResultSummary;
  candidate: BenchResultSummary;
  metricRows: CompareMetricRow[];
  taskRows: TaskDeltaRow[];
}

export interface HistogramBucket {
  label: string;
  count: number;
}

export interface ProviderRow {
  providerKey: string;
  systemProvider: string;
  judgeProvider: string;
  runCount: number;
  benchmarks: string[];
  averageScore: number | null;
  averageCostUsd: number | null;
  benchmarkScores: Record<string, number | null>;
}

function compareRuns(left: BenchResultSummary, right: BenchResultSummary): number {
  if (left.timestamp === right.timestamp) {
    return compareStrings(left.id, right.id);
  }

  return right.timestamp.localeCompare(left.timestamp);
}

function latestTimestamp(runs: BenchResultSummary[]): number {
  const newest = runs[0];
  return newest ? Date.parse(newest.timestamp) : 0;
}

function withinRange(timestamp: string, range: TrendRange, anchor: number): boolean {
  if (range === "all") {
    return true;
  }

  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const value = Date.parse(timestamp);
  return value >= anchor - days * 24 * 60 * 60 * 1000;
}

export function humanizeIdentifier(value: string): string {
  return value
    .split(/[-_/]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join(" ");
}

const rawCountMetrics = new Set([
  "search_hits",
]);

function isRawCountMetric(metricName?: string): boolean {
  return typeof metricName === "string" && rawCountMetrics.has(metricName);
}

export function formatMetricValue(value: number | null, metricName?: string): string {
  if (value === null) {
    return "n/a";
  }

  if (isRawCountMetric(metricName)) {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  }

  if (Math.abs(value) <= 1.25) {
    return `${(value * 100).toFixed(1)}%`;
  }

  return value.toFixed(2);
}

export function formatDelta(value: number | null): string {
  if (value === null) {
    return "No baseline";
  }

  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatMetricValue(value)}`;
}

export function formatDuration(value: number | null): string {
  if (value === null) {
    return "n/a";
  }

  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }

  return `${(value / 1000).toFixed(2)} s`;
}

export function formatCurrency(value: number | null): string {
  if (value === null) {
    return "n/a";
  }

  return `$${value.toFixed(3)}`;
}

export function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function listBenchmarks(payload: BenchResultSummaryPayload): string[] {
  return Array.from(new Set(payload.summaries.map((summary) => summary.benchmark))).sort(compareStrings);
}

export function listProviders(
  payload: BenchResultSummaryPayload,
  field: "systemProvider" | "judgeProvider",
): string[] {
  return Array.from(new Set(payload.summaries.map((summary) => summary[field]))).sort(compareStrings);
}

export function getBenchmarkCards(payload: BenchResultSummaryPayload): BenchmarkCard[] {
  const cards: BenchmarkCard[] = [];

  for (const benchmark of listBenchmarks(payload)) {
    const runs = payload.summaries
      .filter((summary) => summary.benchmark === benchmark)
      .slice()
      .sort(compareRuns);
    const latest = runs[0];
    if (!latest) {
      continue;
    }

    const previous = runs[1] ?? null;
    cards.push({
      benchmark,
      latest,
      previous,
      delta:
        latest.primaryScore !== null &&
        previous !== null &&
        previous.primaryScore !== null
          ? latest.primaryScore - previous.primaryScore
          : null,
    });
  }

  return cards.sort((left, right) => compareStrings(left.benchmark, right.benchmark));
}

export function getTrendPoints(
  payload: BenchResultSummaryPayload,
  benchmark: string,
  range: TrendRange,
): TrendPoint[] {
  const anchor = latestTimestamp(payload.summaries);
  const runs = payload.summaries
    .filter((summary) => summary.primaryScore !== null)
    .filter((summary) => benchmark === "all" || summary.benchmark === benchmark)
    .filter((summary) => withinRange(summary.timestamp, range, anchor))
    .slice()
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  return runs.map((summary) => ({
    runId: summary.id,
    benchmark: summary.benchmark,
    label: formatTimestamp(summary.timestamp),
    timestamp: summary.timestamp,
    score: summary.primaryScore ?? 0,
  }));
}

export function filterRuns(
  payload: BenchResultSummaryPayload,
  filters: RunFilters,
): BenchResultSummary[] {
  const anchor = latestTimestamp(payload.summaries);

  return payload.summaries.filter((summary) => {
    if (filters.benchmark !== "all" && summary.benchmark !== filters.benchmark) {
      return false;
    }
    if (
      filters.systemProvider !== "all" &&
      summary.systemProvider !== filters.systemProvider
    ) {
      return false;
    }
    if (filters.judgeProvider !== "all" && summary.judgeProvider !== filters.judgeProvider) {
      return false;
    }
    if (filters.mode !== "all" && summary.mode !== filters.mode) {
      return false;
    }
    if (!withinRange(summary.timestamp, filters.range, anchor)) {
      return false;
    }

    return true;
  });
}

function metricValue(summary: BenchResultSummary, name: string): BenchAggregateMetric | undefined {
  return summary.aggregateMetrics.find((metric) => metric.name === name);
}

export function buildCompareModel(
  payload: BenchResultSummaryPayload,
  baselineId: string,
  candidateId: string,
): CompareModel | null {
  const baseline = payload.summaries.find((summary) => summary.id === baselineId);
  const candidate = payload.summaries.find((summary) => summary.id === candidateId);

  if (!baseline || !candidate) {
    return null;
  }

  const metricNames = Array.from(
    new Set([
      ...baseline.aggregateMetrics.map((metric) => metric.name),
      ...candidate.aggregateMetrics.map((metric) => metric.name),
    ]),
  ).sort(compareMetricNames);

  const metricRows = metricNames.map((name) => {
    const left = metricValue(baseline, name);
    const right = metricValue(candidate, name);
    const baselineValue = left?.mean ?? null;
    const candidateValue = right?.mean ?? null;
    const delta =
      baselineValue !== null && candidateValue !== null ? candidateValue - baselineValue : null;

    return {
      name,
      baseline: baselineValue,
      candidate: candidateValue,
      delta,
      percentChange:
        delta !== null && baselineValue !== null && baselineValue !== 0
          ? (delta / baselineValue) * 100
          : null,
      ciLower: right?.ciLower ?? null,
      ciUpper: right?.ciUpper ?? null,
      effectSize: right?.effectSize ?? null,
      effectInterpretation: right?.effectInterpretation ?? null,
    };
  });

  const baselineTasks = new Map(baseline.taskSummaries.map((task) => [task.taskId, task]));
  const candidateTasks = new Map(candidate.taskSummaries.map((task) => [task.taskId, task]));
  const taskIds = Array.from(new Set([...baselineTasks.keys(), ...candidateTasks.keys()])).sort(
    compareStrings,
  );

  const taskRows = taskIds
    .map((taskId) => {
      const left = baselineTasks.get(taskId) ?? null;
      const right = candidateTasks.get(taskId) ?? null;
      const baselineValue = left?.primaryScore ?? null;
      const candidateValue = right?.primaryScore ?? null;

      return {
        taskId,
        baseline: baselineValue,
        candidate: candidateValue,
        delta:
          baselineValue !== null && candidateValue !== null
            ? candidateValue - baselineValue
            : null,
        question: right?.question || left?.question || "Task prompt unavailable",
        latencyMs: right?.latencyMs ?? left?.latencyMs ?? null,
      };
    })
    .sort((left, right) => {
      const leftDelta = left.delta ?? Number.POSITIVE_INFINITY;
      const rightDelta = right.delta ?? Number.POSITIVE_INFINITY;
      if (leftDelta === rightDelta) {
        return compareStrings(left.taskId, right.taskId);
      }
      return leftDelta - rightDelta;
    });

  return {
    baseline,
    candidate,
    metricRows,
    taskRows,
  };
}

export function buildHistogram(summary: BenchResultSummary): HistogramBucket[] {
  const buckets = [
    { label: "0-19", count: 0 },
    { label: "20-39", count: 0 },
    { label: "40-59", count: 0 },
    { label: "60-79", count: 0 },
    { label: "80-100", count: 0 },
  ];

  for (const task of summary.taskSummaries) {
    if (task.primaryScore === null) {
      continue;
    }

    const value = Math.max(0, Math.min(100, Math.round(task.primaryScore * 100)));
    const index = Math.min(Math.floor(value / 20), buckets.length - 1);
    const bucket = buckets[index];
    if (bucket) {
      bucket.count += 1;
    }
  }

  return buckets;
}

export function buildProviderRows(payload: BenchResultSummaryPayload): ProviderRow[] {
  const grouped = new Map<string, ProviderRow>();

  for (const summary of payload.summaries) {
    const existing = grouped.get(summary.providerKey);
    if (existing) {
      existing.runCount += 1;
      if (!existing.benchmarks.includes(summary.benchmark)) {
        existing.benchmarks.push(summary.benchmark);
        existing.benchmarks.sort(compareStrings);
      }
      if (!(summary.benchmark in existing.benchmarkScores)) {
        existing.benchmarkScores[summary.benchmark] = summary.primaryScore;
      }
      continue;
    }

    grouped.set(summary.providerKey, {
      providerKey: summary.providerKey,
      systemProvider: summary.systemProvider,
      judgeProvider: summary.judgeProvider,
      runCount: 1,
      benchmarks: [summary.benchmark],
      averageScore: summary.primaryScore,
      averageCostUsd: summary.estimatedCostUsd,
      benchmarkScores: { [summary.benchmark]: summary.primaryScore },
    });
  }

  return Array.from(grouped.values())
    .map((row) => {
      const scoreValues = payload.summaries
        .filter((summary) => summary.providerKey === row.providerKey)
        .map((summary) => summary.primaryScore)
        .filter((value): value is number => value !== null);
      const costValues = payload.summaries
        .filter((summary) => summary.providerKey === row.providerKey)
        .map((summary) => summary.estimatedCostUsd)
        .filter((value): value is number => value !== null);

      return {
        ...row,
        averageScore:
          scoreValues.length > 0
            ? scoreValues.reduce((sum, value) => sum + value, 0) / scoreValues.length
            : null,
        averageCostUsd:
          costValues.length > 0
            ? costValues.reduce((sum, value) => sum + value, 0) / costValues.length
            : null,
      };
    })
    .sort((left, right) => compareStrings(left.providerKey, right.providerKey));
}

export function pickDefaultCompareIds(payload: BenchResultSummaryPayload): {
  baselineId: string | null;
  candidateId: string | null;
} {
  return {
    candidateId: payload.summaries[0]?.id ?? null,
    baselineId: payload.summaries[1]?.id ?? null,
  };
}

export function benchmarkRuns(
  payload: BenchResultSummaryPayload,
  benchmark: string,
): BenchResultSummary[] {
  return payload.summaries
    .filter((summary) => summary.benchmark === benchmark)
    .slice()
    .sort(compareRuns);
}
