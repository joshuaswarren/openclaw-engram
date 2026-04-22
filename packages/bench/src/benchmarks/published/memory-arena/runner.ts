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
import { answerBenchmarkQuestion } from "../../../answering.js";
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
  llmJudgeScoreDetailed,
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

  const totalTasks = dataset.reduce(
    (sum, { tasks: domainTasks }) =>
      sum + domainTasks.reduce((tSum, task) => tSum + task.questions.length, 0),
    0,
  );

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
        const taskResultId = `${domain}-t${task.id}-q${questionIndex}`;

        try {
          await options.system.store(sessionId, [
            { role: "user", content: question },
            {
              role: "assistant",
              content: `Processing subtask ${questionIndex + 1}: ${question.slice(0, 100)}...`,
            },
          ]);

          await options.system.drain?.();

          const { result: recalledText, durationMs } = await timed(async () =>
            options.system.recall(sessionId, question),
          );
          const answered = await answerBenchmarkQuestion({
            question,
            recalledText,
            responder: options.system.responder,
          });
          const judgeResult = await llmJudgeScoreDetailed(
            options.system.judge,
            question,
            answered.finalAnswer,
            expected,
          );

          const scores: Record<string, number> = {
            f1: f1Score(answered.finalAnswer, expected),
            contains_answer: containsAnswer(answered.finalAnswer, expected),
          };
          if (judgeResult.score >= 0) {
            scores.llm_judge = judgeResult.score;
          }

          tasks.push({
            taskId: taskResultId,
            question,
            expected,
            actual: answered.finalAnswer,
            scores,
            latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
            tokens: {
              input: answered.tokens.input + judgeResult.tokens.input,
              output: answered.tokens.output + judgeResult.tokens.output,
            },
            details: {
              domain,
              taskId: task.id,
              subtaskIndex: questionIndex,
              category: task.category,
              recalledLength: recalledText.length,
              answeredLength: answered.finalAnswer.length,
              recalledText,
              answeredText: answered.finalAnswer,
              responderModel: answered.model,
              judgeModel: judgeResult.model,
            },
          });

          try {
            await options.system.store(sessionId, [
              {
                role: "assistant",
                content: `Answer for subtask ${questionIndex + 1}: ${expected}`,
              },
            ]);
          } catch (storeErr) {
            console.error(`  [WARN] memory-arena store failed for ${taskResultId}: ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`);
          }

          try {
            await options.system.drain?.();
          } catch (drainErr) {
            console.error(`  [WARN] memory-arena drain failed for ${taskResultId}: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`  [WARN] memory-arena task ${taskResultId} failed: ${message}`);
          tasks.push({
            taskId: taskResultId,
            question,
            expected,
            actual: `(error: ${message})`,
            scores: { f1: -1, contains_answer: -1, llm_judge: -1 },
            latencyMs: 0,
            tokens: { input: 0, output: 0 },
            details: { error: message },
          });
        }

        options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalTasks);
      }
    }
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const totalInputTokens = tasks.reduce((sum, task) => sum + task.tokens.input, 0);
  const totalOutputTokens = tasks.reduce((sum, task) => sum + task.tokens.output, 0);

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
      totalTokens: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
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
  const normalizedLimit = normalizeLimit(limit);
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
    let remainingLimit = normalizedLimit;
    for (const filename of domainFiles) {
      if (remainingLimit === 0) {
        break;
      }
      const raw = await readFile(path.join(datasetDir, filename), "utf8");
      const parsedTasks: ArenaTask[] = [];
      raw.split("\n").forEach((line, lineIndex) => {
        if (line.trim().length === 0) {
          return;
        }
        parsedTasks.push(parseTask(line, filename, lineIndex + 1));
      });
      const tasks = applyLimit(parsedTasks, remainingLimit);
      if (remainingLimit !== undefined) {
        remainingLimit = Math.max(0, remainingLimit - tasks.length);
      }
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

  const bundledFixture: DomainData[] = MEMORY_ARENA_SMOKE_FIXTURE.map((domain) => ({
    ...domain,
    tasks: [] as ArenaTask[],
  }));
  let remainingLimit = normalizedLimit;
  for (let index = 0; index < bundledFixture.length; index += 1) {
    const sourceDomain = MEMORY_ARENA_SMOKE_FIXTURE[index]!;
    const limitedTasks = applyLimit(sourceDomain.tasks, remainingLimit);
    bundledFixture[index] = {
      ...bundledFixture[index]!,
      tasks: limitedTasks,
    };
    if (remainingLimit !== undefined) {
      remainingLimit = Math.max(0, remainingLimit - limitedTasks.length);
    }
  }
  return ensureDatasetTasks(bundledFixture);
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `MemoryArena limit must be a non-negative integer when provided; received ${limit}.`,
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
  const category = normalizeCategory(record.category, filename);
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
    category,
    questions: record.questions as string[],
    answers: record.answers as ArenaExpectedAnswer[],
  };
}

function normalizeCategory(value: unknown, filename: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  const inferred = filename.replace(/\.jsonl$/i, "").trim();
  if (inferred.length > 0) {
    return inferred;
  }

  throw new Error(
    `MemoryArena dataset file ${filename} must include a string category or use a filename that can be inferred as the category.`,
  );
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
    return answer.every((item) => typeof item === "string" || isValidArenaAnswerObject(item));
  }
  return isValidArenaAnswerObject(answer);
}

function isValidArenaAnswerObject(answer: unknown): answer is ArenaAnswer {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return false;
  }
  const record = answer as Record<string, unknown>;
  if (
    "target_asin" in record
    && record.target_asin !== undefined
    && typeof record.target_asin !== "string"
  ) {
    return false;
  }
  if (
    "attributes" in record
    && record.attributes !== undefined
    && (!Array.isArray(record.attributes)
      || record.attributes.some((item) => typeof item !== "string"))
  ) {
    return false;
  }
  return true;
}
