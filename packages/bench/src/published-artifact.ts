/**
 * Public leaderboard artifact schema for the LongMemEval + LoCoMo
 * published benchmarks.
 *
 * `BenchmarkArtifact` is deliberately flatter and more opinionated than
 * the internal `BenchmarkResult`. The goal is a stable, versioned payload
 * that Remnic.ai and third-party leaderboard consumers can rely on
 * without digging into every per-task field the internal runner captures.
 *
 * One artifact is written per run to
 *   docs/benchmarks/results/<iso-date>-<benchmark>-<model>-<gitShaShort>.json
 * (gitignored during development; promoted per-release by slice 6).
 *
 * Any breaking change to the artifact shape requires a `schemaVersion`
 * bump. The companion `buildBenchmarkArtifact()` and
 * `writeBenchmarkArtifact()` functions in this file emit the current
 * version; `parseBenchmarkArtifact()` rejects unknown versions.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BenchmarkResult, TaskResult } from "./types.js";

/**
 * Current artifact schema version. Bump when the serialized shape
 * changes in a way that breaks existing leaderboard consumers.
 *
 * History:
 *   1 — initial schema (issue #566).
 */
export const BENCHMARK_ARTIFACT_SCHEMA_VERSION = 1 as const;

/** Identifier of a published-benchmark runner. */
export type PublishedBenchmarkId = "longmemeval" | "locomo";

export interface BenchmarkArtifactSystem {
  /** Short product name, e.g. "remnic". */
  name: string;
  /** Semver of `@remnic/core` at run time. */
  version: string;
  /** Short git SHA of the repository producing the artifact. */
  gitSha: string;
}

export interface BenchmarkArtifactEnvironment {
  /** Node.js version reported by `process.version` at run time. */
  node: string;
  /** `process.platform` at run time (linux/darwin/win32/...). */
  os: string;
  /** Optional CPU architecture (arm64/x64/...). */
  arch?: string;
}

export interface BenchmarkArtifactPerTaskScore {
  /** Runner-assigned task ID (stable across reruns). */
  taskId: string;
  /** Task-level scores keyed by metric name (e.g. f1, llm_judge). */
  scores: Record<string, number>;
  /** Optional task category / bucket for group-by reports. */
  category?: string;
}

export interface BenchmarkArtifact {
  /** Artifact schema version. See `BENCHMARK_ARTIFACT_SCHEMA_VERSION`. */
  schemaVersion: typeof BENCHMARK_ARTIFACT_SCHEMA_VERSION;
  /** Benchmark identifier, e.g. "longmemeval" or "locomo". */
  benchmarkId: PublishedBenchmarkId;
  /**
   * Dataset version the runner evaluated against. Free-form string so
   * runners can record the HuggingFace revision, filename, or
   * upstream dataset tag.
   */
  datasetVersion: string;
  system: BenchmarkArtifactSystem;
  /** Evaluator model ID (e.g. "gpt-4o-mini"). */
  model: string;
  /** RNG / selection seed used for this run. */
  seed: number;
  /** Aggregate metric means keyed by metric name. */
  metrics: Record<string, number>;
  /** Per-task score breakdown. Arbitrary-length; safe to truncate for public pages. */
  perTaskScores: BenchmarkArtifactPerTaskScore[];
  /** ISO-8601 timestamp of run start. */
  startedAt: string;
  /** ISO-8601 timestamp of run finish. */
  finishedAt: string;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
  env: BenchmarkArtifactEnvironment;
  /** Optional explanatory note (e.g. "--limit 100"). Never contains PII. */
  note?: string;
}

/** Input to `buildBenchmarkArtifact()` beyond what `BenchmarkResult` already carries. */
export interface BuildBenchmarkArtifactInput {
  benchmarkId: PublishedBenchmarkId;
  datasetVersion: string;
  model: string;
  seed: number;
  startedAt: string;
  finishedAt: string;
  result: BenchmarkResult;
  /** Optional category extractor for `perTaskScores[].category`. */
  categoryFor?: (task: TaskResult) => string | undefined;
  /** Optional free-form note (e.g. `"--limit 100"`). */
  note?: string;
}

/**
 * Build a `BenchmarkArtifact` from a runner's `BenchmarkResult`.
 * Aggregates metrics to their `.mean` for public consumption; preserves
 * per-task scores verbatim. The result is sort-stable: metric keys are
 * emitted in sorted order and perTaskScores preserves runner order.
 */
