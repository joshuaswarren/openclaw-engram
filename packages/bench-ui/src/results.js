import fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeMetricHighlights(aggregates) {
  if (!isRecord(aggregates)) {
    return [];
  }

  return Object.entries(aggregates)
    .map(([name, metric]) => ({
      name,
      mean: isRecord(metric) ? toNumber(metric.mean) : null,
    }))
    .filter((metric) => metric.mean !== null)
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 3);
}

function compareSummaries(left, right) {
  if (left.timestamp === right.timestamp) {
    return left.id.localeCompare(right.id);
  }

  return right.timestamp.localeCompare(left.timestamp);
}

export function summarizeBenchmarkResult(result, filePath) {
  const meta = isRecord(result?.meta) ? result.meta : {};
  const cost = isRecord(result?.cost) ? result.cost : {};
  const results = isRecord(result?.results) ? result.results : {};
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

export async function loadBenchResultSummaries(resultsDir) {
  if (!fs.existsSync(resultsDir)) {
    return {
      resultsDir,
      summaries: [],
    };
  }

  const entries = await readdir(resultsDir, { withFileTypes: true });
  const summaries = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(resultsDir, entry.name);

    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
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
