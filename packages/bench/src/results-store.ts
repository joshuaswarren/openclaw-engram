import { readdir, readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import type { BenchmarkMode, BenchmarkResult } from "./types.js";

export interface StoredBenchmarkResultSummary {
  id: string;
  path: string;
  benchmark: string;
  timestamp: string;
  mode: BenchmarkMode;
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
    isBenchmarkMode(meta.mode)
  );
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

export async function resolveBenchmarkResultReference(
  outputDir: string,
  reference: string,
): Promise<StoredBenchmarkResultSummary | undefined> {
  if (fs.existsSync(reference)) {
    try {
      const result = await loadBenchmarkResult(reference);
      return toSummary(result, reference);
    } catch {
      return undefined;
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
