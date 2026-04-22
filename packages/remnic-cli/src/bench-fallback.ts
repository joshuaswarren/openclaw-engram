import fs from "node:fs";
import path from "node:path";

import type { ParsedBenchArgs } from "./bench-args.js";

const FALLBACK_RESULTS_DIRNAME = "fallback-runs";

export function buildBenchRunnerArgs(
  parsed: ParsedBenchArgs,
  benchmarkId: string,
  outputDir?: string,
): string[] {
  const args = ["--benchmark", benchmarkId];
  if (parsed.quick) {
    args.push("--lightweight", "--limit", "1");
  }
  if (parsed.datasetDir) {
    args.push("--dataset-dir", parsed.datasetDir);
  }
  if (outputDir) {
    args.push("--output-dir", outputDir);
  }
  return args;
}

export function createFallbackBenchOutputDir(
  resultsDir: string,
  benchmarkId: string,
  pid: number,
  startedAtMs: number = Date.now(),
): string {
  return path.join(
    resultsDir,
    FALLBACK_RESULTS_DIRNAME,
    `${benchmarkId}-${startedAtMs}-${pid}`,
  );
}

export function resolveFallbackBenchResultPath(outputDir: string): string {
  const entries = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) {
    return "";
  }
  return path.join(outputDir, entries[0]);
}
