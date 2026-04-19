/**
 * PersonaMem-v2 runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../../../adapters/types.js";
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
  llmJudgeScore,
  timed,
} from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  PERSONAMEM_SMOKE_FIXTURE,
  type PersonaMemChatHistory,
  type PersonaMemSample,
} from "./fixture.js";

const DATASET_FILE_CANDIDATES = [
  "benchmark/text/benchmark.csv",
  "benchmark/benchmark.csv",
  "benchmark.csv",
] as const;

interface RawPersonaMemRow {
  persona_id: string;
  chat_history_32k_link: string;
  chat_history_128k_link?: string;
  user_query: string;
  correct_answer: string;
  topic_query?: string;
  preference?: string;
  topic_preference?: string;
  pref_type?: string;
  related_conversation_snippet?: string;
  who?: string;
  updated?: string;
  prev_pref?: string;
}

interface CsvRowRecord {
  values: string[];
  rowNumber: number;
}

export const personaMemDefinition: BenchmarkDefinition = {
  id: "personamem",
  title: "PersonaMem-v2",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "personamem",
    version: "2.0.0",
    description:
      "Implicit preference-learning benchmark over long user-chatbot histories and personalized response probes.",
    category: "conversational",
    citation:
      "PersonaMem-v2: Towards Personalized Intelligence via Learning Implicit User Personas and Agentic Memory (2025)",
  },
};

export async function runPersonaMemBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const samples = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex]!;
    await options.system.reset();

    const sessionId = `personamem-${sample.personaId}`;
    const messages = buildMessages(sample.chatHistory.chat_history);
    if (messages.length > 0) {
      await options.system.store(sessionId, messages);
    }

    const { result: recalledText, durationMs } = await timed(async () =>
      options.system.recall(sessionId, sample.userQuery),
    );
    const searchResults = await options.system.search(
      sample.userQuery,
      10,
      sessionId,
    );
    const answered = await answerBenchmarkQuestion({
      question: sample.userQuery,
      recalledText,
      responder: options.system.responder,
    });
    const judgeScore = await llmJudgeScore(
      options.system.judge,
      sample.userQuery,
      answered.finalAnswer,
      sample.correctAnswer,
    );

    const scores: Record<string, number> = {
      f1: f1Score(answered.finalAnswer, sample.correctAnswer),
      contains_answer: containsAnswer(answered.finalAnswer, sample.correctAnswer),
      search_hits: searchResults.length,
    };
    if (judgeScore >= 0) {
      scores.llm_judge = judgeScore;
    }

    tasks.push({
      taskId: `${sample.personaId}-q${sampleIndex}`,
      question: sample.userQuery,
      expected: sample.correctAnswer,
      actual: answered.finalAnswer,
      scores,
      latencyMs: durationMs + answered.latencyMs,
      tokens: answered.tokens,
      details: {
        personaId: sample.personaId,
        topicQuery: sample.topicQuery,
        preference: sample.preference,
        topicPreference: sample.topicPreference,
        prefType: sample.prefType,
        relatedConversationSnippet: sample.relatedConversationSnippet,
        who: sample.who,
        updated: sample.updated,
        prevPref: sample.prevPref,
        chatHistoryMessageCount: sample.chatHistory.chat_history.length,
        chatHistory32kLink: sample.chatHistory32kLink,
        chatHistory128kLink: sample.chatHistory128kLink,
        recalledLength: recalledText.length,
        answeredLength: answered.finalAnswer.length,
        recalledText,
        answeredText: answered.finalAnswer,
        responderModel: answered.model,
      },
    });
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
): Promise<PersonaMemSample[]> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetSamples = (
    samples: PersonaMemSample[],
  ): PersonaMemSample[] => {
    if (samples.length === 0) {
      throw new Error(
        "PersonaMem-v2 dataset is empty after applying the requested limit.",
      );
    }
    return samples;
  };

  if (datasetDir) {
    const datasetErrors: string[] = [];
    for (const relativePath of DATASET_FILE_CANDIDATES) {
      const datasetPath = path.join(datasetDir, relativePath);
      try {
        const raw = await readFile(datasetPath, "utf8");
        const rows = parseCsvRows(raw, relativePath, normalizedLimit);
        const samples: PersonaMemSample[] = [];

        for (const row of rows) {
          samples.push(await hydrateSample(row, datasetDir));
        }

        return ensureDatasetSamples(samples);
      } catch (error) {
        datasetErrors.push(
          `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new Error(
      `PersonaMem-v2 dataset not found under ${datasetDir}. Tried ${DATASET_FILE_CANDIDATES.join(", ")}. Errors: ${datasetErrors.join(" | ")}`,
    );
  }

  if (mode === "full") {
    throw new Error(
      "PersonaMem-v2 full mode requires datasetDir. Pass a dataset root or use quick mode to run the bundled smoke fixture.",
    );
  }

  return ensureDatasetSamples(
    applyLimit(PERSONAMEM_SMOKE_FIXTURE, normalizedLimit),
  );
}

async function hydrateSample(
  row: RawPersonaMemRow,
  datasetRoot: string,
): Promise<PersonaMemSample> {
  if (row.persona_id.trim().length === 0) {
    throw new Error("PersonaMem-v2 row is missing persona_id.");
  }
  if (row.chat_history_32k_link.trim().length === 0) {
    throw new Error(
      `PersonaMem-v2 row for persona ${row.persona_id} is missing chat_history_32k_link.`,
    );
  }
  if (row.correct_answer.trim().length === 0) {
    throw new Error(
      `PersonaMem-v2 row for persona ${row.persona_id} is missing correct_answer.`,
    );
  }

  const userQuery = extractLooseObjectValue(row.user_query, "content")
    ?? row.user_query.trim();
  if (userQuery.length === 0) {
    throw new Error(
      `PersonaMem-v2 row for persona ${row.persona_id} is missing user_query content.`,
    );
  }

  const chatHistoryPath = await resolveDatasetFilePath(
    datasetRoot,
    row.chat_history_32k_link,
  );
  const chatHistoryRaw = await readFile(chatHistoryPath, "utf8");
  const chatHistory = parseChatHistory(
    chatHistoryRaw,
    row.chat_history_32k_link,
  );

  return {
    personaId: row.persona_id,
    userQuery,
    correctAnswer: row.correct_answer,
    topicQuery: row.topic_query,
    preference: row.preference,
    topicPreference: row.topic_preference,
    prefType: row.pref_type,
    relatedConversationSnippet: row.related_conversation_snippet,
    who: row.who,
    updated: row.updated,
    prevPref: row.prev_pref,
    chatHistory,
    chatHistory32kLink: row.chat_history_32k_link,
    chatHistory128kLink: row.chat_history_128k_link,
  };
}

function parseCsvRows(
  raw: string,
  filename: string,
  limit: number | undefined,
): RawPersonaMemRow[] {
  const rows = parseCsv(raw, limit);
  if (rows.length < 2) {
    throw new Error(
      `PersonaMem-v2 dataset file ${filename} must contain a header row and at least one data row.`,
    );
  }

  const [header, ...dataRows] = rows;
  const headerIndex = new Map<string, number>();
  header.values.forEach((name, index) => {
    headerIndex.set(name, index);
  });

  const requiredColumns = [
    "persona_id",
    "chat_history_32k_link",
    "user_query",
    "correct_answer",
  ] as const;
  for (const column of requiredColumns) {
    if (!headerIndex.has(column)) {
      throw new Error(
        `PersonaMem-v2 dataset file ${filename} is missing required column "${column}".`,
      );
    }
  }

  return dataRows.map((row) => {
      const valueAt = (column: string): string => {
        const index = headerIndex.get(column);
        return index === undefined ? "" : (row.values[index] ?? "");
      };

      const record: RawPersonaMemRow = {
        persona_id: valueAt("persona_id"),
        chat_history_32k_link: valueAt("chat_history_32k_link"),
        chat_history_128k_link: valueAt("chat_history_128k_link") || undefined,
        user_query: valueAt("user_query"),
        correct_answer: valueAt("correct_answer"),
        topic_query: valueAt("topic_query") || undefined,
        preference: valueAt("preference") || undefined,
        topic_preference: valueAt("topic_preference") || undefined,
        pref_type: valueAt("pref_type") || undefined,
        related_conversation_snippet:
          valueAt("related_conversation_snippet") || undefined,
        who: valueAt("who") || undefined,
        updated: valueAt("updated") || undefined,
        prev_pref: valueAt("prev_pref") || undefined,
      };

      if (record.persona_id.trim().length === 0) {
        throw new Error(
          `PersonaMem-v2 dataset file ${filename} row ${row.rowNumber} is missing persona_id.`,
        );
      }
      return record;
    });
}

function parseCsv(raw: string, limit: number | undefined): CsvRowRecord[] {
  const rows: CsvRowRecord[] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let rowNumber = 1;
  let dataRowCount = 0;

  const pushRow = (): boolean => {
    const values = [...currentRow, currentField];
    const isHeader = rows.length === 0;
    const isBlank = values.every((value) => value.trim().length === 0);

    if (isHeader || !isBlank) {
      rows.push({ values, rowNumber });
      if (!isHeader) {
        dataRowCount += 1;
      }
    }

    currentRow = [];
    currentField = "";
    rowNumber += 1;

    return limit !== undefined && dataRowCount >= limit;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    const next = raw[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        currentField += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      currentRow.push(currentField);
      currentField = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      if (pushRow()) {
        return rows;
      }
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    pushRow();
  }

  return rows;
}

async function resolveDatasetFilePath(
  datasetRoot: string,
  relativePath: string,
): Promise<string> {
  const rootPath = path.resolve(datasetRoot);
  const rootRealPath = await realpath(rootPath);
  const candidatePath = path.resolve(rootPath, relativePath);
  const candidateRealPath = await realpath(candidatePath);
  const relativeToRoot = path.relative(rootRealPath, candidateRealPath);

  if (
    relativeToRoot.startsWith("..")
    || path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(
      `PersonaMem-v2 dataset file reference "${relativePath}" must stay within datasetDir.`,
    );
  }

  return candidateRealPath;
}

function extractLooseObjectValue(
  raw: string,
  key: string,
): string | undefined {
  const patterns = [`'${key}'`, `"${key}"`];
  for (const pattern of patterns) {
    const start = raw.indexOf(pattern);
    if (start < 0) {
      continue;
    }

    let index = start + pattern.length;
    while (index < raw.length && /\s/.test(raw[index]!)) {
      index += 1;
    }
    if (raw[index] !== ":") {
      continue;
    }
    index += 1;
    while (index < raw.length && /\s/.test(raw[index]!)) {
      index += 1;
    }

    const quote = raw[index];
    if (quote !== "'" && quote !== "\"") {
      continue;
    }

    const parsed = readQuotedValue(raw, index);
    if (parsed) {
      return parsed.value;
    }
  }

  return undefined;
}

function readQuotedValue(
  raw: string,
  start: number,
): { value: string; end: number } | undefined {
  const quote = raw[start];
  if (quote !== "'" && quote !== "\"") {
    return undefined;
  }

  let value = "";
  for (let index = start + 1; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "\\") {
      const next = raw[index + 1];
      if (next !== undefined) {
        value += next;
        index += 1;
      }
      continue;
    }
    if (char === quote) {
      return { value, end: index + 1 };
    }
    value += char;
  }

  return undefined;
}

function parseChatHistory(
  raw: string,
  filename: string,
): PersonaMemChatHistory {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `PersonaMem-v2 chat history ${filename} must contain an object with a chat_history array.`,
    );
  }

  const chatHistory = (parsed as { chat_history?: unknown }).chat_history;
  if (!Array.isArray(chatHistory)) {
    throw new Error(
      `PersonaMem-v2 chat history ${filename} is missing the chat_history array.`,
    );
  }

  return {
    metadata:
      "metadata" in parsed && typeof parsed.metadata === "object"
        ? (parsed.metadata as Record<string, unknown>)
        : undefined,
    chat_history: chatHistory.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `PersonaMem-v2 chat history ${filename} contains a malformed message at index ${index}.`,
        );
      }

      const role = typeof entry.role === "string" ? entry.role : "assistant";
      const content =
        typeof entry.content === "string" ? entry.content : String(entry.content ?? "");
      return { role, content };
    }),
  };
}

function buildMessages(chatHistory: PersonaMemChatHistory["chat_history"]): Message[] {
  return chatHistory
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({
      role: normalizeRole(message.role),
      content: message.content,
    }));
}

function normalizeRole(role: string): Message["role"] {
  switch (role) {
    case "user":
    case "assistant":
    case "system":
      return role;
    default:
      return "assistant";
  }
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `PersonaMem-v2 limit must be a non-negative integer. Received ${limit}.`,
    );
  }

  return limit;
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  return limit === undefined ? items : items.slice(0, limit);
}
