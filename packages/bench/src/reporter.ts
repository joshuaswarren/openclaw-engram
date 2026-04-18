/**
 * Result enrichment and JSON writing helpers.
 */

import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LegacyBenchmarkResult } from "./adapters/types.js";
import type { BenchmarkResult } from "./types.js";

function sanitizeFilenameSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

export async function writeBenchmarkResult(
  result: BenchmarkResult,
  outputDir: string,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const safeRemnicVersion = sanitizeFilenameSegment(result.meta.remnicVersion);
  const timestamp = result.meta.timestamp.replace(/[:.]/g, "-");
  const filePath = path.join(
    outputDir,
    `${result.meta.benchmark}-v${safeRemnicVersion}-${timestamp}.json`,
  );

  await writeFile(filePath, JSON.stringify(result, null, 2) + "\n");
  return filePath;
}

export async function getRemnicVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(
      await readFile(
        path.resolve(import.meta.dirname, "../../../package.json"),
        "utf8",
      ),
    ) as { version?: string };

    return typeof packageJson.version === "string"
      ? packageJson.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

export function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function enrichResult(result: LegacyBenchmarkResult): LegacyBenchmarkResult {
  return {
    ...result,
    engramVersion: result.engramVersion || "unknown",
    gitSha: result.gitSha || getGitSha(),
    timestamp: result.timestamp || new Date().toISOString(),
  };
}
