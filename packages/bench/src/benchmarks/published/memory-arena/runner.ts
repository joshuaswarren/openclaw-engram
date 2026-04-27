/**
 * MemoryArena runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  MEMORY_ARENA_SMOKE_FIXTURE,
  type ArenaAnswer,
  type ArenaBasePerson,
  type ArenaExpectedAnswer,
  type ArenaTask,
  type DomainData,
} from "./fixture.js";
import { answerBenchmarkQuestion } from "../../../answering.js";
import { DEFAULT_BENCH_RECALL_BUDGET_CHARS } from "../../../recall-budget.js";
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
      sum + domainTasks.reduce((tSum, task) => tSum + scoredSubtaskCount(task), 0),
    0,
  );

  for (const { domain, tasks: domainTasks } of dataset) {
    for (const task of domainTasks) {
      await options.system.reset();

      const sessionId = `arena-${domain}-${task.id}`;
      let initialSeedError: string | undefined;
      if (isGroupTravelPlannerCategory(task.category)) {
        try {
          await storeInitialTaskState(options, sessionId, task);
        } catch (seedErr) {
          initialSeedError = seedErr instanceof Error
            ? seedErr.message
            : String(seedErr);
          console.error(
            `  [WARN] memory-arena initial task state failed for ${domain}:${task.id}: ${initialSeedError}`,
          );
        }
      }
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
        const isScored = shouldScoreSubtask(task, questionIndex);

        try {
          const background = backgroundForSubtask(task, questionIndex);
          if (background) {
            await options.system.store(sessionId, [
              {
                role: "system",
                content: `MemoryArena background for subtask ${questionIndex + 1}: ${background}`,
              },
            ]);
          }

          try {
            await options.system.drain?.();
          } catch (drainErr) {
            console.error(`  [WARN] memory-arena drain failed for ${taskResultId}: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}`);
          }

          if (!isScored) {
            await storeCompletedSubtask(options, sessionId, questionIndex, question, expected);
            continue;
          }

          const { result: recalledText, durationMs } = await timed(async () =>
            options.system.recall(
              sessionId,
              question,
              DEFAULT_BENCH_RECALL_BUDGET_CHARS,
            ),
          );
          const benchmarkQuestion = formatMemoryArenaQuestion(
            task.category,
            question,
            expectedAnswer,
          );
          const answered = await answerBenchmarkQuestion({
            question: benchmarkQuestion,
            recalledText,
            responder: options.system.responder,
            answerMode: "strict",
          });
          const domainScores = scoreMemoryArenaDomainAnswer(
            task.category,
            answered.finalAnswer,
            expectedAnswer,
          );
          const judgeResult = await llmJudgeScoreDetailed(
            options.system.judge,
            question,
            answered.finalAnswer,
            expected,
          );

          const scores: Record<string, number> = {
            f1: f1Score(answered.finalAnswer, expected),
            contains_answer: containsAnswer(answered.finalAnswer, expected),
            ...domainScores,
          };
          if (judgeResult.score >= 0) {
            scores.llm_judge = judgeResult.score;
          }
          const subtaskSuccess = scoreSubtaskSuccess(scores);
          scores.process_score = subtaskSuccess;
          if (questionIndex === task.questions.length - 1) {
            scores.task_success_rate = subtaskSuccess;
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
              promptQuestion: benchmarkQuestion,
              ...(initialSeedError === undefined
                ? {}
                : { initialSeedError }),
              recalledLength: recalledText.length,
              answeredLength: answered.finalAnswer.length,
              recalledText,
              answeredText: answered.finalAnswer,
              responderModel: answered.model,
              judgeModel: judgeResult.model,
            },
          });

          try {
            await storeCompletedSubtask(options, sessionId, questionIndex, question, expected);
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
          if (!isScored) {
            continue;
          }
          tasks.push({
            taskId: taskResultId,
            question,
            expected,
            actual: `(error: ${message})`,
            scores: {
              f1: -1,
              contains_answer: -1,
              llm_judge: -1,
              ...failureMemoryArenaDomainScores(task.category, expectedAnswer),
              process_score: 0,
              ...(questionIndex === task.questions.length - 1
                ? { task_success_rate: 0 }
                : {}),
            },
            latencyMs: 0,
            tokens: { input: 0, output: 0 },
            details: {
              error: message,
              ...(initialSeedError === undefined
                ? {}
                : { initialSeedError }),
            },
          });
        }

        if (isScored) {
          options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalTasks);
        }
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
  if (
    record.backgrounds !== undefined
    && !isValidBackgrounds(record.backgrounds)
  ) {
    throw new Error(
      `${location} backgrounds must be a string or an array of strings when provided.`,
    );
  }
  if (
    record.base_person != null
    && !isValidBasePerson(record.base_person)
  ) {
    throw new Error(
      `${location} base_person must be an object with a valid daily_plans value when provided.`,
    );
  }

  return {
    id: record.id as number,
    category,
    questions: record.questions as string[],
    answers: record.answers as ArenaExpectedAnswer[],
    ...(record.backgrounds === undefined
      ? {}
      : { backgrounds: record.backgrounds as string | string[] }),
    ...(record.base_person == null
      ? {}
      : { base_person: record.base_person as ArenaBasePerson }),
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

function isValidBackgrounds(backgrounds: unknown): backgrounds is string | string[] {
  return typeof backgrounds === "string"
    || (Array.isArray(backgrounds)
      && backgrounds.every((entry) => typeof entry === "string"));
}

function isValidBasePerson(basePerson: unknown): basePerson is ArenaBasePerson {
  if (!basePerson || typeof basePerson !== "object" || Array.isArray(basePerson)) {
    return false;
  }

  const record = basePerson as Record<string, unknown>;
  return !("daily_plans" in record)
    || record.daily_plans === undefined
    || record.daily_plans === null
    || isValidExpectedAnswer(record.daily_plans);
}

function scoredSubtaskCount(task: ArenaTask): number {
  return task.questions.filter((_, index) => shouldScoreSubtask(task, index)).length;
}

function shouldScoreSubtask(task: ArenaTask, questionIndex: number): boolean {
  if (task.questions.length === 1) {
    return true;
  }
  return questionIndex > 0 || Boolean(backgroundForSubtask(task, questionIndex));
}

function backgroundForSubtask(
  task: ArenaTask,
  questionIndex: number,
): string | undefined {
  const background = task.backgrounds;
  if (typeof background === "string") {
    return background.trim().length > 0 ? background : undefined;
  }
  if (Array.isArray(background)) {
    const entry = background[questionIndex];
    return typeof entry === "string" && entry.trim().length > 0
      ? entry
      : undefined;
  }
  return undefined;
}

async function storeInitialTaskState(
  options: ResolvedRunBenchmarkOptions,
  sessionId: string,
  task: ArenaTask,
): Promise<void> {
  if (!task.base_person) {
    return;
  }

  const basePerson = task.base_person;
  const name = typeof basePerson.name === "string" ? basePerson.name : "base traveler";
  const query = typeof basePerson.query === "string" ? basePerson.query : "";
  const plan = basePerson.daily_plans == null
    ? ""
    : answerToString(basePerson.daily_plans);
  if (query.trim().length === 0 && plan.trim().length === 0) {
    return;
  }

  await options.system.store(sessionId, [
    {
      role: "user",
      content: query.trim().length > 0
        ? query
        : `MemoryArena initial state for ${name}.`,
    },
    {
      role: "assistant",
      content: [
        `MemoryArena initial finalized plan for ${name}.`,
        query.trim().length > 0 ? `Base traveler request: ${query}` : "",
        plan.trim().length > 0 ? `Environment result: ${plan}` : "",
      ].filter((part) => part.length > 0).join("\n"),
    },
  ]);

  try {
    await options.system.drain?.();
  } catch (drainErr) {
    console.error(`  [WARN] memory-arena drain failed after initial task state: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}`);
  }
}

function formatMemoryArenaQuestion(
  category: string,
  question: string,
  expectedAnswer: ArenaExpectedAnswer,
): string {
  if (!shouldUseGroupTravelPlanProtocol(category, expectedAnswer)) {
    return question;
  }

  return [
    "You are a travel planner assistant in the MemoryArena Group Travel Planning task.",
    "Use the supplied memory context containing the base traveler plan and previous travelers' finalized plans.",
    "Generate the complete finalized plan for the current traveler, not just a short answer to one constraint.",
    "Preserve the exact known flight, restaurant, attraction, and accommodation names from memory when they are required by JOIN or comparison constraints.",
    "Return all required day sections from the current traveler request and memory context.",
    "",
    "Final output format:",
    "=== Traveler Plan ===",
    "Day 1:",
    "Current City: ...",
    "Transportation: ...",
    "Breakfast: ...",
    "Attraction: ...",
    "Lunch: ...",
    "Dinner: ...",
    "Accommodation: ...",
    "",
    "Current traveler request:",
    question,
  ].join("\n");
}

function scoreMemoryArenaDomainAnswer(
  category: string,
  predicted: string,
  expectedAnswer: ArenaExpectedAnswer,
): Record<string, number> {
  if (!isGroupTravelPlannerCategory(category)) {
    return {};
  }

  const expectedFields = extractPlanFieldValues(expectedAnswer);
  if (expectedFields.length === 0) {
    return {};
  }

  const hits = countNonOverlappingPlanFieldHits(predicted, expectedFields);
  const planFieldRecall = hits / expectedFields.length;

  return {
    soft_process_score: hits === expectedFields.length ? 1 : 0,
    plan_field_recall: planFieldRecall,
  };
}

function failureMemoryArenaDomainScores(
  category: string,
  expectedAnswer: ArenaExpectedAnswer,
): Record<string, number> {
  if (
    !isGroupTravelPlannerCategory(category)
    || extractPlanFieldValues(expectedAnswer).length === 0
  ) {
    return {};
  }
  return {
    plan_field_recall: 0,
    soft_process_score: 0,
  };
}

function isGroupTravelPlannerCategory(category: string): boolean {
  return category.trim().toLowerCase() === "group_travel_planner";
}

function shouldUseGroupTravelPlanProtocol(
  category: string,
  expectedAnswer: ArenaExpectedAnswer,
): boolean {
  return isGroupTravelPlannerCategory(category)
    && extractPlanFieldValues(expectedAnswer).length > 0;
}

interface PlanFieldExpectation {
  value: string;
  fieldKey: string;
  day?: string;
}

const PLAN_FIELD_KEYS = [
  "current_city",
  "transportation",
  "breakfast",
  "attraction",
  "lunch",
  "dinner",
  "accommodation",
] as const;

const PLAN_FIELD_LABEL_TOKEN_SEQUENCES = PLAN_FIELD_KEYS
  .map((key) => tokenizePlanText(key.replace(/_/g, " ")))
  .sort((a, b) => b.length - a.length);
const WEEKDAY_PLAN_DAY_TOKENS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const WORD_PLAN_DAY_TOKENS = new Set([
  ...WEEKDAY_PLAN_DAY_TOKENS,
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
]);

function extractPlanFieldValues(answer: ArenaExpectedAnswer): PlanFieldExpectation[] {
  const planItems = Array.isArray(answer) ? answer : [answer];
  const fields: PlanFieldExpectation[] = [];
  for (const item of planItems) {
    if (!isValidArenaAnswerObject(item)) {
      continue;
    }
    const day = typeof item.days === "string" || typeof item.days === "number"
      ? normalizePlanDayLabel(item.days)
      : undefined;
    for (const key of PLAN_FIELD_KEYS) {
      const value = item[key];
      if (typeof value === "string" && value.trim().length > 0 && value.trim() !== "-") {
        fields.push({ value: value.trim(), fieldKey: key, day });
      }
    }
  }
  return fields;
}

function normalizePlanText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlanDayLabel(value: string | number): string {
  const tokens = tokenizePlanText(String(value));
  const dayIndex = tokens.findIndex((token) => token === "day" || token === "days");
  if (dayIndex !== -1 && tokens[dayIndex + 1]) {
    return normalizePlanDayToken(tokens[dayIndex + 1]!);
  }
  if (tokens.length === 1) {
    return extractCompactPlanDayToken(tokens[0]!) ?? normalizePlanDayToken(tokens[0]!);
  }
  return tokens.join(" ");
}

function countNonOverlappingPlanFieldHits(
  predicted: string,
  expectedFields: PlanFieldExpectation[],
): number {
  const predictedTokens = tokenizePlanText(predicted);
  const expectedTokenFields = expectedFields
    .map((field, index) => ({
      index,
      tokens: tokenizePlanText(field.value),
      fieldTokens: tokenizePlanText(field.fieldKey.replace(/_/g, " ")),
      dayTokens: field.day === undefined ? [] : tokenizePlanText(field.day),
    }))
    .filter((field) => field.tokens.length > 0)
    .sort((a, b) =>
      b.tokens.length - a.tokens.length
      || a.index - b.index,
    );

  const usedTokens = Array.from({ length: predictedTokens.length }, () => false);
  let count = 0;
  for (const expectedField of expectedTokenFields) {
    const matchIndex = findPlanFieldTokenWindow(
      predictedTokens,
      expectedField,
      usedTokens,
    );
    if (matchIndex !== -1) {
      count += 1;
      for (
        let tokenIndex = matchIndex;
        tokenIndex < matchIndex + expectedField.tokens.length;
        tokenIndex += 1
      ) {
        usedTokens[tokenIndex] = true;
      }
    }
  }
  return count;
}

function findPlanFieldTokenWindow(
  predictedTokens: string[],
  expectedField: {
    tokens: string[];
    fieldTokens: string[];
    dayTokens: string[];
  },
  usedTokens: boolean[],
): number {
  for (let index = 0; index <= predictedTokens.length - expectedField.tokens.length; index += 1) {
    const valueMatches = expectedField.tokens.every(
      (token, offset) =>
        !usedTokens[index + offset]
        && predictedTokens[index + offset] === token,
    );
    if (!valueMatches) {
      continue;
    }

    const dayContext = expectedField.dayTokens.length > 0
      ? findLastDayContext(predictedTokens, index)
      : undefined;
    if (
      expectedField.dayTokens.length > 0
      && (dayContext === undefined || !dayContextMatches(dayContext, expectedField.dayTokens))
    ) {
      continue;
    }

    const contextStart = dayContext?.startIndex ?? Math.max(0, index - 32);
    if (
      expectedField.fieldTokens.length > 0
      && !tokensEqual(
        findNearestPlanFieldLabel(predictedTokens, contextStart, index) ?? [],
        expectedField.fieldTokens,
      )
    ) {
      continue;
    }
    return index;
  }
  return -1;
}

function findLastDayContext(
  tokens: string[],
  beforeIndex: number,
): PlanDayContext | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const compactDayToken = extractCompactPlanDayToken(tokens[index]!);
    if (compactDayToken !== undefined) {
      return {
        startIndex: index,
        dayTokens: [compactDayToken],
      };
    }
    const previousStandaloneDayContext = buildStandalonePlanDayContext(
      tokens,
      index - 1,
    );
    const standaloneDayContext = buildStandalonePlanDayContext(tokens, index);
    if (standaloneDayContext !== undefined) {
      return standaloneDayContext;
    }
    if (previousStandaloneDayContext !== undefined) {
      return previousStandaloneDayContext;
    }
    const precedingExplicitDayContext = extractPrecedingExplicitPlanDayContext(
      tokens,
      index,
    );
    if (precedingExplicitDayContext !== undefined) {
      return precedingExplicitDayContext;
    }
    const trailingDayContext = extractTrailingPlanDayContext(tokens, index);
    if (trailingDayContext !== undefined) {
      return trailingDayContext;
    }
    if (
      index <= beforeIndex - 2
      && (tokens[index] === "day" || tokens[index] === "days")
      && tokens[index + 1]
    ) {
      const dayToken = normalizeExplicitPlanDayToken(tokens[index + 1]!);
      if (dayToken === undefined) {
        continue;
      }
      return {
        startIndex: index,
        dayTokens: [dayToken],
      };
    }
  }
  return undefined;
}

interface PlanDayContext {
  startIndex: number;
  dayTokens: string[];
  alternateDayTokens?: string[][];
}

function dayContextMatches(
  context: PlanDayContext,
  expectedDayTokens: string[],
): boolean {
  return tokensEqual(context.dayTokens, expectedDayTokens)
    || (context.alternateDayTokens ?? []).some((tokens) =>
      tokensEqual(tokens, expectedDayTokens),
    );
}

function buildStandalonePlanDayContext(
  tokens: string[],
  index: number,
): PlanDayContext | undefined {
  const standaloneDayToken = normalizeStandalonePlanDayToken(tokens[index] ?? "");
  if (standaloneDayToken === undefined) {
    return undefined;
  }
  const precedingExplicitDayContext = extractPrecedingExplicitPlanDayContext(
    tokens,
    index,
  );
  const pairedExplicitDayContext =
    precedingExplicitDayContext?.endIndex === index - 1
      ? precedingExplicitDayContext
      : undefined;
  return {
    startIndex: pairedExplicitDayContext?.startIndex ?? index,
    dayTokens: [standaloneDayToken],
    alternateDayTokens:
      pairedExplicitDayContext === undefined
        ? undefined
        : [pairedExplicitDayContext.dayTokens],
  };
}

function findNearestPlanFieldLabel(
  tokens: string[],
  startIndex: number,
  beforeIndex: number,
): string[] | undefined {
  for (let endIndex = beforeIndex - 1; endIndex >= startIndex; endIndex -= 1) {
    for (const labelTokens of PLAN_FIELD_LABEL_TOKEN_SEQUENCES) {
      const labelStart = endIndex - labelTokens.length + 1;
      if (labelStart < startIndex) {
        continue;
      }
      if (labelTokens.every((token, offset) => tokens[labelStart + offset] === token)) {
        return labelTokens;
      }
    }
  }
  return undefined;
}

function extractCompactPlanDayToken(token: string): string | undefined {
  const match = /^days?(\d+)$/.exec(token);
  return match?.[1] === undefined
    ? undefined
    : normalizePlanDayToken(match[1]);
}

function normalizeStandalonePlanDayToken(token: string): string | undefined {
  return WEEKDAY_PLAN_DAY_TOKENS.has(token)
    ? token
    : undefined;
}

function extractTrailingPlanDayContext(
  tokens: string[],
  dayTokenIndex: number,
): { startIndex: number; dayTokens: string[] } | undefined {
  const previousToken = tokens[dayTokenIndex - 1];
  if (
    previousToken === undefined
    || (tokens[dayTokenIndex] !== "day" && tokens[dayTokenIndex] !== "days")
    || !WORD_PLAN_DAY_TOKENS.has(previousToken)
  ) {
    return undefined;
  }
  return {
    startIndex: dayTokenIndex - 1,
    dayTokens: [previousToken, normalizePlanDayToken(tokens[dayTokenIndex]!)],
  };
}

function extractPrecedingExplicitPlanDayContext(
  tokens: string[],
  beforeIndex: number,
): { startIndex: number; endIndex: number; dayTokens: string[] } | undefined {
  const searchStart = Math.max(0, beforeIndex - 4);
  for (let index = beforeIndex - 2; index >= searchStart; index -= 1) {
    if (
      (tokens[index] === "day" || tokens[index] === "days")
      && tokens[index + 1]
    ) {
      const dayToken = normalizeExplicitPlanDayToken(tokens[index + 1]!);
      if (dayToken !== undefined) {
        return {
          startIndex: index,
          endIndex: index + 1,
          dayTokens: [dayToken],
        };
      }
    }
  }
  return undefined;
}

function normalizeExplicitPlanDayToken(token: string): string | undefined {
  const normalizedToken = normalizePlanDayToken(token);
  return /^\d+$/.test(token)
    || WORD_PLAN_DAY_TOKENS.has(normalizedToken)
    ? normalizedToken
    : undefined;
}

function normalizePlanDayToken(token: string): string {
  if (/^\d+$/.test(token)) {
    return String(Number(token));
  }
  return token;
}

function tokensEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((token, index) => token === right[index]);
}

function tokenizePlanText(value: string): string[] {
  return normalizePlanText(value)
    .split(" ")
    .filter((token) => token.length > 0);
}

async function storeCompletedSubtask(
  options: ResolvedRunBenchmarkOptions,
  sessionId: string,
  questionIndex: number,
  question: string,
  expected: string,
): Promise<void> {
  await options.system.store(sessionId, [
    {
      role: "user",
      content: question,
    },
    {
      role: "assistant",
      content: [
        `MemoryArena completed subtask ${questionIndex + 1}.`,
        `Instruction: ${question}`,
        `Environment result: ${expected}`,
      ].join("\n"),
    },
  ]);
  try {
    await options.system.drain?.();
  } catch (drainErr) {
    console.error(`  [WARN] memory-arena drain failed after completed subtask ${questionIndex + 1}: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}`);
  }
}

function scoreSubtaskSuccess(scores: Record<string, number>): number {
  if (typeof scores.llm_judge === "number") {
    return scores.llm_judge >= 0.5 ? 1 : 0;
  }
  if (typeof scores.soft_process_score === "number") {
    return scores.soft_process_score >= 1 ? 1 : 0;
  }
  if (scores.contains_answer === 1) {
    return 1;
  }
  return (scores.f1 ?? 0) > 0 ? 1 : 0;
}
