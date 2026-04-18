import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface BenchMetricHighlight {
  name: string;
  mean: number;
}

export interface BenchResultSummary {
  id: string;
  benchmark: string;
  timestamp: string;
  mode: "quick" | "full";
  totalLatencyMs: number | null;
  meanQueryLatencyMs: number | null;
  taskCount: number;
  metricHighlights: BenchMetricHighlight[];
  filePath: string;
}

export interface BenchResultSummaryPayload {
  resultsDir: string;
  summaries: BenchResultSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeMetricHighlights(aggregates: unknown): BenchMetricHighlight[] {
  if (!isRecord(aggregates)) {
    return [];
  }

  return Object.entries(aggregates)
    .map(([name, metric]) => ({
      name,
      mean: isRecord(metric) ? toNumber(metric.mean) : null,
    }))
    .filter((metric): metric is BenchMetricHighlight => metric.mean !== null)
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 3);
}

function compareSummaries(left: BenchResultSummary, right: BenchResultSummary): number {
  if (left.timestamp === right.timestamp) {
    return left.id.localeCompare(right.id);
  }

  return right.timestamp.localeCompare(left.timestamp);
}

export function summarizeBenchmarkResult(
  result: unknown,
  filePath: string,
): BenchResultSummary | null {
  const root = isRecord(result) ? result : {};
  const meta = isRecord(root.meta) ? root.meta : {};
  const cost = isRecord(root.cost) ? root.cost : {};
  const results = isRecord(root.results) ? root.results : {};
  const tasks = Array.isArray(results.tasks) ? results.tasks : [];

  if (typeof meta.id !== "string" || typeof meta.benchmark !== "string") {
    return null;
  }

  return {
    id: meta.id,
    benchmark: meta.benchmark,
    timestamp:
      typeof meta.timestamp === "string"
        ? meta.timestamp
        : new Date(0).toISOString(),
    mode: meta.mode === "full" ? "full" : "quick",
    totalLatencyMs: toNumber(cost.totalLatencyMs),
    meanQueryLatencyMs: toNumber(cost.meanQueryLatencyMs),
    taskCount: tasks.length,
    metricHighlights: summarizeMetricHighlights(results.aggregates),
    filePath,
  };
}

export async function loadBenchResultSummaries(
  resultsDir: string,
): Promise<BenchResultSummaryPayload> {
  if (!fs.existsSync(resultsDir)) {
    return {
      resultsDir,
      summaries: [],
    };
  }

  const entries = await readdir(resultsDir, { withFileTypes: true });
  const summaries: BenchResultSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(resultsDir, entry.name);

    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const summary = summarizeBenchmarkResult(parsed, filePath);
      if (summary) {
        summaries.push(summary);
      }
    } catch {
      continue;
    }
  }

  summaries.sort(compareSummaries);

  return {
    resultsDir,
    summaries,
  };
}
