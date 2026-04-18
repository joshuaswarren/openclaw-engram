import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BenchmarkMode, BenchmarkResult } from "./types.js";

export interface StoredBenchmarkResultSummary {
  id: string;
  path: string;
  benchmark: string;
  timestamp: string;
  mode: BenchmarkMode;
}

export interface StoredBenchmarkBaseline {
  name: string;
  savedAt: string;
  result: BenchmarkResult;
  source?: {
    id: string;
    path: string;
  };
}

export interface StoredBenchmarkBaselineSummary {
  name: string;
  path: string;
  benchmark: string;
  timestamp: string;
  resultId: string;
  resultTimestamp: string;
  mode: BenchmarkMode;
}

export type BenchmarkExportFormat = "json" | "csv";

const BASELINE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function defaultBenchmarkBaselineDir(): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(homeDir, ".remnic", "bench", "baselines");
}

function compareResultSummaries(
  left: StoredBenchmarkResultSummary,
  right: StoredBenchmarkResultSummary,
): number {
  if (left.timestamp === right.timestamp) {
    return left.id.localeCompare(right.id);
  }
  return right.timestamp.localeCompare(left.timestamp);
}

function compareBaselineSummaries(
  left: StoredBenchmarkBaselineSummary,
  right: StoredBenchmarkBaselineSummary,
): number {
  if (left.timestamp === right.timestamp) {
    return left.name.localeCompare(right.name);
  }
  return right.timestamp.localeCompare(left.timestamp);
}

function isBenchmarkMode(value: unknown): value is BenchmarkMode {
  return value === "quick" || value === "full";
}

function isBenchmarkResult(value: unknown): value is BenchmarkResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const meta = (value as { meta?: Record<string, unknown> }).meta;
  if (!meta || typeof meta !== "object") {
    return false;
  }

  return (
    typeof meta.id === "string" &&
    typeof meta.benchmark === "string" &&
    typeof meta.timestamp === "string" &&
    isBenchmarkMode(meta.mode) &&
    typeof (value as { config?: unknown }).config === "object" &&
    (value as { config?: unknown }).config !== null &&
    typeof (value as { cost?: unknown }).cost === "object" &&
    (value as { cost?: unknown }).cost !== null &&
    typeof (value as { environment?: unknown }).environment === "object" &&
    (value as { environment?: unknown }).environment !== null &&
    typeof (value as { results?: { tasks?: unknown; aggregates?: unknown } }).results === "object" &&
    (value as { results?: unknown }).results !== null &&
    Array.isArray((value as { results?: { tasks?: unknown } }).results?.tasks) &&
    typeof (value as { results?: { aggregates?: unknown } }).results?.aggregates === "object" &&
    (value as { results?: { aggregates?: unknown } }).results?.aggregates !== null
  );
}

function isStoredBenchmarkBaseline(value: unknown): value is StoredBenchmarkBaseline {
  if (!value || typeof value !== "object") {
    return false;
  }

  const baseline = value as StoredBenchmarkBaseline;
  if (
    typeof baseline.name !== "string" ||
    typeof baseline.savedAt !== "string" ||
    !isBenchmarkResult(baseline.result)
  ) {
    return false;
  }

  if (baseline.source === undefined) {
    return true;
  }

  return (
    typeof baseline.source === "object" &&
    baseline.source !== null &&
    typeof baseline.source.id === "string" &&
    typeof baseline.source.path === "string"
  );
}

