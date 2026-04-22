/**
 * MemBench runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  MEMBENCH_SMOKE_FIXTURE,
  type MemBenchCase,
} from "./fixture.js";
import { answerBenchmarkQuestion } from "../../../answering.js";
import type { Message } from "../../../adapters/types.js";
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

const DATASET_FILENAMES = [
  "membench.json",
  "membench.jsonl",
  "data.json",
] as const;

const UPSTREAM_DATASET_FILENAME_PATTERNS = [
  /^(?:First|Third)Agent(?:Data)?(?:High|Low)Level\.jsonl?$/i,
  /^(?:First|Third)Agent(?:High|Low)Level\.jsonl?$/i,
] as const;

interface MemBenchHints {
  memoryType?: MemBenchCase["memoryType"];
  scenario?: MemBenchCase["scenario"];
  level?: string;
}

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

  const totalTasks = dataset.length;

  for (const testCase of dataset) {
    try {
      await options.system.reset();

      const sessionId = `membench-${testCase.id}`;
      if (testCase.turns.length > 0) {
        await options.system.store(sessionId, testCase.turns);
      }

      await options.system.drain?.();

      const { result: recalledText, durationMs } = await timed(async () =>
        options.system.recall(sessionId, testCase.question),
      );
      const answered = await answerBenchmarkQuestion({
        question: testCase.question,
        recalledText,
        responder: options.system.responder,
      });
      const judgeResult = await llmJudgeScoreDetailed(
        options.system.judge,
        testCase.question,
        answered.finalAnswer,
        testCase.answer,
      );

      const scores: Record<string, number> = {
        f1: f1Score(answered.finalAnswer, testCase.answer),
        contains_answer: containsAnswer(answered.finalAnswer, testCase.answer),
      };
      if (judgeResult.score >= 0) {
        scores.llm_judge = judgeResult.score;
      }

      tasks.push({
        taskId: testCase.id,
        question: testCase.question,
        expected: testCase.answer,
        actual: answered.finalAnswer,
        scores,
        latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
        tokens: {
          input: answered.tokens.input + judgeResult.tokens.input,
          output: answered.tokens.output + judgeResult.tokens.output,
        },
        details: {
          memoryType: testCase.memoryType,
          scenario: testCase.scenario,
          level: testCase.level,
          turnCount: testCase.turns.length,
          recalledLength: recalledText.length,
          answeredLength: answered.finalAnswer.length,
          recalledText,
          answeredText: answered.finalAnswer,
          responderModel: answered.model,
          judgeModel: judgeResult.model,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [WARN] membench task ${testCase.id} failed: ${message}`);
      tasks.push({
        taskId: testCase.id,
        question: testCase.question,
        expected: testCase.answer,
        actual: `(error: ${message})`,
        scores: { f1: -1, contains_answer: -1, llm_judge: -1 },
        latencyMs: 0,
        tokens: { input: 0, output: 0 },
        details: { error: message },
      });
    }

    options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalTasks);
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
    const { filenames, scanError } = await discoverDatasetFiles(datasetDir);
    if (filenames.length === 0) {
      throw new Error(buildDatasetNotFoundError(datasetDir, scanError, []));
    }

    const datasetErrors: string[] = [];
    const cases: MemBenchCase[] = [];
    let remainingLimit = normalizedLimit;
    for (const filename of filenames) {
      if (remainingLimit === 0) {
        break;
      }

      try {
        const raw = await readFile(path.join(datasetDir, filename), "utf8");
        const parsed = filename.endsWith(".jsonl")
          ? parseJsonlDataset(raw, filename)
          : parseJsonDataset(raw, filename);
        const limitedCases = applyLimit(parsed, remainingLimit);
        cases.push(...limitedCases);
        if (remainingLimit !== undefined) {
          remainingLimit = Math.max(remainingLimit - limitedCases.length, 0);
        }
      } catch (error) {
        datasetErrors.push(
          `${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (cases.length > 0) {
      return ensureDatasetCases(cases);
    }

    throw new Error(buildDatasetNotFoundError(datasetDir, undefined, datasetErrors));
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
    const normalizedCases = normalizePublishedDataset(parsed, filename);
    if (normalizedCases.length > 0) {
      return normalizedCases;
    }

    throw new Error(
      `MemBench dataset file ${filename} must contain an array of cases or a nested published dataset structure.`,
    );
  }

  const normalizedCases = normalizePublishedDataset(parsed, filename);
  if (normalizedCases.length > 0) {
    return normalizedCases;
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

async function discoverDatasetFiles(
  datasetDir: string,
): Promise<{ filenames: string[]; scanError?: string }> {
  let directoryEntries: string[];
  try {
    directoryEntries = await readdir(datasetDir);
  } catch (error) {
    return {
      filenames: [],
      scanError: error instanceof Error ? error.message : String(error),
    };
  }

  const filenames = directoryEntries
    .filter((filename) => isRecognizedDatasetFilename(filename))
    .sort((left, right) => left.localeCompare(right));

  return { filenames };
}

function isRecognizedDatasetFilename(filename: string): boolean {
  if (DATASET_FILENAMES.includes(filename as (typeof DATASET_FILENAMES)[number])) {
    return true;
  }

  return UPSTREAM_DATASET_FILENAME_PATTERNS.some((pattern) => pattern.test(filename));
}

function buildDatasetNotFoundError(
  datasetDir: string,
  scanError: string | undefined,
  datasetErrors: string[],
): string {
  const tried = [
    ...DATASET_FILENAMES,
    "FirstAgentDataLowLevel.json",
    "FirstAgentDataHighLevel.json",
    "ThirdAgentDataLowLevel.json",
    "ThirdAgentDataHighLevel.json",
  ].join(", ");
  const details = [scanError, ...datasetErrors].filter(Boolean).join(" | ");
  return details.length > 0
    ? `MemBench dataset not found under ${datasetDir}. Tried ${tried}. Errors: ${details}`
    : `MemBench dataset not found under ${datasetDir}. Tried ${tried}.`;
}

function normalizePublishedDataset(
  parsed: unknown,
  filename: string,
): MemBenchCase[] {
  const hints = inferHintsFromLabel(filename, {});
  return normalizePublishedNode(parsed, hints, filename);
}

function normalizePublishedNode(
  node: unknown,
  hints: MemBenchHints,
  location: string,
): MemBenchCase[] {
  if (Array.isArray(node)) {
    return node.flatMap((entry, index) =>
      normalizePublishedNode(entry, hints, `${location}[${index}]`),
    );
  }

  if (!isPlainObject(node)) {
    return [];
  }

  const flatCase = normalizeFlatCase(node, hints, location);
  if (flatCase) {
    return [flatCase];
  }

  const leafCases = normalizeTrajectoryQaRecord(node, hints, location);
  if (leafCases.length > 0) {
    return leafCases;
  }

  return Object.entries(node).flatMap(([key, value]) =>
    normalizePublishedNode(
      value,
      inferHintsFromLabel(key, hints),
      `${location}.${key}`,
    ),
  );
}

function normalizeFlatCase(
  record: Record<string, unknown>,
  hints: MemBenchHints,
  location: string,
): MemBenchCase | null {
  if (!("turns" in record) || !("question" in record) || !("answer" in record)) {
    return null;
  }

  return parseCase(
    {
      id: resolveCaseId(record, location, 0),
      memoryType: resolveMemoryType(record.memoryType, hints),
      scenario: resolveScenario(record.scenario, hints),
      level: resolveLevel(record.level, hints),
      turns: record.turns,
      question: record.question,
      answer: record.answer,
    },
    location,
  );
}

function normalizeTrajectoryQaRecord(
  record: Record<string, unknown>,
  hints: MemBenchHints,
  location: string,
): MemBenchCase[] {
  const trajectory = record.trajectory;
  const qa = record.qa ?? record.qas ?? record.qa_pairs ?? record.question_answers;

  if (!Array.isArray(trajectory) || !Array.isArray(qa) || qa.length === 0) {
    return [];
  }

  const turns = normalizeTrajectoryTurns(trajectory, `${location}.trajectory`);
  if (!turns) {
    return [];
  }

  const qaPairs = normalizeQaPairs(qa, `${location}.qa`);
  if (qaPairs.length === 0) {
    return [];
  }

  return qaPairs.map((pair, index) =>
    parseCase(
      {
        id: pair.id ?? resolveCaseId(record, location, index),
        memoryType: resolveMemoryType(record.memoryType, hints),
        scenario: resolveScenario(record.scenario, hints),
        level: resolveLevel(record.level, hints),
        turns,
        question: pair.question,
        answer: pair.answer,
      },
      `${location}.qa[${index}]`,
    ),
  );
}

function normalizeTrajectoryTurns(
  trajectory: unknown[],
  location: string,
): Message[] | null {
  if (trajectory.length === 0) {
    return null;
  }

  const speakerRoles = new Map<string, Message["role"]>();
  let distinctSpeakers = 0;
  const turns: Message[] = [];

  for (let index = 0; index < trajectory.length; index += 1) {
    const turn = trajectory[index];
    if (!isPlainObject(turn)) {
      return null;
    }

    const directMessage = parseDirectMessageTurn(turn);
    if (directMessage) {
      turns.push(directMessage);
      continue;
    }

    const speaker = typeof turn.speaker === "string" ? turn.speaker : undefined;
    const text = typeof turn.text === "string"
      ? turn.text
      : typeof turn.content === "string"
        ? turn.content
        : undefined;
    if (!speaker || !text) {
      return null;
    }

    let role = speakerRoles.get(speaker);
    if (!role) {
      role = distinctSpeakers === 0 ? "user" : "assistant";
      speakerRoles.set(speaker, role);
      distinctSpeakers += 1;
    }

    turns.push({ role, content: text });
  }

  return turns.length > 0 ? turns : null;
}

function parseDirectMessageTurn(turn: Record<string, unknown>): Message | null {
  const { role, content } = turn;
  if ((role === "user" || role === "assistant") && typeof content === "string") {
    return { role, content };
  }
  return null;
}

function normalizeQaPairs(
  qa: unknown[],
  location: string,
): Array<{ id?: string; question: string; answer: string }> {
  const pairs: Array<{ id?: string; question: string; answer: string }> = [];

  for (let index = 0; index < qa.length; index += 1) {
    const item = qa[index];
    if (!isPlainObject(item)) {
      continue;
    }

    const question = firstString(item.question, item.query, item.prompt);
    const answer = firstString(item.answer, item.expected, item.gold, item.reference);
    if (!question || !answer) {
      continue;
    }

    const id = firstString(item.id, item.qid, item.question_id);
    pairs.push({ id: id ?? undefined, question, answer });
  }

  return pairs;
}

function resolveCaseId(
  record: Record<string, unknown>,
  location: string,
  index: number,
): string {
  return firstString(record.id, record.case_id, record.sample_id)
    ?? `${sanitizeCaseId(location)}-${index}`;
}

function resolveMemoryType(
  value: unknown,
  hints: MemBenchHints,
): MemBenchCase["memoryType"] {
  const normalized = normalizeLabel(value);
  if (normalized.includes("reflective") || normalized.includes("highlevel")) {
    return "reflective";
  }
  if (normalized.includes("factual") || normalized.includes("lowlevel")) {
    return "factual";
  }
  return hints.memoryType ?? "factual";
}

function resolveScenario(
  value: unknown,
  hints: MemBenchHints,
): MemBenchCase["scenario"] {
  const normalized = normalizeLabel(value);
  if (normalized.includes("participant") || normalized.includes("participation") || normalized.includes("firstagent")) {
    return "participant";
  }
  if (normalized.includes("observation") || normalized.includes("thirdagent")) {
    return "observation";
  }
  return hints.scenario ?? "participant";
}

function resolveLevel(value: unknown, hints: MemBenchHints): string {
  const direct = typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
  return direct ?? hints.level ?? "published";
}

function inferHintsFromLabel(
  label: string,
  current: MemBenchHints,
): MemBenchHints {
  const normalized = normalizeLabel(label);
  const next: MemBenchHints = { ...current };

  if (
    normalized.includes("firstagent")
    || normalized.includes("participation")
    || normalized.includes("participant")
  ) {
    next.scenario = "participant";
  } else if (
    normalized.includes("thirdagent")
    || normalized.includes("observation")
  ) {
    next.scenario = "observation";
  }

  if (
    normalized.includes("highlevel")
    || normalized.includes("reflective")
  ) {
    next.memoryType = "reflective";
    next.level ??= "high_level";
  } else if (
    normalized.includes("lowlevel")
    || normalized.includes("factual")
  ) {
    next.memoryType = "factual";
    next.level ??= "low_level";
  }

  return next;
}

function normalizeLabel(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sanitizeCaseId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-80);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function parseTurn(turn: unknown, location: string): Message {
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
