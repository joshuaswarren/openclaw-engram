/**
 * Buffer-surprise-trigger benchmark (issue #563 PR 4).
 *
 * For each synthetic conversation in the fixture, replay every turn
 * through two `SmartBuffer` instances: one with
 * `bufferSurpriseTriggerEnabled: false` (the control) and one with it
 * `true` (the candidate). Measure, per task and in aggregate:
 *
 *   - `candidate_flush_count` / `control_flush_count` — how many times
 *     each configuration triggered an extraction.
 *   - `candidate_topic_shift_f1` / `control_topic_shift_f1` — F1 of
 *     predicted flush indices vs annotated topic-shift indices using a
 *     ±1-turn tolerance window.
 *   - `topic_shift_f1_delta` — candidate minus control; the CI delta
 *     reporter uses this as the primary movement signal.
 *
 * # Determinism and scope
 *
 * The benchmark is intentionally hermetic: it uses a deterministic
 * word-bucket embedder inside the surprise probe and never touches the
 * network, a real LLM, or QMD. That means its results are stable across
 * machines and seeds, but it CANNOT stand in for a production semantic
 * embedder. The word-bucket embedder flags nearly every English turn
 * as "surprising" relative to its neighbors because sparse content
 * words rarely repeat verbatim — so the absolute F1 numbers are lower
 * than a real embedder would produce, and the benchmark is best read
 * as a regression gate ("surprise-on keeps the additive-only invariant
 * and does not regress below the control") rather than a source of
 * truth for flipping the production default.
 *
 * Per #563's PR 4 scope, the production default stays `false` in this
 * PR. Flipping it requires a real-embedder benchmark run, which is
 * tracked as a follow-up to this PR.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { mkdir, rm } from "node:fs/promises";
import {
  SmartBuffer,
  type BufferSurpriseProbe,
  computeSurprise,
  parseConfig,
} from "@remnic/core";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  MetricAggregate,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  BUFFER_SURPRISE_TRIGGER_FIXTURE,
  BUFFER_SURPRISE_TRIGGER_SMOKE_FIXTURE,
  type BufferSurpriseTriggerCase,
} from "./fixture.js";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const bufferSurpriseTriggerDefinition: BenchmarkDefinition = {
  id: "buffer-surprise-trigger",
  title: "Buffer Surprise Trigger (D-MEM)",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "buffer-surprise-trigger",
    version: "1.0.0",
    description:
      "Deterministic A/B benchmark comparing surprise-gated flush on vs off against annotated topic-shift turns. No network, no LLM, hash-embedder probe.",
    category: "conversational",
    citation:
      "Remnic internal synthetic benchmark for issue #563 (D-MEM surprise gate)",
  },
};

// ---------------------------------------------------------------------------
// Deterministic word-bucket embedder
// ---------------------------------------------------------------------------
//
// A purely character-frequency embedder (like the one in
// `buffer-surprise.test.ts`) cannot distinguish topic shifts in English
// prose — the character distribution converges quickly. For THIS
// benchmark we want the embedder to respond to *vocabulary* differences
// so that the surprise signal corresponds to something semantically
// meaningful, while staying deterministic and free of network calls.
//
// We tokenize on non-alphanumeric boundaries, drop stopwords, and bucket
// each token with djb2 into a fixed-width vector. Each token contributes
// `1 + 0.01 * (position % 3)` so the embedder is mildly position-aware.
// The result is a standard word-bag hash embedder — enough to
// distinguish "pasta carbonara" from "Jupiter magnetic field" reliably.

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "have",
  "i",
  "if",
  "in",
  "is",
  "it",
  "not",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "which",
  "with",
  "you",
  "my",
  "your",
  "me",
  "we",
  "they",
  "he",
  "she",
  "do",
  "does",
  "did",
  "how",
  "when",
  "where",
  "why",
  "their",
  "them",
  "us",
  "our",
  "one",
  "two",
  "some",
  "any",
  "about",
  "into",
  "over",
  "out",
  "up",
  "down",
  "off",
  "just",
]);

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function wordBucketEmbedder(dim = 64) {
  return async (text: string): Promise<readonly number[]> => {
    const vec = new Array<number>(dim).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    for (let i = 0; i < tokens.length; i += 1) {
      const bucket = djb2(tokens[i]!) % dim;
      vec[bucket] = (vec[bucket] ?? 0) + 1 + (i % 3) * 0.01;
    }
    return vec;
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runBufferSurpriseTriggerBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);

  const tmpRoot = path.join(
    os.tmpdir(),
    `remnic-bench-buffer-surprise-${randomUUID()}`,
  );
  await mkdir(tmpRoot, { recursive: true });

  const tasks: TaskResult[] = [];
  const startedAt = performance.now();

  try {
    for (const caseDef of cases) {
      const control = await runSingleCase(caseDef, {
        surpriseEnabled: false,
        tmpRoot,
        label: "control",
      });
      const candidate = await runSingleCase(caseDef, {
        surpriseEnabled: true,
        tmpRoot,
        label: "candidate",
      });

      tasks.push(buildTaskResult(caseDef, control, candidate));
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const totalLatencyMs = Math.round(performance.now() - startedAt);
  const aggregates = buildAggregates(tasks);
  const remnicVersion = await getRemnicVersion();

  return {
    meta: {
      id: randomUUID(),
      benchmark: options.benchmark.id,
      benchmarkTier: options.benchmark.tier,
      version: options.benchmark.meta.version,
      remnicVersion,
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: options.mode,
      runCount: 1,
      seeds: [options.seed ?? 0],
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "direct",
      remnicConfig: {
        ...(options.remnicConfig ?? {}),
        notes:
          "Deterministic hash embedder; no network or LLM calls. See runner.ts.",
      },
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs:
        tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates,
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-case runner
// ---------------------------------------------------------------------------

interface CaseRunOutput {
  flushTurnIndices: number[];
  turnsBetweenFlushesMean: number;
}

interface RunCaseOptions {
  surpriseEnabled: boolean;
  tmpRoot: string;
  label: "control" | "candidate";
}

async function runSingleCase(
  caseDef: BufferSurpriseTriggerCase,
  options: RunCaseOptions,
): Promise<CaseRunOutput> {
  // Use a fresh on-disk buffer per case so state does not leak between
  // runs. `bufferMaxTurns` is set high (50) so the baseline count-based
  // flush does not fire within the fixture length — we want to isolate
  // the surprise signal contribution.
  const memoryDir = path.join(
    options.tmpRoot,
    `${caseDef.id}-${options.label}`,
  );
  const workspaceDir = path.join(memoryDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  const config = parseConfig({
    memoryDir,
    workspaceDir,
    openaiApiKey: "bench-test-key",
    bufferSurpriseTriggerEnabled: options.surpriseEnabled,
    // Benchmark threshold is tuned higher than the package default
    // (0.35). The word-bucket embedder produces scores in a higher
    // absolute range than a real semantic embedder; we want the gate to
    // fire only on genuine topic boundaries inside the fixture, not on
    // mundane follow-up questions. This threshold calibration is
    // specific to THIS deterministic embedder and is independent of the
    // production default.
    bufferSurpriseThreshold: 0.65,
    bufferSurpriseK: 3,
    bufferSurpriseRecentMemoryCount: 20,
    bufferMaxTurns: 50,
    bufferMaxMinutes: 60,
    triggerMode: "smart",
    // Deliberately empty — we want surprise, not signal-word matches,
    // to drive the candidate's decisions.
    highSignalPatterns: [],
  });

  const embed = wordBucketEmbedder(64);
  const probe: BufferSurpriseProbe = {
    async scoreTurn(_key, turn, recentTurns) {
      if (recentTurns.length === 0) return null;
      return computeSurprise(
        turn.content,
        recentTurns.map((t, i) => ({
          id: `t${i}`,
          content: t.content,
        })),
        { embedFn: embed, k: 3 },
      );
    },
  };

  // Minimal in-memory storage double — we do not need persistence, and
  // avoiding real `StorageManager` keeps the benchmark hermetic.
  const storage = new InMemoryBufferStorage();
  const buffer = new SmartBuffer(config, storage as any, probe);

  const flushTurnIndices: number[] = [];

  for (let i = 0; i < caseDef.turns.length; i += 1) {
    const content = caseDef.turns[i]!;
    const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
    const decision = await buffer.addTurn("bench", {
      role,
      content,
      timestamp: new Date().toISOString(),
      sessionKey: "bench",
    });
    if (decision === "extract_now" || decision === "extract_batch") {
      flushTurnIndices.push(i);
      await buffer.clearAfterExtraction("bench");
    }
  }

  const turnsBetween: number[] = [];
  let prev = -1;
  for (const idx of flushTurnIndices) {
    turnsBetween.push(idx - prev);
    prev = idx;
  }
  const mean =
    turnsBetween.length > 0
      ? turnsBetween.reduce((acc, v) => acc + v, 0) / turnsBetween.length
      : caseDef.turns.length;

  return {
    flushTurnIndices,
    turnsBetweenFlushesMean: mean,
  };
}

// ---------------------------------------------------------------------------
// Metric derivation
// ---------------------------------------------------------------------------

function buildTaskResult(
  caseDef: BufferSurpriseTriggerCase,
  control: CaseRunOutput,
  candidate: CaseRunOutput,
): TaskResult {
  const candidateF1 = topicShiftF1(
    candidate.flushTurnIndices,
    caseDef.topicShiftTurnIndices,
  );
  const controlF1 = topicShiftF1(
    control.flushTurnIndices,
    caseDef.topicShiftTurnIndices,
  );

  // `f1_delta` is the headline comparison metric for the CI delta
  // reporter. Positive → surprise on helps; zero → tie; negative → harmful.
  const f1Delta = candidateF1 - controlF1;

  return {
    taskId: caseDef.id,
    question: `Conversation with ${caseDef.topicShiftTurnIndices.length} topic shift(s) at indices [${caseDef.topicShiftTurnIndices.join(", ")}]`,
    expected: JSON.stringify(caseDef.topicShiftTurnIndices),
    actual: JSON.stringify(candidate.flushTurnIndices),
    scores: {
      candidate_topic_shift_f1: candidateF1,
      control_topic_shift_f1: controlF1,
      topic_shift_f1_delta: f1Delta,
      candidate_flush_count: candidate.flushTurnIndices.length,
      control_flush_count: control.flushTurnIndices.length,
      candidate_mean_turns_between_flushes: candidate.turnsBetweenFlushesMean,
      control_mean_turns_between_flushes: control.turnsBetweenFlushesMean,
    },
    latencyMs: 0,
    tokens: { input: 0, output: 0 },
    details: {
      candidateFlushTurnIndices: candidate.flushTurnIndices,
      controlFlushTurnIndices: control.flushTurnIndices,
      topicShiftTurnIndices: caseDef.topicShiftTurnIndices,
    },
  };
}

/**
 * Token-set F1 between predicted flush indices and annotated shift
 * indices.
 *
 * Exact-match over turn indices would be unfair — the fixture marks the
 * FIRST turn of a new topic as the shift, but the surprise gate may fire
 * on that turn or one or two turns later as buffered context accumulates.
 * We use a window-tolerant match: a predicted flush within ±1 of an
 * annotated shift counts as a true positive. This matches the
 * operational intent — "flush near the topic boundary" — not "flush on
 * the exact index".
 *
 * Edge case: if there are no annotated shifts, a prediction of no
 * flushes scores 1. Any prediction in that case is a false positive.
 */