function assertValidBaselineName(name: string): void {
  if (!BASELINE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid baseline name "${name}". Use only letters, numbers, "_" and "-".`,
    );
  }
}

function assertUsableBaselineDir(baselineDir: string): void {
  if (!fs.existsSync(baselineDir)) {
    return;
  }

  const stats = fs.statSync(baselineDir);
  if (!stats.isDirectory()) {
    throw new Error(
      `Invalid benchmark baseline directory: ${baselineDir} is not a directory.`,
    );
  }
}

function toSummary(
  result: BenchmarkResult,
  filePath: string,
): StoredBenchmarkResultSummary {
  return {
    id: result.meta.id,
    path: filePath,
    benchmark: result.meta.benchmark,
    timestamp: result.meta.timestamp,
    mode: result.meta.mode,
  };
}

function toBaselineSummary(
  baseline: StoredBenchmarkBaseline,
  filePath: string,
): StoredBenchmarkBaselineSummary {
  return {
    name: baseline.name,
    path: filePath,
    benchmark: baseline.result.meta.benchmark,
    timestamp: baseline.savedAt,
    resultId: baseline.result.meta.id,
    resultTimestamp: baseline.result.meta.timestamp,
    mode: baseline.result.meta.mode,
  };
}

export async function loadBenchmarkResult(filePath: string): Promise<BenchmarkResult> {
  const content = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(content);
  if (!isBenchmarkResult(parsed)) {
    throw new Error(`Invalid benchmark result file: ${filePath}`);
  }
  return parsed;
}

export async function listBenchmarkResults(
  outputDir: string,
): Promise<StoredBenchmarkResultSummary[]> {
  if (!fs.existsSync(outputDir)) {
    return [];
  }

  const entries = await readdir(outputDir, { withFileTypes: true });
  const results: StoredBenchmarkResultSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(outputDir, entry.name);
    try {
      const result = await loadBenchmarkResult(filePath);
      results.push(toSummary(result, filePath));
    } catch {
      continue;
    }
  }

  return results.sort(compareResultSummaries);
}

export async function saveBenchmarkBaseline(
  baselineDir: string,
  name: string,
  result: BenchmarkResult,
  source?: {
    id: string;
    path: string;
  },
): Promise<string> {
  assertValidBaselineName(name);
  assertUsableBaselineDir(baselineDir);
  await mkdir(baselineDir, { recursive: true });

  const filePath = path.join(baselineDir, `${name}.json`);
  const payload: StoredBenchmarkBaseline = {
    name,
    savedAt: new Date().toISOString(),
    result,
    source,
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return filePath;
}

export async function loadBenchmarkBaseline(
  filePath: string,
): Promise<StoredBenchmarkBaseline> {
  const content = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(content);
  if (!isStoredBenchmarkBaseline(parsed)) {
    throw new Error(`Invalid benchmark baseline file: ${filePath}`);
  }
  return parsed;
}

export async function listBenchmarkBaselines(
  baselineDir: string,
): Promise<StoredBenchmarkBaselineSummary[]> {
  if (!fs.existsSync(baselineDir)) {
    return [];
  }

  assertUsableBaselineDir(baselineDir);
  const entries = await readdir(baselineDir, { withFileTypes: true });
  const baselines: StoredBenchmarkBaselineSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(baselineDir, entry.name);
    try {
      const baseline = await loadBenchmarkBaseline(filePath);
      baselines.push(toBaselineSummary(baseline, filePath));
    } catch {
      continue;
    }
  }

  return baselines.sort(compareBaselineSummaries);
}

export async function resolveBenchmarkResultReference(
  outputDir: string,
  reference: string,
): Promise<StoredBenchmarkResultSummary | undefined> {
  if (fs.existsSync(reference)) {
    try {
      const result = await loadBenchmarkResult(reference);
      return toSummary(result, reference);
    } catch {
      // Fall through to id/basename matching under the results directory.
    }
  }

  const summaries = await listBenchmarkResults(outputDir);
  const exactIdMatch = summaries.find((summary) => summary.id === reference);
  if (exactIdMatch) {
    return exactIdMatch;
  }

  const basenameMatch = summaries.find(
    (summary) => path.basename(summary.path) === reference,
  );
  return basenameMatch;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll(`"`, `""`)}"`;
  }
  return text;
}

export function renderBenchmarkResultExport(
  result: BenchmarkResult,
  format: BenchmarkExportFormat,
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const rows = [
    [
      "result_id",
      "benchmark",
      "timestamp",
      "mode",
      "metric",
      "mean",
      "median",
      "std_dev",
      "min",
      "max",
    ].join(","),
  ];

  for (const metric of Object.keys(result.results.aggregates).sort()) {
    const aggregate = result.results.aggregates[metric]!;
    rows.push([
      result.meta.id,
      result.meta.benchmark,
      result.meta.timestamp,
      result.meta.mode,
      metric,
      aggregate.mean,
      aggregate.median,
      aggregate.stdDev,
      aggregate.min,
      aggregate.max,
    ].map(csvEscape).join(","));
  }

  return `${rows.join("\n")}\n`;
}
