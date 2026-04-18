/**
 * MemoryArena runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  MEMORY_ARENA_SMOKE_FIXTURE,
  type ArenaAnswer,
  type ArenaExpectedAnswer,
  type ArenaTask,
  type DomainData,
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

export const memoryArenaDefinition: BenchmarkDefinition = {
  id: "memory-arena",
  title: "MemoryArena",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "memory-arena",
    version: "2.0.0",
    description:
      "Interdependent multi-session agentic memory benchmark across sequential tasks and domains.",
    category: "agentic",
    citation:
      "MemoryArena: Benchmarking Agent Memory in Interdependent Multi-Session Agentic Tasks (2025)",
  },
};

export async function runMemoryArenaBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const dataset = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];

  for (const { domain, tasks: domainTasks } of dataset) {
    for (const task of domainTasks) {
      await options.system.reset();

      const sessionId = `arena-${domain}-${task.id}`;
      for (
        let questionIndex = 0;
        questionIndex < task.questions.length;
        questionIndex += 1
      ) {
        const question = task.questions[questionIndex]!;
        const expectedAnswer = task.answers[questionIndex];
        if (expectedAnswer === undefined) {
          throw new Error(
            `MemoryArena task ${domain}:${task.id} is missing answer index ${questionIndex} for question "${question.slice(0, 120)}"`,
          );
        }

        const expected = answerToString(expectedAnswer);
        await options.system.store(sessionId, [
          { role: "user", content: question },
          {
            role: "assistant",
            content: `Processing subtask ${questionIndex + 1}: ${question.slice(0, 100)}...`,
          },
        ]);

        const { result: recalledText, durationMs } = await timed(async () =>
          options.system.recall(sessionId, question),
        );
        const judgeScore = await llmJudgeScore(
          options.system.judge,
          question,
          recalledText,
          expected,
        );

        const scores: Record<string, number> = {
          f1: f1Score(recalledText, expected),
          contains_answer: containsAnswer(recalledText, expected),
        };
        if (judgeScore >= 0) {
          scores.llm_judge = judgeScore;
        }

        tasks.push({
          taskId: `${domain}-t${task.id}-q${questionIndex}`,
          question,
          expected,
          actual: recalledText,
          scores,
          latencyMs: durationMs,
          tokens: { input: 0, output: 0 },
          details: {
            domain,
            taskId: task.id,
            subtaskIndex: questionIndex,
            category: task.category,
            recalledLength: recalledText.length,
          },
        });

        await options.system.store(sessionId, [
          {
            role: "assistant",
            content: `Answer for subtask ${questionIndex + 1}: ${expected}`,
          },
        ]);
      }
    }
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
): Promise<DomainData[]> {
  const ensureDatasetTasks = (domains: DomainData[]): DomainData[] => {
    const taskCount = domains.reduce(
      (sum, domain) => sum + domain.tasks.length,
      0,
    );
    if (taskCount === 0) {
      throw new Error(
        "MemoryArena dataset is empty after applying the requested limit.",
      );
    }
    return domains;
  };

  if (datasetDir) {
    let directoryEntries: string[];
    try {
      directoryEntries = await readdir(datasetDir);
    } catch (error) {
      throw new Error(
        `MemoryArena dataset not found under ${datasetDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const domainFiles = directoryEntries
      .filter((filename) => filename.endsWith(".jsonl"))
      .sort();
    if (domainFiles.length === 0) {
      throw new Error(
        `MemoryArena dataset not found under ${datasetDir}: no .jsonl domain files were found.`,
      );
    }

    const domains: DomainData[] = [];
    for (const filename of domainFiles) {
      const raw = await readFile(path.join(datasetDir, filename), "utf8");
      const parsedTasks: ArenaTask[] = [];
      raw.split("\n").forEach((line, lineIndex) => {
        if (line.trim().length === 0) {
          return;
        }
        parsedTasks.push(parseTask(line, filename, lineIndex + 1));
      });
      const tasks = limit ? parsedTasks.slice(0, limit) : parsedTasks;
      domains.push({
        domain: filename.replace(/\.jsonl$/, ""),
        tasks,
      });
    }

    return ensureDatasetTasks(domains);
  }

  if (mode === "full") {
    throw new Error(
      "MemoryArena full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  const bundledFixture = MEMORY_ARENA_SMOKE_FIXTURE.map((domain) => ({
    ...domain,
    tasks: limit ? domain.tasks.slice(0, limit) : [...domain.tasks],
  }));
  return ensureDatasetTasks(bundledFixture);
}

function parseTask(line: string, filename: string, lineNumber: number): ArenaTask {
  const location = `MemoryArena dataset file ${filename} line ${lineNumber}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `MemoryArena dataset file ${filename} contains invalid JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${location} must be an object.`);
  }

  const record = parsed as Record<string, unknown>;
  if (!Number.isInteger(record.id)) {
    throw new Error(`${location} must include an integer id.`);
  }
  if (typeof record.category !== "string") {
    throw new Error(`${location} must include a string category.`);
  }
  if (
    !Array.isArray(record.questions)
    || record.questions.some((question) => typeof question !== "string")
  ) {
    throw new Error(`${location} must include a questions array of strings.`);
  }
  if (
    !Array.isArray(record.answers)
    || record.answers.some(
      (answer) =>
        !isValidExpectedAnswer(answer),
    )
  ) {
    throw new Error(
      `${location} must include an answers array of strings, objects, or arrays of those values.`,
    );
  }

  return {
    id: record.id as number,
    category: record.category as string,
    questions: record.questions as string[],
    answers: record.answers as ArenaExpectedAnswer[],
  };
}

function answerToString(answer: ArenaExpectedAnswer): string {
  if (typeof answer === "string") {
    return answer;
  }
  if (Array.isArray(answer)) {
    return answer.map(answerToString).join(" | ");
  }

  const parts: string[] = [];
  if (answer.target_asin) {
    parts.push(answer.target_asin);
  }
  if (answer.attributes) {
    parts.push(answer.attributes.join(", "));
  }
  for (const [key, value] of Object.entries(answer)) {
    if (key !== "target_asin" && key !== "attributes" && value !== undefined) {
      parts.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  return parts.join(" | ");
}

function isValidExpectedAnswer(answer: unknown): answer is ArenaExpectedAnswer {
  if (typeof answer === "string") {
    return true;
  }
  if (Array.isArray(answer)) {
    return answer.every(
      (item) =>
        typeof item === "string"
        || (!!item && typeof item === "object" && !Array.isArray(item)),
    );
  }
  return !!answer && typeof answer === "object";
}