export function buildBenchmarkArtifact(
  input: BuildBenchmarkArtifactInput,
): BenchmarkArtifact {
  const { result } = input;
  const metrics: Record<string, number> = {};
  for (const key of Object.keys(result.results.aggregates).sort()) {
    const aggregate = result.results.aggregates[key];
    if (aggregate && Number.isFinite(aggregate.mean)) {
      metrics[key] = aggregate.mean;
    }
  }

  const perTaskScores: BenchmarkArtifactPerTaskScore[] =
    result.results.tasks.map((task) => {
      const category = input.categoryFor?.(task);
      const entry: BenchmarkArtifactPerTaskScore = {
        taskId: task.taskId,
        scores: sortObject(task.scores),
      };
      if (category !== undefined) {
        entry.category = category;
      }
      return entry;
    });

  const startedMs = Date.parse(input.startedAt);
  const finishedMs = Date.parse(input.finishedAt);
  if (!Number.isFinite(startedMs)) {
    throw new Error(
      `BuildBenchmarkArtifact: startedAt "${input.startedAt}" is not a valid ISO-8601 timestamp.`,
    );
  }
  if (!Number.isFinite(finishedMs)) {
    throw new Error(
      `BuildBenchmarkArtifact: finishedAt "${input.finishedAt}" is not a valid ISO-8601 timestamp.`,
    );
  }
  const durationMs = Math.max(0, finishedMs - startedMs);

  return {
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    benchmarkId: input.benchmarkId,
    datasetVersion: input.datasetVersion,
    system: {
      name: "remnic",
      version: result.meta.remnicVersion,
      gitSha: result.meta.gitSha,
    },
    model: input.model,
    seed: input.seed,
    metrics,
    perTaskScores,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs,
    env: {
      node: result.environment.nodeVersion,
      os: result.environment.os,
      ...(result.environment.hardware
        ? { arch: result.environment.hardware }
        : {}),
    },
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}

/**
 * Build the canonical on-disk filename for an artifact. Filename shape:
 *   <iso-date>-<benchmark>-<model>-<gitShaShort>.json
 * where iso-date is the startedAt date (YYYY-MM-DD) and gitShaShort is
 * the first 7 chars of system.gitSha (or "unknown" if absent).
 *
 * Every segment that contributes to the filename is sanitized through
 * `sanitizeSegment()` so it cannot contain `/`, `..`, NUL, or any other
 * path-separator characters — preventing a malicious artifact input
 * from directing `writeBenchmarkArtifact()` outside of `outputDir`.
 */
export function buildBenchmarkArtifactFilename(
  artifact: BenchmarkArtifact,
): string {
  const date = sanitizeSegment(artifact.startedAt.slice(0, 10));
  const sha = sanitizeSegment(
    (artifact.system.gitSha || "unknown").slice(0, 7),
  );
  const model = sanitizeSegment(artifact.model);
  const benchmark = sanitizeSegment(artifact.benchmarkId);
  return `${date}-${benchmark}-${model}-${sha}.json`;
}

/** Serialize an artifact to deterministic JSON (sorted top-level keys). */
export function serializeBenchmarkArtifact(
  artifact: BenchmarkArtifact,
): string {
  // Canonical JSON with stable key order so SHA-256 is reproducible.
  return JSON.stringify(canonicalize(artifact), null, 2) + "\n";
}

/** Compute SHA-256 of the canonical JSON serialization of the artifact. */
export function hashBenchmarkArtifact(artifact: BenchmarkArtifact): string {
  return createHash("sha256")
    .update(serializeBenchmarkArtifact(artifact))
    .digest("hex");
}

export interface WriteBenchmarkArtifactResult {
  path: string;
  filename: string;
  sha256: string;
  bytes: number;
}

/**
 * Write the artifact to `<outputDir>/<filename>` and return the resulting
 * path, filename, SHA-256 of the canonical serialization, and byte count.
 * Creates `outputDir` recursively if needed.
 *
 * Belt-and-suspenders: even though `buildBenchmarkArtifactFilename()`
 * sanitizes every segment, this function also verifies the resolved
 * target stays inside `outputDir`. Any path-traversal attempt throws
 * before the write occurs.
 */
export async function writeBenchmarkArtifact(
  artifact: BenchmarkArtifact,
  outputDir: string,
): Promise<WriteBenchmarkArtifactResult> {
  await mkdir(outputDir, { recursive: true });
  const filename = buildBenchmarkArtifactFilename(artifact);
  const body = serializeBenchmarkArtifact(artifact);
  const resolvedDir = path.resolve(outputDir);
  const abs = path.resolve(resolvedDir, filename);
  // `abs` must be a direct child of `resolvedDir`. Reject anything that
  // resolves to a parent directory, sibling, or any other location.
  const relative = path.relative(resolvedDir, abs);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error(
      `writeBenchmarkArtifact: refusing to write outside outputDir (filename="${filename}", resolved="${abs}").`,
    );
  }
  await writeFile(abs, body);
  return {
    path: abs,
    filename,
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

/**
 * Parse + validate a BenchmarkArtifact from raw JSON. Throws on version
 * mismatch, missing required fields, or structural errors. Keep this in
 * sync with the `BenchmarkArtifact` interface — every new required
 * field needs a matching check here and a `schemaVersion` bump.
 */
export function parseBenchmarkArtifact(raw: string): BenchmarkArtifact {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BenchmarkArtifact JSON must be an object at top level.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== BENCHMARK_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `BenchmarkArtifact schemaVersion ${String(record.schemaVersion)} is not supported. ` +
        `This build expects schemaVersion ${BENCHMARK_ARTIFACT_SCHEMA_VERSION}.`,
    );
  }
  if (record.benchmarkId !== "longmemeval" && record.benchmarkId !== "locomo") {
    throw new Error(
      `BenchmarkArtifact benchmarkId must be "longmemeval" or "locomo"; got ${String(record.benchmarkId)}.`,
    );
  }
  requireString(record, "datasetVersion");
  requireString(record, "model");
  requireNumber(record, "seed");
  requireString(record, "startedAt");
  requireString(record, "finishedAt");
  requireNumber(record, "durationMs");
  const system = requireObject(record, "system");
  requireString(system, "name");
  requireString(system, "version");
  requireString(system, "gitSha");
  const env = requireObject(record, "env");
  requireString(env, "node");
  requireString(env, "os");
  const metrics = requireObject(record, "metrics");
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value !== "number") {
      throw new Error(
        `BenchmarkArtifact metrics.${key} must be a number; got ${typeof value}.`,
      );
    }
  }
  const tasks = record.perTaskScores;
  if (!Array.isArray(tasks)) {
    throw new Error("BenchmarkArtifact perTaskScores must be an array.");
  }
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw new Error(`BenchmarkArtifact perTaskScores[${index}] must be an object.`);
    }
    requireString(task as Record<string, unknown>, "taskId");
    const scoreRecord = (task as Record<string, unknown>).scores;
    if (
      !scoreRecord ||
      typeof scoreRecord !== "object" ||
      Array.isArray(scoreRecord)
    ) {
      throw new Error(
        `BenchmarkArtifact perTaskScores[${index}].scores must be an object.`,
      );
    }
    for (const [scoreKey, scoreValue] of Object.entries(
      scoreRecord as Record<string, unknown>,
    )) {
      if (typeof scoreValue !== "number") {
        throw new Error(
          `BenchmarkArtifact perTaskScores[${index}].scores.${scoreKey} must be a number.`,
        );
      }
    }
  }

  return parsed as BenchmarkArtifact;
}

