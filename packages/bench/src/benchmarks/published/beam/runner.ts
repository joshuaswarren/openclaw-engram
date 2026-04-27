/**
 * BEAM runner migrated into @remnic/bench for phase 2.
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Message } from "../../../adapters/types.js";
import {
  answerBenchmarkQuestion,
  type BenchmarkAnswerFormat,
} from "../../../answering.js";
import { benchmarkRecallBudgetForSessionCount } from "../../../recall-budget.js";
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
  rougeL,
  timed,
} from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  BEAM_SMOKE_FIXTURE,
  type BeamChatTurn,
  type BeamConversation,
  type BeamPlan,
  type BeamPlanChatBatch,
  type BeamPlanChatMap,
  type BeamQuestion,
  type BeamQuestionMap,
} from "./fixture.js";

const SPLIT_ORDER: Record<string, number> = {
  "100K": 0,
  "500K": 1,
  "1M": 2,
  "10M": 3,
};

export const beamDefinition: BenchmarkDefinition = {
  id: "beam",
  title: "BEAM",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "beam",
    version: "2.0.0",
    description:
      "Beyond a Million Tokens benchmark across 128K/500K/1M/10M conversational memory probes and 10 memory abilities.",
    category: "retrieval",
    citation:
      "Tavakoli et al. Beyond a Million Tokens: Benchmarking and Enhancing Long-Term Memory in LLMs. ICLR 2026.",
  },
};

interface BeamDatasetEntry {
  scale: string;
  conversation: BeamConversation;
}

interface BeamSession {
  sessionId: string;
  messages: Message[];
}

interface BeamDatasetSource {
  totalTasks?: number;
  entries(): AsyncIterable<BeamDatasetEntry>;
}

export async function runBeamBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const dataset = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];
  const totalTasks = dataset.totalTasks;
  let entryCount = 0;

  for await (const entry of dataset.entries()) {
    entryCount += 1;
    await options.system.reset();

    const questionMap = normalizeQuestionMap(entry.conversation.probing_questions);
    const sessions = collectSessions(entry.conversation, entry.scale);
    const sessionIds = sessions
      .filter((session) => session.messages.length > 0)
      .map((session) => session.sessionId);

    for (const session of sessions) {
      if (session.messages.length > 0) {
        await options.system.store(session.sessionId, session.messages);
      }
    }

    try {
      await options.system.drain?.();
    } catch (drainErr) {
      console.error(`  [WARN] beam drain failed for ${entry.conversation.conversation_id}: ${drainErr instanceof Error ? drainErr.message : String(drainErr)}`);
    }

    let taskIndex = 0;
    for (const [ability, questions] of Object.entries(questionMap)) {
      for (const probe of questions) {
        const taskResultId = `${entry.scale}-${entry.conversation.conversation_id}-${ability}-${taskIndex}`;
        const expected = buildExpectedAnswer(probe);
        const answerFormat = answerFormatForAbility(ability);
        try {
          const rubricTargets = normalizeRubricTargets(probe.rubric);
          const { result: recalledText, durationMs } = await timed(async () => {
            const recallBudget = benchmarkRecallBudgetForSessionCount(
              sessionIds.length,
            );
            const recalledSessions = await Promise.all(
              sessionIds.map((sessionId) =>
                options.system.recall(sessionId, probe.question, recallBudget),
              ),
            );
            return recalledSessions.filter(Boolean).join("\n\n");
          });
          const answered = await answerBenchmarkQuestion({
            question: probe.question,
            recalledText,
            responder: options.system.responder,
            answerMode: "strict",
            answerFormat,
          });
          const searchResults = await options.system.search(probe.question, 10);
          const judgeResult = await llmJudgeScoreDetailed(
            options.system.judge,
            probe.question,
            answered.finalAnswer,
            expected,
          );

          const scores: Record<string, number> = {
            f1: f1Score(answered.finalAnswer, expected),
            contains_answer: containsAnswer(answered.finalAnswer, expected),
            rouge_l: rougeL(answered.finalAnswer, expected),
            search_hits: searchResults.length,
          };
          if (rubricTargets.length > 0) {
            scores.rubric_coverage = computeRubricCoverage(
              answered.finalAnswer,
              rubricTargets,
            );
          }
          if (judgeResult.score >= 0) {
            scores.llm_judge = judgeResult.score;
          }

          tasks.push({
            taskId: taskResultId,
            question: probe.question,
            expected,
            actual: answered.finalAnswer,
            scores,
            latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
            tokens: {
              input: answered.tokens.input + judgeResult.tokens.input,
              output: answered.tokens.output + judgeResult.tokens.output,
            },
            details: {
              ability,
              scale: entry.scale,
              difficulty: probe.difficulty,
              conversationId: entry.conversation.conversation_id,
              sessionCount: sessionIds.length,
              planReference: probe.plan_reference,
              sourceChatIds: probe.source_chat_ids,
              rubric: probe.rubric,
              answerFormat,
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
          console.error(`  [WARN] beam task ${taskResultId} failed: ${message}`);
          tasks.push({
            taskId: taskResultId,
            question: probe.question,
            expected,
            actual: `(error: ${message})`,
            scores: { f1: -1, contains_answer: -1, rouge_l: -1, search_hits: -1, llm_judge: -1 },
            latencyMs: 0,
            tokens: { input: 0, output: 0 },
            details: { error: message },
          });
        }

        options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalTasks);
        taskIndex += 1;
      }
    }
  }

  if (entryCount === 0) {
    throw new Error("BEAM dataset is empty after applying the requested limit.");
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
): Promise<BeamDatasetSource> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetEntries = (entryCount: number): void => {
    if (entryCount === 0) {
      throw new Error("BEAM dataset is empty after applying the requested limit.");
    }
  };

  if (datasetDir) {
    let filenames: string[];
    try {
      filenames = await readdir(datasetDir);
    } catch (error) {
      throw new Error(
        `BEAM dataset not found under ${datasetDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const datasetFiles = filenames
      .filter((filename) => filename.endsWith(".json") || filename.endsWith(".jsonl"))
      .sort((left, right) => compareDatasetFiles(left, right));

    if (datasetFiles.length === 0) {
      throw new Error(
        `BEAM dataset not found under ${datasetDir}: no .json or .jsonl files were found.`,
      );
    }

    if (normalizedLimit === 0) {
      ensureDatasetEntries(0);
    }

    return {
      entries: () => iterateDatasetFiles(datasetDir, datasetFiles, normalizedLimit),
    };
  }

  if (mode === "full") {
    throw new Error(
      "BEAM full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  const conversations = applyLimit(BEAM_SMOKE_FIXTURE, normalizedLimit);
  ensureDatasetEntries(conversations.length);

  return {
    totalTasks: conversations.reduce(
      (sum, conversation) => sum + countQuestions(conversation),
      0,
    ),
    entries: async function* entries() {
      for (const conversation of conversations) {
        yield {
          scale: "100K",
          conversation,
        };
      }
    },
  };
}

function compareDatasetFiles(left: string, right: string): number {
  const scaleDelta =
    (SPLIT_ORDER[inferScaleFromFilename(left)] ?? Number.MAX_SAFE_INTEGER) -
    (SPLIT_ORDER[inferScaleFromFilename(right)] ?? Number.MAX_SAFE_INTEGER);
  if (scaleDelta !== 0) {
    return scaleDelta;
  }
  return left.localeCompare(right);
}

function inferScaleFromFilename(filename: string): string {
  const normalized = filename.toLowerCase();
  if (normalized.includes("10m")) return "10M";
  if (normalized.includes("1m")) return "1M";
  if (normalized.includes("500k")) return "500K";
  if (normalized.includes("100k") || normalized.includes("128k")) return "100K";
  return "unknown";
}

async function* iterateDatasetFiles(
  datasetDir: string,
  datasetFiles: string[],
  limit: number | undefined,
): AsyncIterable<BeamDatasetEntry> {
  let remainingLimit = limit;
  for (const filename of datasetFiles) {
    const scale = inferScaleFromFilename(filename);
    const filePath = path.join(datasetDir, filename);
    const conversations = filename.endsWith(".jsonl")
      ? streamJsonlDataset(filePath, filename, remainingLimit)
      : streamJsonDataset(filePath, filename, remainingLimit);

    for await (const conversation of conversations) {
      yield {
        scale,
        conversation,
      };
      if (remainingLimit !== undefined) {
        remainingLimit -= 1;
      }
    }
    if (remainingLimit === 0) {
      break;
    }
  }
}

function answerFormatForAbility(ability: string): BenchmarkAnswerFormat {
  if (ability === "instruction_following") {
    return "instruction";
  }
  return "short-with-specifics";
}

async function* streamJsonDataset(
  filePath: string,
  filename: string,
  limit: number | undefined,
): AsyncIterable<BeamConversation> {
  const stream = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 1024 * 1024,
  });
  let seenArrayStart = false;
  let seenArrayEnd = false;
  let collectingObject = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objectIndex = 0;
  let yielded = 0;
  let hasSeenArrayValue = false;
  let expectingArrayValue = false;
  let objectParts: string[] = [];

  for await (const chunk of stream) {
    let objectStart = collectingObject ? 0 : -1;

    for (let index = 0; index < chunk.length; index += 1) {
      const current = chunk[index]!;

      if (!collectingObject) {
        if (seenArrayEnd) {
          if (/\s/.test(current)) {
            continue;
          }
          throw new Error(
            `BEAM dataset file ${filename} contains trailing content after the JSON array.`,
          );
        }

        if (!seenArrayStart) {
          if (/\s/.test(current)) {
            continue;
          }
          if (current !== "[") {
            throw new Error(
              `BEAM dataset file ${filename} must contain a JSON array of conversations.`,
            );
          }
          seenArrayStart = true;
          expectingArrayValue = true;
          continue;
        }

        if (/\s/.test(current)) {
          continue;
        }
        if (current === ",") {
          if (expectingArrayValue) {
            throw new Error(
              `BEAM dataset file ${filename} contains invalid comma placement near conversation ${objectIndex}.`,
            );
          }
          expectingArrayValue = true;
          continue;
        }
        if (current === "]") {
          if (expectingArrayValue && hasSeenArrayValue) {
            throw new Error(
              `BEAM dataset file ${filename} contains invalid trailing comma near conversation ${objectIndex}.`,
            );
          }
          seenArrayEnd = true;
          continue;
        }
        if (current !== "{") {
          throw new Error(
            `BEAM dataset file ${filename} contains invalid JSON array content near conversation ${objectIndex}.`,
          );
        }
        if (!expectingArrayValue) {
          throw new Error(
            `BEAM dataset file ${filename} is missing a comma before conversation ${objectIndex + 1}.`,
          );
        }

        collectingObject = true;
        inString = false;
        escaped = false;
        depth = 1;
        objectParts = [];
        objectStart = index;
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (current === "\\") {
          escaped = true;
          continue;
        }
        if (current === "\"") {
          inString = false;
        }
        continue;
      }

      if (current === "\"") {
        inString = true;
        continue;
      }
      if (current === "{") {
        depth += 1;
        continue;
      }
      if (current !== "}") {
        continue;
      }

      depth -= 1;
      if (depth === 0) {
        objectParts.push(chunk.slice(objectStart, index + 1));
        const rawObject = objectParts.join("");
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawObject);
        } catch (error) {
          throw new Error(
            `BEAM dataset file ${filename} contains invalid JSON at conversation ${objectIndex}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const conversation = validateConversation(parsed, `${filename}[${objectIndex}]`);
        objectIndex += 1;
        hasSeenArrayValue = true;
        expectingArrayValue = false;
        collectingObject = false;
        objectParts = [];
        objectStart = -1;
        if (limit === undefined || yielded < limit) {
          yield conversation;
          yielded += 1;
        }
      }
    }

    if (collectingObject && objectStart >= 0) {
      objectParts.push(chunk.slice(objectStart));
    }
  }

  if (collectingObject) {
    throw new Error(`BEAM dataset file ${filename} has an unterminated conversation object.`);
  }
  if (!seenArrayStart) {
    throw new Error(
      `BEAM dataset file ${filename} must contain a JSON array of conversations.`,
    );
  }
  if (!seenArrayEnd) {
    throw new Error(`BEAM dataset file ${filename} has an unterminated JSON array.`);
  }
}

async function* streamJsonlDataset(
  filePath: string,
  filename: string,
  limit: number | undefined,
): AsyncIterable<BeamConversation> {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let yielded = 0;
  let lineIndex = 0;

  for await (const line of lines) {
    lineIndex += 1;
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `BEAM dataset file ${filename} contains invalid JSON on line ${lineIndex}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const conversation = validateConversation(parsed, `${filename}:${lineIndex}`);
    if (limit === undefined || yielded < limit) {
      yield conversation;
      yielded += 1;
    }
  }
}

function countQuestions(conversation: BeamConversation): number {
  return Object.values(normalizeQuestionMap(conversation.probing_questions)).reduce(
    (sum, questions) => sum + questions.length,
    0,
  );
}

function validateConversation(
  value: unknown,
  location: string,
): BeamConversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`BEAM conversation ${location} must be an object.`);
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.conversation_id !== "string" &&
    !Number.isInteger(record.conversation_id)
  ) {
    throw new Error(
      `BEAM conversation ${location} must include a string or integer conversation_id.`,
    );
  }
  if (!isChatCollection(record.chat) && !isPlanChatMapCollection(record.chat)) {
    throw new Error(
      `BEAM conversation ${location} must include chat data as a list of turns or turn batches.`,
    );
  }
  if (
    typeof record.probing_questions !== "string" &&
    !isQuestionMap(record.probing_questions)
  ) {
    throw new Error(
      `BEAM conversation ${location} must include probing_questions as a string or question map.`,
    );
  }
  if (record.plans !== undefined && !isValidPlans(record.plans)) {
    throw new Error(
      `BEAM conversation ${location} has an invalid plans array.`,
    );
  }

  return record as unknown as BeamConversation;
}

function isChatCollection(value: unknown): value is BeamChatTurn[][] | BeamChatTurn[] {
  if (!Array.isArray(value)) {
    return false;
  }
  if (value.length === 0) {
    return true;
  }

  if (isChatTurn(value[0])) {
    return value.every((entry) => isChatTurn(entry));
  }

  if (isChatBatch(value[0])) {
    return value.every((entry) => isChatBatch(entry));
  }

  return false;
}

function isPlanChatMapCollection(value: unknown): value is BeamPlanChatMap[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => isPlanChatMap(entry))
  );
}

function isPlanChatMap(value: unknown): value is BeamPlanChatMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(
    (batches) =>
      batches === null ||
      (Array.isArray(batches) && batches.every((batch) => isPlanChatBatch(batch))),
  );
}

function isPlanChatBatch(value: unknown): value is BeamPlanChatBatch {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ((value as BeamPlanChatBatch).turns === undefined ||
      isChatCollection((value as BeamPlanChatBatch).turns))
  );
}

function isChatBatch(value: unknown): value is BeamChatTurn[] {
  return Array.isArray(value) && value.every((entry) => isChatTurn(entry));
}

function isChatTurn(value: unknown): value is BeamChatTurn {
  return !!value && typeof value === "object" && typeof (value as BeamChatTurn).content === "string";
}

function isQuestionMap(value: unknown): value is BeamQuestionMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (questions) =>
      Array.isArray(questions) &&
      questions.every(
        (question) =>
          !!question &&
          typeof question === "object" &&
          typeof (question as BeamQuestion).question === "string",
      ),
  );
}

function isValidPlans(value: unknown): value is BeamPlan[] {
  return (
    Array.isArray(value) &&
    value.every(
      (plan) =>
        !!plan &&
        typeof plan === "object" &&
        (plan.chat === undefined ||
          isChatCollection(plan.chat) ||
          isPlanChatMapCollection(plan.chat)),
    )
  );
}

function normalizeQuestionMap(raw: BeamConversation["probing_questions"]): BeamQuestionMap {
  if (typeof raw !== "string") {
    return raw;
  }

  const parsed = parseStructuredLiteral(raw);
  if (!isQuestionMap(parsed)) {
    throw new Error("BEAM probing_questions did not parse into a valid question map.");
  }
  return parsed;
}

function collectSessions(
  conversation: BeamConversation,
  scale: string,
): BeamSession[] {
  const conversationId = String(conversation.conversation_id);
  const sessions: BeamSession[] = [];

  if (isPlanChatMapCollection(conversation.chat)) {
    flattenPlanChatMapCollection(conversation.chat).forEach((batch) => {
      sessions.push({
        sessionId:
          `beam-${scale}-${conversationId}-main-${batch.planId}-${batch.mapIndex + 1}-${batch.batchIndex + 1}-${batch.turnBatchIndex + 1}`,
        messages: buildMessages(batch.turns),
      });
    });
  } else {
    flattenChatCollection(conversation.chat).forEach((batch, batchIndex) => {
      sessions.push({
        sessionId: `beam-${scale}-${conversationId}-main-${batchIndex + 1}`,
        messages: buildMessages(batch),
      });
    });
  }

  (conversation.plans ?? []).forEach((plan, planIndex) => {
    if (!plan.chat) {
      return;
    }

    if (isPlanChatMapCollection(plan.chat)) {
      flattenPlanChatMapCollection(plan.chat).forEach((batch) => {
        sessions.push({
          sessionId:
            `beam-${scale}-${conversationId}-plan-${String(plan.plan_id ?? planIndex)}-${batch.planId}-${batch.mapIndex + 1}-${batch.batchIndex + 1}-${batch.turnBatchIndex + 1}`,
          messages: buildMessages(batch.turns),
        });
      });
      return;
    }

    flattenChatCollection(plan.chat).forEach((batch, batchIndex) => {
      sessions.push({
        sessionId:
          `beam-${scale}-${conversationId}-plan-${String(plan.plan_id ?? planIndex)}-${batchIndex + 1}`,
        messages: buildMessages(batch),
      });
    });
  });

  return sessions;
}

function flattenChatCollection(
  chat: BeamChatTurn[][] | BeamChatTurn[],
): BeamChatTurn[][] {
  if (chat.length === 0) {
    return [];
  }
  return isChatTurn(chat[0]) ? [chat as BeamChatTurn[]] : (chat as BeamChatTurn[][]);
}

function flattenPlanChatMapCollection(
  chat: BeamPlanChatMap[],
): Array<{
  planId: string;
  mapIndex: number;
  batchIndex: number;
  turnBatchIndex: number;
  turns: BeamChatTurn[];
}> {
  const batches: Array<{
    planId: string;
    mapIndex: number;
    batchIndex: number;
    turnBatchIndex: number;
    turns: BeamChatTurn[];
  }> = [];

  chat.forEach((planMap, mapIndex) => {
    Object.keys(planMap)
      .sort(comparePlanIds)
      .forEach((planId) => {
        const planBatches = planMap[planId];
        if (!planBatches) {
          return;
        }

        planBatches.forEach((batch, batchIndex) => {
          if (!batch.turns) {
            return;
          }

          flattenChatCollection(batch.turns).forEach((turns, turnBatchIndex) => {
            batches.push({
              planId,
              mapIndex,
              batchIndex,
              turnBatchIndex,
              turns,
            });
          });
        });
      });
  });

  return batches;
}

function comparePlanIds(left: string, right: string): number {
  const leftNumber = Number(left.match(/\d+/)?.[0] ?? Number.NaN);
  const rightNumber = Number(right.match(/\d+/)?.[0] ?? Number.NaN);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    const numberDelta = leftNumber - rightNumber;
    if (numberDelta !== 0) {
      return numberDelta;
    }
  }
  return left.localeCompare(right);
}

function buildMessages(turns: BeamChatTurn[]): Message[] {
  return turns.map((turn) => ({
    role: normalizeRole(turn.role),
    content: turn.content,
  }));
}

function normalizeRole(role: string): Message["role"] {
  if (role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}

function buildExpectedAnswer(question: BeamQuestion): string {
  for (const candidate of [
    question.ideal_response,
    question.ideal_answer,
    question.ideal_summary,
    question.answer,
    question.instruction_being_tested,
    question.preference_being_tested,
    question.expected_compliance,
  ]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  const rubricTargets = normalizeRubricTargets(question.rubric);
  if (rubricTargets.length > 0) {
    return rubricTargets.join(" ");
  }

  return question.question;
}

function normalizeRubricTargets(rubric: BeamQuestion["rubric"]): string[] {
  if (!Array.isArray(rubric)) {
    return [];
  }

  return rubric
    .map((item) => {
      if (typeof item !== "string") {
        return "";
      }
      return item.replace(/^LLM response should (?:contain|state|mention):\s*/i, "").trim();
    })
    .filter((item) => item.length > 0);
}