export function topicShiftF1(
  predicted: readonly number[],
  expected: readonly number[],
  tolerance = 1,
): number {
  if (expected.length === 0 && predicted.length === 0) return 1;
  if (expected.length === 0) return 0;
  if (predicted.length === 0) return 0;

  const matchedExpected = new Set<number>();
  let truePositive = 0;
  for (const p of predicted) {
    // Find the nearest still-unmatched expected index within tolerance.
    let best: { idx: number; dist: number } | null = null;
    for (const e of expected) {
      if (matchedExpected.has(e)) continue;
      const dist = Math.abs(p - e);
      if (dist > tolerance) continue;
      if (best === null || dist < best.dist) {
        best = { idx: e, dist };
      }
    }
    if (best !== null) {
      matchedExpected.add(best.idx);
      truePositive += 1;
    }
  }
  const falsePositive = predicted.length - truePositive;
  const falseNegative = expected.length - truePositive;
  const precision =
    truePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall =
    truePositive === 0 ? 0 : truePositive / (truePositive + falseNegative);
  if (precision === 0 && recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function buildAggregates(tasks: TaskResult[]): Record<string, MetricAggregate> {
  const base = aggregateTaskScores(tasks.map((t) => t.scores));
  // aggregateTaskScores already produces mean/median/stdDev/min/max per
  // metric key — no further work needed here, but keeping the helper
  // boundary explicit so later bench features (stat tests, intervals)
  // can compose in.
  return base;
}

// ---------------------------------------------------------------------------
// In-memory storage double
// ---------------------------------------------------------------------------

/**
 * Minimal shim implementing just the subset of `StorageManager` surface
 * that `SmartBuffer` touches. Keeps the benchmark free of filesystem
 * writes (beyond the tmp dir used for config parsing) and removes all
 * flakiness from concurrent disk access.
 */
class InMemoryBufferStorage {
  private state: {
    turns: unknown[];
    lastExtractionAt: string | null;
    extractionCount: number;
  } = { turns: [], lastExtractionAt: null, extractionCount: 0 };

  async loadBuffer() {
    return structuredClone(this.state);
  }

  async saveBuffer(state: typeof this.state) {
    this.state = structuredClone(state);
  }

  async appendBufferSurpriseEvents() {
    // No-op in the benchmark — we measure flush decisions directly from
    // the `addTurn` return value, not from the telemetry ledger.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

function loadCases(
  mode: "quick" | "full",
  limit?: number,
): BufferSurpriseTriggerCase[] {
  const base =
    mode === "quick"
      ? BUFFER_SURPRISE_TRIGGER_SMOKE_FIXTURE
      : BUFFER_SURPRISE_TRIGGER_FIXTURE;
  if (limit === undefined) return base;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      "buffer-surprise-trigger limit must be a positive integer",
    );
  }
  const limited = base.slice(0, limit);
  if (limited.length === 0) {
    throw new Error(
      "buffer-surprise-trigger fixture is empty after applying the requested limit.",
    );
  }
  return limited;
}
