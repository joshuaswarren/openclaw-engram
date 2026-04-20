/**
 * LongMemEval runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { type LongMemEvalItem } from "./fixture.js";
import {
  LONG_MEM_EVAL_DATASET_FILENAMES,
  formatMissingDatasetError,
  loadLongMemEvalS,
} from "../dataset-loader.js";
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

export const longMemEvalDefinition: BenchmarkDefinition = {
  id: "longmemeval",
  title: "LongMemEval",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "longmemeval",
    version: "2.0.0",
    description:
      "Long-term memory evaluation across information extraction, multi-session reasoning, temporal reasoning, and knowledge updates.",
    category: "retrieval",
    citation:
      "Wu et al. LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory. ICLR 2025.",
  },
};

export async function runLongMemEvalBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const dataset = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];

  for (const item of dataset) {
    await options.system.reset();

    const sessionIds: string[] = [];
    for (
      let sessionIndex = 0;
      sessionIndex < item.haystack_sessions.length;
      sessionIndex += 1
    ) {
      const sessionId =
        item.haystack_session_ids[sessionIndex] ?? `session-${sessionIndex}`;
      const messages = item.haystack_sessions[sessionIndex]!.map<Message>(
        (turn) => ({
          role: turn.role,
          content: turn.content,
        }),
      );

      sessionIds.push(sessionId);
      if (messages.length > 0) {
        await options.system.store(sessionId, messages);
      }
    }

    const { result: recalledText, durationMs } = await timed(async () => {
      const recalledSessions = await Promise.all(
        sessionIds.map((sessionId) =>
          options.system.recall(sessionId, item.question),
        ),
      );
      return recalledSessions.filter(Boolean).join("\n\n");
    });
    const answered = await answerBenchmarkQuestion({
      question: item.question,
      recalledText,
      responder: options.system.responder,
    });

    const searchResults = await options.system.search(item.question, 10);
    const judgeResult = await llmJudgeScoreDetailed(
      options.system.judge,
      item.question,
      answered.finalAnswer,
      item.answer,
    );

    const scores: Record<string, number> = {
      f1: f1Score(answered.finalAnswer, item.answer),
      contains_answer: containsAnswer(answered.finalAnswer, item.answer),
      search_hits: searchResults.length,
    };
    if (judgeResult.score >= 0) {
      scores.llm_judge = judgeResult.score;
    }

    tasks.push({
      taskId: `q${item.question_id}`,
      question: item.question,
      expected: item.answer,
      actual: answered.finalAnswer,
      scores,
      latencyMs: durationMs + answered.latencyMs + judgeResult.latencyMs,
      tokens: {
        input: answered.tokens.input + judgeResult.tokens.input,
        output: answered.tokens.output + judgeResult.tokens.output,
      },
      details: {
        questionType: item.question_type,
        questionDate: item.question_date,
        haystackDates: item.haystack_dates,
        haystackSessionIds: item.haystack_session_ids,
        answerSessionIds: item.answer_session_ids,
        recalledLength: recalledText.length,
        answeredLength: answered.finalAnswer.length,
        recalledText,
        answeredText: answered.finalAnswer,
        responderModel: answered.model,
        judgeModel: judgeResult.model,
      },
    });
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const totalInputTokens = tasks.reduce(
    (sum, task) => sum + task.tokens.input,
    0,
  );
  const totalOutputTokens = tasks.reduce(
    (sum, task) => sum + task.tokens.output,
    0,
  );

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
): Promise<LongMemEvalItem[]> {
  const loaded = await loadLongMemEvalS({ mode, datasetDir, limit });

  if (loaded.source === "missing") {
    // `loaded.source === "missing"` implies `mode === "full"` — the
    // shared loader only returns `missing` in that branch. Keep the
    // inner `datasetDir` check for backward-compat with regression
    // tests that match the historical "full mode requires datasetDir"
    // message.
    if (!datasetDir) {
      throw new Error(
        "LongMemEval full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
      );
    }
    throw new Error(
      formatMissingDatasetError(
        "longmemeval",
        datasetDir,
        LONG_MEM_EVAL_DATASET_FILENAMES,
        loaded.errors,
      ),
    );
  }

  if (loaded.items.length === 0) {
    throw new Error(
      "LongMemEval dataset is empty after applying the requested limit.",
    );
  }

  if (loaded.source === "smoke" && loaded.errors.length > 0) {
    // Surface probe errors so operators understand why the smoke fixture
    // was used instead of the real dataset. Keep output minimal and only
    // emit when we actually tried to read a dataset directory.
    // eslint-disable-next-line no-console
    console.warn(
      "[remnic-bench] LongMemEval falling back to smoke fixture: " +
        loaded.errors.join(" | "),
    );
  }

  return loaded.items;
}
