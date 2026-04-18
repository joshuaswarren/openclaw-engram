/**
 * MemBench runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MEMBENCH_SMOKE_FIXTURE,
  type MemBenchCase,
} from "./fixture.js";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import {
  aggregateTaskScores,
  containsAnswer,
  f1Score,
  llmJudgeScore,
  timed,
} from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";

const DATASET_FILENAMES = [
  "membench.json",
  "membench.jsonl",
  "data.json",
] as const;

export const memBenchDefinition: BenchmarkDefinition = {
  id: "membench",
  title: "MemBench",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "membench",
    version: "2.0.0",
    description:
      "Factual versus reflective memory benchmark across participant and observer scenarios.",
    category: "retrieval",
    citation:
      "MemBench: Evaluating Factual and Reflective Memory in Long-Context Assistants (ACL 2025).",
  },
};

export async function runMemBenchBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const dataset = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];

  for (const testCase of dataset) {
    await options.system.reset();

    const sessionId = `membench-${testCase.id}`;
    if (testCase.turns.length > 0) {
      await options.system.store(sessionId, testCase.turns);
    }

    const { result: recalledText, durationMs } = await timed(async () =>
      options.system.recall(sessionId, testCase.question),
    );
    const judgeScore = await llmJudgeScore(
      options.system.judge,
      testCase.question,
      recalledText,
      testCase.answer,
    );

    const scores: Record<string, number> = {
      f1: f1Score(recalledText, testCase.answer),
      contains_answer: containsAnswer(recalledText, testCase.answer),
    };
    if (judgeScore >= 0) {
      scores.llm_judge = judgeScore;
    }

    tasks.push({
      taskId: testCase.id,
      question: testCase.question,
      expected: testCase.answer,
      actual: recalledText,
      scores,
      latencyMs: durationMs,
      tokens: { input: 0, output: 0 },
      details: {
        memoryType: testCase.memoryType,
        scenario: testCase.scenario,
        level: testCase.level,
        turnCount: testCase.turns.length,
        recalledLength: recalledText.length,
      },
    });
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);

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
      remnicConfig: options.remnicConfig ?? {},
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
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

async function loadDataset(
  mode: "full" | "quick",
  datasetDir: string | undefined,
  limit?: number,
): Promise<MemBenchCase[]> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetCases = (cases: MemBenchCase[]): MemBenchCase[] => {
    if (cases.length === 0) {
      throw new Error(
        "MemBench dataset is empty after applying the requested limit.",
      );
    }
    return cases;
  };

  if (datasetDir) {
    const datasetErrors: string[] = [];
    for (const filename of DATASET_FILENAMES) {
      try {
        const raw = await readFile(path.join(datasetDir, filename), "utf8");
        const parsed = filename.endsWith(".jsonl")
          ? parseJsonlDataset(raw, filename)
          : parseJsonDataset(raw, filename);
        return ensureDatasetCases(applyLimit(parsed, normalizedLimit));
      } catch (error) {
        datasetErrors.push(
          `${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new Error(
      `MemBench dataset not found under ${datasetDir}. Tried ${DATASET_FILENAMES.join(", ")}. Errors: ${datasetErrors.join(" | ")}`,
    );
  }

  if (mode === "full") {
    throw new Error(
      "MemBench full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  return ensureDatasetCases(applyLimit(MEMBENCH_SMOKE_FIXTURE, normalizedLimit));
}

function parseJsonDataset(raw: string, filename: string): MemBenchCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `MemBench dataset file ${filename} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `MemBench dataset file ${filename} must contain an array of cases.`,
    );
  }

  return parsed.map((entry, index) => parseCase(entry, `${filename}[${index}]`));
}

function parseJsonlDataset(raw: string, filename: string): MemBenchCase[] {
  const cases: MemBenchCase[] = [];
  raw.split("\n").forEach((line, lineIndex) => {
    if (line.trim().length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `MemBench dataset file ${filename} contains invalid JSON on line ${lineIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    cases.push(parseCase(parsed, `${filename}:${lineIndex + 1}`));
  });
  return cases;
}

function parseCase(entry: unknown, location: string): MemBenchCase {
  if (!isPlainObject(entry)) {
    throw new Error(`MemBench case ${location} must be an object.`);
  }

  const {
    id,
    memoryType,
    scenario,
    level,
    turns,
    question,
    answer,
  } = entry;

  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`MemBench case ${location} must include a non-empty id string.`);
  }

  if (memoryType !== "factual" && memoryType !== "reflective") {
    throw new Error(
      `MemBench case ${location} must include memoryType as "factual" or "reflective".`,
    );
  }

  if (scenario !== "participant" && scenario !== "observation") {
    throw new Error(
      `MemBench case ${location} must include scenario as "participant" or "observation".`,
    );
  }

  if (typeof level !== "string" || level.length === 0) {
    throw new Error(`MemBench case ${location} must include a non-empty level string.`);
  }

  if (typeof question !== "string" || question.length === 0) {
    throw new Error(`MemBench case ${location} must include a non-empty question string.`);
  }

  if (typeof answer !== "string" || answer.length === 0) {
    throw new Error(`MemBench case ${location} must include a non-empty answer string.`);
  }

  if (!Array.isArray(turns) || turns.length === 0) {
    throw new Error(`MemBench case ${location} must include a non-empty turns array.`);
  }

  return {
    id,
    memoryType,
    scenario,
    level,
    turns: turns.map((turn, index) => parseTurn(turn, `${location}.turns[${index}]`)),
    question,
    answer,
  };
}

function parseTurn(turn: unknown, location: string) {
  if (!isPlainObject(turn)) {
    throw new Error(`MemBench turn ${location} must be an object.`);
  }

  const { role, content } = turn;
  if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
    throw new Error(
      `MemBench turn ${location} must include role/content fields compatible with bench messages.`,
    );
  }

  return { role, content };
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `MemBench limit must be a non-negative integer when provided; received ${limit}.`,
    );
  }
  return limit;
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) {
    return [...items];
  }
  return items.slice(0, limit);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