function computeRubricCoverage(actual: string, rubricTargets: string[]): number {
  if (rubricTargets.length === 0) {
    return 0;
  }

  const matches = rubricTargets.filter((target) => rubricTargetMatches(actual, target)).length;
  return matches / rubricTargets.length;
}

function rubricTargetMatches(actual: string, target: string): boolean {
  if (containsAnswer(actual, target) === 1) {
    return true;
  }

  const actualTokens = new Set(tokenizeRubricText(actual));
  const targetTokens = tokenizeRubricText(target);
  return (
    targetTokens.length > 0 &&
    targetTokens.every((token) => actualTokens.has(token))
  );
}

function tokenizeRubricText(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map(stemRubricToken);
}

function stemRubricToken(token: string): string {
  if (token.endsWith("ing") && token.length > 5) {
    return token.slice(0, -3);
  }
  if (token.endsWith("ed") && token.length > 4) {
    return token.slice(0, -2);
  }
  return token;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `BEAM limit must be a non-negative integer when provided; received ${limit}.`,
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

function parseStructuredLiteral(input: string): unknown {
  const parser = new StructuredLiteralParser(input);
  const result = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.isDone()) {
    throw new Error("Unexpected trailing content in BEAM probing_questions literal.");
  }
  return result;
}

class StructuredLiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parseValue(): unknown {
    this.skipWhitespace();
    const current = this.peek();

