/**
 * Custom benchmark runner.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunBenchmarkOptions, BenchmarkDefinition, BenchmarkResult, ResolvedRunBenchmarkOptions, TaskResult } from "../../types.js";
import { aggregateTaskScores, exactMatch, f1Score, llmJudgeScoreDetailed, rougeL, timed } from "../../scorer.js";
import { orchestrateBenchmarkRuns } from "../../benchmark.js";
import { getGitSha, getRemnicVersion } from "../../reporter.js";
import { loadCustomBenchmarkFile } from "./loader.js";
import type { CustomBenchmarkScoring, CustomBenchmarkSpec } from "./types.js";

export async function runCustomBenchmarkFile(
  filePath: string,
  options: RunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const spec = await loadCustomBenchmarkFile(filePath);
  const benchmark = createCustomBenchmarkDefinition(spec, filePath);
  return runCustomBenchmark(spec, {
    ...options,
    mode: options.mode ?? "quick",
    benchmark,
  });
}

async function runCustomBenchmark(
  spec: CustomBenchmarkSpec,
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  if (spec.scoring === "llm_judge" && !options.system.judge) {
    throw new Error(
      `Custom benchmark "${spec.name}" uses llm_judge scoring but no judge provider is configured.`,
    );
  }

  const { runCount, seeds, runs } = await orchestrateBenchmarkRuns(
    options.mode,
    async (seed, runIndex) =>
      runCustomBenchmarkRun(spec, options, seed, runIndex),
    undefined,
    options.seed,
  );
  const tasks = runs.flat();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const totalInputTokens = tasks.reduce((sum, task) => sum + task.tokens.input, 0);
  const totalOutputTokens = tasks.reduce((sum, task) => sum + task.tokens.output, 0);

  return {
    meta: {
      id: randomUUID(),
      benchmark: options.benchmark.id,
      benchmarkTier: options.benchmark.tier,
      version: options.benchmark.meta.version,
      remnicVersion: await getRemnicVersion(),
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: options.mode,
      runCount,
      seeds,
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "direct",
      remnicConfig: options.remnicConfig ?? {},
    },
    cost: {
      totalTokens: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

async function runCustomBenchmarkRun(
  benchmark: CustomBenchmarkSpec,
  options: ResolvedRunBenchmarkOptions,
  seed: number,
  runIndex: number,
): Promise<TaskResult[]> {
  const tasks = benchmark.tasks.slice(0, normalizeLimit(options.limit) ?? benchmark.tasks.length);
  if (tasks.length === 0) {
    throw new Error(
      `Custom benchmark "${benchmark.name}" is empty after applying the requested limit.`,
    );
  }

  const results: TaskResult[] = [];
  for (const [taskIndex, task] of tasks.entries()) {
    const { result: searchResults, durationMs } = await timed(async () =>
      options.system.search(task.question, 10),
    );
    const actual = searchResults.map((entry) => entry.snippet).join("\n\n");
    const scored = await scoreTask(
      benchmark.scoring,
      options,
      task.question,
      actual,
      task.expected,
    );

    results.push({
      taskId: `${slugify(benchmark.name)}-${runIndex + 1}-${taskIndex + 1}`,
      question: task.question,
      expected: task.expected,
      actual,
      scores: { [benchmark.scoring]: scored.score },
      latencyMs: durationMs + scored.judgeMetrics.latencyMs,
      tokens: scored.judgeMetrics.tokens,
      details: {
        tags: task.tags ?? [],
        searchHits: searchResults.length,
        scoring: benchmark.scoring,
        runIndex,
        seed,
        judgeModel: scored.judgeMetrics.model,
      },
    });
  }

  return results;
}

async function scoreTask(
  scoring: CustomBenchmarkScoring,
  options: ResolvedRunBenchmarkOptions,
  question: string,
  actual: string,
  expected: string,
): Promise<{
  score: number;
  judgeMetrics: {
    score: number;
    tokens: { input: number; output: number };
    latencyMs: number;
    model?: string;
  };
}> {
  switch (scoring) {
    case "exact_match":
      return {
        score: exactMatch(actual, expected),
        judgeMetrics: { score: -1, tokens: { input: 0, output: 0 }, latencyMs: 0 },
      };
    case "f1":
      return {
        score: f1Score(actual, expected),
        judgeMetrics: { score: -1, tokens: { input: 0, output: 0 }, latencyMs: 0 },
      };
    case "rouge_l":
      return {
        score: rougeL(actual, expected),
        judgeMetrics: { score: -1, tokens: { input: 0, output: 0 }, latencyMs: 0 },
      };
    case "llm_judge":
      const judgeMetrics = await llmJudgeScoreDetailed(
        options.system.judge,
        question,
        actual,
        expected,
      );
      return {
        score: judgeMetrics.score,
        judgeMetrics,
      };
    default:
      throw new Error(`Unsupported custom benchmark scoring: ${scoring as string}`);
  }
}

function createCustomBenchmarkDefinition(
  benchmark: CustomBenchmarkSpec,
  filePath: string,
): BenchmarkDefinition {
  const id = `custom:${slugify(path.basename(filePath, path.extname(filePath)) || benchmark.name)}`;
  return {
    id,
    title: benchmark.name,
    tier: "custom",
    status: "ready",
    runnerAvailable: true,
    meta: {
      name: benchmark.name,
      version: benchmark.version ?? "1.0.0",
      description: benchmark.description ?? "",
      category: benchmark.category ?? "retrieval",
      citation: benchmark.citation,
    },
  };
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `Custom benchmark limit must be a non-negative integer when provided; received ${limit}.`,
    );
  }

  return limit;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "custom-benchmark";
}
