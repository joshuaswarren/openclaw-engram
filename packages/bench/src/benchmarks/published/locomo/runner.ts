/**
 * LoCoMo runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import type { Message } from "../../../adapters/types.js";
import { answerBenchmarkQuestion } from "../../../answering.js";
import {
  type LoCoMoConversation,
  type LoCoMoQA,
  type LoCoMoTurn,
} from "./fixture.js";
import {
  LOCOMO_DATASET_FILENAMES,
  formatMissingDatasetError,
  loadLoCoMo10,
  normalizeLoCoMoQa,
} from "../dataset-loader.js";
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

const CATEGORY_NAMES: Record<number, string> = {
  1: "single_hop",
  2: "multi_hop",
  3: "temporal",
  4: "open_domain",
  5: "adversarial",
};

/** Extract sessions from the conversation dict as ordered (sessionId, turns) pairs. */
function extractSessions(
  conversation: Record<string, unknown>,
): Array<{ sessionId: string; turns: LoCoMoTurn[] }> {
  const sessions: Array<{ sessionId: string; turns: LoCoMoTurn[] }> = [];
  const sessionKeys = Object.keys(conversation)
    .filter(
      (key) =>
        /^session_\d+$/.test(key) && Array.isArray(conversation[key]),
    )
    .sort((a, b) => {
      const leftIndex = Number.parseInt(a.replace("session_", ""), 10);
      const rightIndex = Number.parseInt(b.replace("session_", ""), 10);
      return leftIndex - rightIndex;
    });

  for (const key of sessionKeys) {
    sessions.push({
      sessionId: key,
      turns: conversation[key] as LoCoMoTurn[],
    });
  }
  return sessions;
}

function buildMessages(
  turns: LoCoMoTurn[],
  speakerA: string,
): Message[] {
  return turns.map((turn) => ({
    role: turn.speaker === speakerA ? "user" : "assistant",
    content: turn.text,
  }));
}

export const locomoDefinition: BenchmarkDefinition = {
  id: "locomo",
  title: "LoCoMo",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "locomo",
    version: "2.0.0",
    description:
      "Long conversation memory benchmark across multi-session dialogue transcripts and QA probes.",
    category: "conversational",
    citation:
      "Maharana et al. Evaluating Very Long-Term Conversational Memory of LLM Agents. ACL 2024.",
  },
};

export async function runLoCoMoBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const conversations = await loadDataset(
    options.mode,
    options.datasetDir,
    options.limit,
  );
  const tasks: TaskResult[] = [];

  for (const conversation of conversations) {
    await options.system.reset();

    const sessions = extractSessions(conversation.conversation);
    const speakerA =
      typeof conversation.conversation.speaker_a === "string"
        ? conversation.conversation.speaker_a
        : "Speaker A";
    const sessionIds: string[] = [];

    for (const session of sessions) {
      const sessionId = `${conversation.sample_id}-${session.sessionId}`;
      const messages = buildMessages(session.turns, speakerA);
      sessionIds.push(sessionId);
      if (messages.length > 0) {
        await options.system.store(sessionId, messages);
      }
    }

    for (
      let questionIndex = 0;
      questionIndex < conversation.qa.length;
      questionIndex += 1
    ) {
      const qa = conversation.qa[questionIndex]!;
      const categoryName =
        CATEGORY_NAMES[qa.category] ?? `category_${qa.category}`;
      const { result: recalledText, durationMs } = await timed(async () => {
        const recalledSessions = await Promise.all(
          sessionIds.map((sessionId) =>
            options.system.recall(sessionId, qa.question),
          ),
        );
        return recalledSessions.filter(Boolean).join("\n\n");
      });
      const answered = await answerBenchmarkQuestion({
        question: qa.question,
        recalledText,
        responder: options.system.responder,
      });
      const judgeResult = await llmJudgeScoreDetailed(
        options.system.judge,
        qa.question,
        answered.finalAnswer,
        qa.answer,
      );

      const scores: Record<string, number> = {
        f1: f1Score(answered.finalAnswer, qa.answer),
        contains_answer: containsAnswer(answered.finalAnswer, qa.answer),
        rouge_l: rougeL(answered.finalAnswer, qa.answer),
      };
      if (judgeResult.score >= 0) {
        scores.llm_judge = judgeResult.score;
      }

      tasks.push({
        taskId: `${conversation.sample_id}-q${questionIndex}-${categoryName}`,
        question: qa.question,
        expected: qa.answer,
        actual: answered.finalAnswer,
        scores,
        latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
        tokens: {
          input: answered.tokens.input + judgeResult.tokens.input,
          output: answered.tokens.output + judgeResult.tokens.output,
        },
        details: {
          category: qa.category,
          categoryName,
          evidence: qa.evidence,
          conversationId: conversation.sample_id,
          sessionIds,
          recalledLength: recalledText.length,
          answeredLength: answered.finalAnswer.length,
          recalledText,
          answeredText: answered.finalAnswer,
          responderModel: answered.model,
          judgeModel: judgeResult.model,
        },
      });
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
): Promise<LoCoMoConversation[]> {
  // Limit normalization happens inside `loadLoCoMo10`; do not re-validate
  // here (the shared loader's `normalizeLimit` is the single source of
  // truth).
  const loaded = await loadLoCoMo10({
    mode,
    datasetDir,
    limit,
    parseFile: parseDataset,
  });

  if (loaded.source === "missing") {
    // `loaded.source === "missing"` implies `mode === "full"` — the
    // shared loader only returns `missing` in that branch. Keep the
    // inner check + the historical "no datasetDir" message for clarity
    // and backward-compat with regression tests; if the loader contract
    // ever changes, this branch still fails safely.
    if (!datasetDir) {
      throw new Error(
        "LoCoMo full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
      );
    }
    throw new Error(
      formatMissingDatasetError(
        "locomo",
        datasetDir,
        LOCOMO_DATASET_FILENAMES,
        loaded.errors,
      ),
    );
  }

  if (loaded.items.length === 0) {
    throw new Error(
      "LoCoMo dataset is empty after applying the requested limit.",
    );
  }

  if (loaded.source === "smoke" && loaded.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[remnic-bench] LoCoMo falling back to smoke fixture: " +
        loaded.errors.join(" | "),
    );
  }

  return loaded.items;
}

function parseDataset(
  raw: string,
  filename: string,
): LoCoMoConversation[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `LoCoMo dataset file ${filename} must contain an array of conversations.`,
    );
  }

  return parsed.map((entry, index) => parseConversation(entry, filename, index));
}

function parseConversation(
  entry: unknown,
  filename: string,
  index: number,
): LoCoMoConversation {
  const location = `LoCoMo dataset file ${filename} conversation ${index + 1}`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${location} must be an object.`);
  }

  const record = entry as Record<string, unknown>;
  if (typeof record.sample_id !== "string") {
    throw new Error(`${location} must include a string sample_id.`);
  }
  if (
    !record.conversation ||
    typeof record.conversation !== "object" ||
    Array.isArray(record.conversation)
  ) {
    throw new Error(`${location} must include a conversation object.`);
  }
  const qa = normalizeQaArray(record.qa, location);

  return {
    sample_id: record.sample_id,
    conversation: record.conversation as Record<string, unknown>,
    qa,
    event_summary: record.event_summary,
    observation: record.observation,
    session_summary: record.session_summary,
  };
}

function normalizeQaArray(value: unknown, location: string): LoCoMoQA[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `${location} must include a qa array with question/answer/evidence/category fields.`,
    );
  }

  return value.map((entry, index) =>
    normalizeLoCoMoQa(entry, `${location} qa[${index}]`),
  );
}

