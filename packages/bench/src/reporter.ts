/**
 * Result enrichment and JSON writing helpers.
 */

import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LegacyBenchmarkResult } from "./adapters/types.js";
import { writeLeaderboardArtifactsForResult } from "./leaderboard-export.js";
import { isSecretKey } from "./security/secret-keys.js";
import type { BenchmarkResult } from "./types.js";

const REDACTED_SECRET = "[REDACTED]";

function sanitizeFilenameSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

export function redactBenchmarkResultSecrets<T>(value: T): T {
  return redactSecrets(value) as T;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = isSecretKey(key)
      ? REDACTED_SECRET
      : redactSecrets(nestedValue);
  }
  return redacted;
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

  const resultWithArtifacts = {
    ...result,
    config: {
      ...result.config,
      benchmarkOptions: {
        ...(result.config.benchmarkOptions ?? {}),
        leaderboardArtifacts: await writeLeaderboardArtifactsForResult(
          result,
          outputDir,
        ),
      },
    },
  };

  await writeFile(filePath, JSON.stringify(redactBenchmarkResultSecrets(resultWithArtifacts), null, 2) + "\n");
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