/** Read + parse + re-hash an artifact file. Handy for `verify-artifact` CLI. */
export async function loadBenchmarkArtifact(
  filePath: string,
): Promise<{ artifact: BenchmarkArtifact; sha256: string; bytes: number }> {
  const raw = await readFile(filePath, "utf8");
  const artifact = parseBenchmarkArtifact(raw);
  return {
    artifact,
    sha256: createHash("sha256").update(raw).digest("hex"),
    bytes: Buffer.byteLength(raw, "utf8"),
  };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function sortObject<V>(input: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const key of Object.keys(input).sort()) {
    out[key] = input[key] as V;
  }
  return out;
}

function canonicalize(value: unknown): unknown {
  // Canonical JSON: sort object keys recursively; arrays keep their order.
  // CLAUDE.md rule 38: stable hash requires stable key order.
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    // Allow only [a-z0-9._-]; replace everything else with `_`.
    .replace(/[^a-z0-9._-]+/g, "_")
    // Collapse any consecutive dots to a single `_` so path-traversal
    // tokens like `..` and `...` can never survive. A single dot is
    // still allowed for semver (e.g. `llama-3.1`) and the `.json` suffix
    // that callers append.
    .replace(/\.{2,}/g, "_")
    // Disallow leading/trailing dots (another path-traversal foothold).
    .replace(/^\.+|\.+$/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown";
}

function requireString(
  record: Record<string, unknown>,
  field: string,
): void {
  if (typeof record[field] !== "string") {
    throw new Error(`BenchmarkArtifact field "${field}" must be a string.`);
  }
}

function requireNumber(
  record: Record<string, unknown>,
  field: string,
): void {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `BenchmarkArtifact field "${field}" must be a finite number.`,
    );
  }
}

function requireObject(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = record[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`BenchmarkArtifact field "${field}" must be an object.`);
  }
  return value as Record<string, unknown>;
}