    if (current === "{") {
      return this.parseObject();
    }
    if (current === "[") {
      return this.parseArray();
    }
    if (current === "'" || current === "\"") {
      return this.parseString();
    }
    if (current === "-" || this.isDigit(current)) {
      return this.parseNumber();
    }
    return this.parseKeyword();
  }

  skipWhitespace(): void {
    while (!this.isDone() && /\s/.test(this.peek())) {
      this.index += 1;
    }
  }

  isDone(): boolean {
    return this.index >= this.source.length;
  }

  private parseObject(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.expect("{");
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.index += 1;
      return result;
    }

    while (!this.isDone()) {
      const keyValue = this.parseValue();
      if (typeof keyValue !== "string") {
        throw new Error("BEAM probing_questions object keys must be strings.");
      }
      this.skipWhitespace();
      this.expect(":");
      const value = this.parseValue();
      result[keyValue] = value;
      this.skipWhitespace();
      const current = this.peek();
      if (current === "}") {
        this.index += 1;
        return result;
      }
      this.expect(",");
    }

    throw new Error("Unterminated object literal in BEAM probing_questions.");
  }

  private parseArray(): unknown[] {
    const result: unknown[] = [];
    this.expect("[");
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.index += 1;
      return result;
    }

    while (!this.isDone()) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const current = this.peek();
      if (current === "]") {
        this.index += 1;
        return result;
      }
      this.expect(",");
    }

    throw new Error("Unterminated array literal in BEAM probing_questions.");
  }

  private parseString(): string {
    const quote = this.peek();
    this.index += 1;
    let result = "";

    while (!this.isDone()) {
      const current = this.peek();
      this.index += 1;

      if (current === "\\") {
        if (this.isDone()) {
          throw new Error("Invalid escape sequence in BEAM probing_questions.");
        }
        const escaped = this.peek();
        this.index += 1;
        result += this.decodeEscape(escaped);
        continue;
      }

      if (current === quote) {
        return result;
      }

      result += current;
    }

    throw new Error("Unterminated string literal in BEAM probing_questions.");
  }

  private parseNumber(): number {
    const start = this.index;
    if (this.peek() === "-") {
      this.index += 1;
    }
    while (this.isDigit(this.peek())) {
      this.index += 1;
    }
    if (this.peek() === ".") {
      this.index += 1;
      while (this.isDigit(this.peek())) {
        this.index += 1;
      }
    }
    const raw = this.source.slice(start, this.index);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid numeric literal "${raw}" in BEAM probing_questions.`);
    }
    return parsed;
  }

  private parseKeyword(): unknown {
    const start = this.index;
    while (!this.isDone() && /[A-Za-z_]/.test(this.peek())) {
      this.index += 1;
    }
    const keyword = this.source.slice(start, this.index);
    switch (keyword) {
      case "True":
      case "true":
        return true;
      case "False":
      case "false":
        return false;
      case "None":
      case "null":
        return null;
      default:
        throw new Error(`Unsupported keyword "${keyword}" in BEAM probing_questions.`);
    }
  }

  private decodeEscape(value: string): string {
    switch (value) {
      case "'":
      case "\"":
      case "\\":
        return value;
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new Error("Invalid unicode escape in BEAM probing_questions.");
        }
        this.index += 4;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      default:
        return value;
    }
  }

  private expect(expected: string): void {
    this.skipWhitespace();
    if (this.peek() !== expected) {
      throw new Error(
        `Expected "${expected}" in BEAM probing_questions but found "${this.peek()}".`,
      );
    }
    this.index += 1;
  }

  private peek(): string {
    return this.source[this.index] ?? "";
  }

  private isDigit(value: string): boolean {
    return value >= "0" && value <= "9";
  }
}
