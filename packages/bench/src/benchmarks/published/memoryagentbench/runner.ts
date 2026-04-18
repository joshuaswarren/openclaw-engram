/**
 * MemoryAgentBench runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../../../adapters/types.js";
import {
  MEMORY_AGENT_BENCH_SMOKE_FIXTURE,
  type MemoryAgentBenchCompetency,
  type MemoryAgentBenchItem,
  type MemoryAgentBenchMetadata,
  type MemoryAgentBenchTurn,
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
  rougeL,
  timed,
} from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";

const DATASET_SPLITS = [
  {
    split: "Accurate_Retrieval",
    competency: "accurate_retrieval" as const,
    sourcePrefix: "eventqa",
    candidates: [
      "Accurate_Retrieval.json",
      "Accurate_Retrieval.jsonl",
      "accurate_retrieval.json",
      "accurate_retrieval.jsonl",
    ],
  },
  {
    split: "Test_Time_Learning",
    competency: "test_time_learning" as const,
    sourcePrefix: "icl_",
    candidates: [
      "Test_Time_Learning.json",
      "Test_Time_Learning.jsonl",
      "test_time_learning.json",
      "test_time_learning.jsonl",
    ],
  },
  {
    split: "Long_Range_Understanding",
    competency: "long_range_understanding" as const,
    sourcePrefix: "detective_",
    candidates: [
      "Long_Range_Understanding.json",
      "Long_Range_Understanding.jsonl",
      "long_range_understanding.json",
      "long_range_understanding.jsonl",
    ],
  },
  {
    split: "Conflict_Resolution",
    competency: "conflict_resolution" as const,
    sourcePrefix: "factconsolidation",
    candidates: [
      "Conflict_Resolution.json",
      "Conflict_Resolution.jsonl",
      "conflict_resolution.json",
      "conflict_resolution.jsonl",
    ],
  },
] as const;

const DATASET_BUNDLE_CANDIDATES = [
  "memoryagentbench.json",
  "memoryagentbench.jsonl",
  "MemoryAgentBench.json",
  "MemoryAgentBench.jsonl",
] as const;

export const memoryAgentBenchDefinition: BenchmarkDefinition = {
  id: "memoryagentbench",
  title: "MemoryAgentBench",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "memoryagentbench",
    version: "2.0.0",
    description:
      "Incremental multi-turn memory benchmark spanning accurate retrieval, test-time learning, long-range understanding, and conflict resolution.",
    category: "agentic",
    citation:
      "Hu et al. Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions. ICLR 2026.",
  },
};

export async function runMemoryAgentBenchBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const dataset = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];

  for (const [itemIndex, item] of dataset.entries()) {
    await options.system.reset();

    const sessionIds = await storeBenchmarkContext(options, item, itemIndex);
    for (let questionIndex = 0; questionIndex < item.questions.length; questionIndex += 1) {
      const question = item.questions[questionIndex]!;
      const answerVariants = item.answers[questionIndex];
      if (answerVariants === undefined || answerVariants.length === 0) {
        throw new Error(
          `MemoryAgentBench sample ${item.metadata.source} is missing answers for question index ${questionIndex}.`,
        );
      }

      const { result: recalledText, durationMs } = await timed(async () => {
        const recalledSessions = await Promise.all(
          sessionIds.map((sessionId) => options.system.recall(sessionId, question)),
        );
        return recalledSessions.filter(Boolean).join("\n\n");
      });
      const bestExpectedAnswer = selectBestMatchingAnswer(recalledText, answerVariants);
      const judgeScore = await llmJudgeScore(
        options.system.judge,
        question,
        recalledText,
        bestExpectedAnswer,
      );

      const scores: Record<string, number> = {
        f1: scoreAgainstVariants(recalledText, answerVariants, f1Score),
        contains_answer: answerVariants.some((variant) =>
          containsAnswer(recalledText, variant),
        )
          ? 1
          : 0,
        rouge_l: scoreAgainstVariants(recalledText, answerVariants, rougeL),
      };
      if (judgeScore >= 0) {
        scores.llm_judge = judgeScore;
      }

      tasks.push({
        taskId:
          item.metadata.qa_pair_ids?.[questionIndex] ??
          `${item.metadata.source}-q${questionIndex}`,
        question,
        expected: answerVariants[0]!,
        actual: recalledText,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          competency: item.metadata.competency,
          source: item.metadata.source,
          questionType: item.metadata.question_types?.[questionIndex],
          questionId: item.metadata.question_ids?.[questionIndex],
          questionDate: item.metadata.question_dates?.[questionIndex],
          previousEvent: item.metadata.previous_events?.[questionIndex],
          keypoints: item.metadata.keypoints ?? [],
          answerVariants,
          bestExpectedAnswer,
          sessionIds,
          storedSessionCount: sessionIds.length,
          recalledLength: recalledText.length,
        },
      });
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

async function loadDataset(
  mode: "full" | "quick",
  datasetDir: string | undefined,
  limit?: number,
): Promise<MemoryAgentBenchItem[]> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetItems = (items: MemoryAgentBenchItem[]): MemoryAgentBenchItem[] => {
    if (items.length === 0) {
      throw new Error(
        "MemoryAgentBench dataset is empty after applying the requested limit.",
      );
    }
    return items;
  };

  if (datasetDir) {
    const datasetErrors: string[] = [];

    for (const filename of DATASET_BUNDLE_CANDIDATES) {
      try {
        const parsed = await readDatasetFile(path.join(datasetDir, filename), filename);
        return ensureDatasetItems(applyLimit(parsed, normalizedLimit));
      } catch (error) {
        datasetErrors.push(
          `${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const splitItems: MemoryAgentBenchItem[] = [];
    let remainingLimit = normalizedLimit;
    for (const splitConfig of DATASET_SPLITS) {
      if (remainingLimit === 0) {
        break;
      }

      let splitData: MemoryAgentBenchItem[] | undefined;
      for (const filename of splitConfig.candidates) {
        try {
          splitData = await readDatasetFile(path.join(datasetDir, filename), filename);
          break;
        } catch (error) {
          datasetErrors.push(
            `${filename}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (!splitData) {
        continue;
      }

      const filtered = splitData.filter(
        (item) =>
          item.metadata.competency === splitConfig.competency ||
          item.metadata.source.toLowerCase().startsWith(splitConfig.sourcePrefix),
      );
      const limited = applyLimit(filtered, remainingLimit);
      splitItems.push(...limited);
      if (remainingLimit !== undefined) {
        remainingLimit = Math.max(0, remainingLimit - limited.length);
      }
    }

    if (splitItems.length > 0) {
      return ensureDatasetItems(splitItems);
    }

    throw new Error(
      `MemoryAgentBench dataset not found under ${datasetDir}. Tried bundle files (${DATASET_BUNDLE_CANDIDATES.join(", ")}) and split files for ${DATASET_SPLITS.map((split) => split.split).join(", ")}. Errors: ${datasetErrors.join(" | ")}`,
    );
  }

  if (mode === "full") {
    throw new Error(
      "MemoryAgentBench full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  return ensureDatasetItems(applyLimit(MEMORY_AGENT_BENCH_SMOKE_FIXTURE, normalizedLimit));
}

async function readDatasetFile(
  filePath: string,
  filename: string,
): Promise<MemoryAgentBenchItem[]> {
  const raw = await readFile(filePath, "utf8");
  const parsed = filename.endsWith(".jsonl")
    ? parseJsonLines(raw, filename)
    : parseJsonArray(raw, filename);

  return parsed.map((item, index) =>
    parseMemoryAgentBenchItem(item, `${filename} item ${index + 1}`),
  );
}

function parseJsonArray(raw: string, filename: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MemoryAgentBench dataset file ${filename} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `MemoryAgentBench dataset file ${filename} must contain an array of samples.`,
    );
  }

  return parsed;
}

function parseJsonLines(raw: string, filename: string): unknown[] {
  const rows: unknown[] = [];

  raw.split("\n").forEach((line, lineIndex) => {
    if (line.trim().length === 0) {
      return;
    }

    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `MemoryAgentBench dataset file ${filename} contains invalid JSON on line ${lineIndex + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  return rows;
}

function parseMemoryAgentBenchItem(
  value: unknown,
  location: string,
): MemoryAgentBenchItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.context !== "string" || record.context.trim().length === 0) {
    throw new Error(`${location} must include a non-empty string context.`);
  }

  const questions = normalizeStringArray(record.questions, `${location}.questions`);
  const answers = normalizeAnswerVariants(record.answers, `${location}.answers`);
  if (questions.length === 0) {
    throw new Error(`${location} must include at least one question.`);
  }
  if (questions.length !== answers.length) {
    throw new Error(
      `${location} must include the same number of questions and answer groups.`,
    );
  }

  return {
    context: record.context,
    questions,
    answers,
    metadata: parseMetadata(record.metadata, location),
  };
}

function parseMetadata(
  value: unknown,
  location: string,
): MemoryAgentBenchMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location}.metadata must be an object.`);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.source !== "string" || record.source.trim().length === 0) {
    throw new Error(`${location}.metadata.source must be a non-empty string.`);
  }

  const competency = inferCompetency(record.source);
  return {
    source: record.source,
    competency,
    demo: typeof record.demo === "string" || record.demo === null ? (record.demo ?? null) : null,
    haystack_sessions: normalizeHaystackSessions(
      record.haystack_sessions,
      `${location}.metadata.haystack_sessions`,
    ),
    keypoints: normalizeOptionalStringArray(record.keypoints, `${location}.metadata.keypoints`),
    previous_events: normalizeOptionalStringArray(
      record.previous_events,
      `${location}.metadata.previous_events`,
    ),
    qa_pair_ids: normalizeOptionalStringArray(
      record.qa_pair_ids,
      `${location}.metadata.qa_pair_ids`,
    ),
    question_dates: normalizeOptionalStringArray(
      record.question_dates,
      `${location}.metadata.question_dates`,
    ),
    question_ids: normalizeOptionalStringArray(
      record.question_ids,
      `${location}.metadata.question_ids`,
    ),
    question_types: normalizeOptionalStringArray(
      record.question_types,
      `${location}.metadata.question_types`,
    ),
  };
}

function inferCompetency(source: string): MemoryAgentBenchCompetency {
  const normalizedSource = source.toLowerCase();
  if (normalizedSource.startsWith("eventqa") || normalizedSource.startsWith("longmemeval")) {
    return "accurate_retrieval";
  }
  if (normalizedSource.startsWith("icl_") || normalizedSource.startsWith("recsys_")) {
    return "test_time_learning";
  }
  if (normalizedSource.startsWith("detective_") || normalizedSource.startsWith("infbench_")) {
    return "long_range_understanding";
  }
  if (normalizedSource.startsWith("factconsolidation")) {
    return "conflict_resolution";
  }

  throw new Error(
    `MemoryAgentBench metadata.source "${source}" does not map to a supported competency.`,
  );
}

function normalizeStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array of strings.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${location}[${index}] must be a non-empty string.`);
    }
    return entry;
  });
}

function normalizeOptionalStringArray(
  value: unknown,
  location: string,
): string[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  return normalizeStringArray(value, location);
}

function normalizeAnswerVariants(value: unknown, location: string): string[][] {
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array of answer groups.`);
  }

  return value.map((entry, index) => {
    const answerGroup = Array.isArray(entry) ? entry : [entry];
    const normalized = answerGroup
      .map((candidate, candidateIndex) => {
        if (typeof candidate !== "string" || candidate.trim().length === 0) {
          throw new Error(
            `${location}[${index}][${candidateIndex}] must be a non-empty string.`,
          );
        }
        return candidate;
      })
      .filter(Boolean);

    if (normalized.length === 0) {
      throw new Error(`${location}[${index}] must include at least one answer variant.`);
    }

    return normalized;
  });
}

function normalizeHaystackSessions(
  value: unknown,
  location: string,
): MemoryAgentBenchTurn[][] | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${location} must be an array of sessions.`);
  }

  return value.map((session, sessionIndex) => {
    if (!Array.isArray(session)) {
      throw new Error(`${location}[${sessionIndex}] must be an array of turns.`);
    }

    return session.map((turn, turnIndex) => {
      if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
        throw new Error(
          `${location}[${sessionIndex}][${turnIndex}] must be an object with role/content.`,
        );
      }

      const record = turn as Record<string, unknown>;
      if (
        record.role !== "user" &&
        record.role !== "assistant" &&
        record.role !== "system"
      ) {
        throw new Error(
          `${location}[${sessionIndex}][${turnIndex}].role must be user, assistant, or system.`,
        );
      }
      if (typeof record.content !== "string" || record.content.trim().length === 0) {
        throw new Error(
          `${location}[${sessionIndex}][${turnIndex}].content must be a non-empty string.`,
        );
      }

      return {
        role: record.role,
        content: record.content,
        has_answer:
          typeof record.has_answer === "boolean" ? record.has_answer : undefined,
      };
    });
  });
}

async function storeBenchmarkContext(
  options: ResolvedRunBenchmarkOptions,
  item: MemoryAgentBenchItem,
  itemIndex: number,
): Promise<string[]> {
  const sourceSlug = item.metadata.source.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const baseSessionId = `memoryagentbench-${sourceSlug}-${itemIndex}`;
  const storedSessionIds: string[] = [];

  if (item.metadata.haystack_sessions && item.metadata.haystack_sessions.length > 0) {
    for (const [sessionIndex, turns] of item.metadata.haystack_sessions.entries()) {
      const sessionId = `${baseSessionId}-session-${sessionIndex}`;
      const messages = turns.map<Message>((turn) => ({
        role: turn.role,
        content: turn.content,
      }));
      if (messages.length > 0) {
        await storeMessagesInChunks(options, sessionId, messages);
        storedSessionIds.push(sessionId);
      }
    }
  }

  if (storedSessionIds.length > 0) {
    return storedSessionIds;
  }

  const chunkedContext = chunkContext(item.context);
  const sessionId = `${baseSessionId}-context`;
  if (chunkedContext.length > 0) {
    await storeMessagesInChunks(
      options,
      sessionId,
      chunkedContext.map<Message>((content) => ({ role: "user", content })),
    );
  }
  return [sessionId];
}

async function storeMessagesInChunks(
  options: ResolvedRunBenchmarkOptions,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  for (let index = 0; index < messages.length; index += 20) {
    await options.system.store(sessionId, messages.slice(index, index + 20));
  }
}

function chunkContext(context: string): string[] {
  const paragraphs = context
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks = paragraphs.length > 0 ? paragraphs : [context.trim()].filter(Boolean);
  return chunks.flatMap((chunk) => splitLongChunk(chunk, 1_200));
}

function splitLongChunk(chunk: string, maxLength: number): string[] {
  if (chunk.length <= maxLength) {
    return [chunk];
  }

  const segments: string[] = [];
  let remaining = chunk;
  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    let keepTrailingPunctuation = false;
    if (splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(". ", maxLength);
      keepTrailingPunctuation = splitIndex >= maxLength * 0.5;
    }
    if (splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
      keepTrailingPunctuation = false;
    } else if (keepTrailingPunctuation) {
      splitIndex += 1;
    }

    segments.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining.length > 0) {
    segments.push(remaining);
  }

  return segments.filter(Boolean);
}

function scoreAgainstVariants(
  actual: string,
  variants: string[],
  scorer: (actual: string, expected: string) => number,
): number {
  return variants.reduce(
    (best, variant) => Math.max(best, scorer(actual, variant)),
    Number.NEGATIVE_INFINITY,
  );
}

function selectBestMatchingAnswer(actual: string, variants: string[]): string {
  return variants.reduce((best, candidate) => {
    if (!best) {
      return candidate;
    }

    const currentScore = scoreAgainstVariants(actual, [best], f1Score);
    const candidateScore = scoreAgainstVariants(actual, [candidate], f1Score);
    return candidateScore > currentScore ? candidate : best;
  }, "");
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      "MemoryAgentBench limit must be a non-negative integer when provided.",
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
