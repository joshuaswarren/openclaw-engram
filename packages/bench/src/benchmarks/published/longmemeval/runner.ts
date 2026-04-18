/**
 * LongMemEval runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  LONG_MEM_EVAL_SMOKE_FIXTURE,
  type LongMemEvalItem,
} from "./fixture.js";
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
  llmJudgeScore,
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

    const searchResults = await options.system.search(item.question, 10);
    const judgeScore = await llmJudgeScore(
      options.system.judge,
      item.question,
      recalledText,
      item.answer,
    );

    const scores: Record<string, number> = {
      f1: f1Score(recalledText, item.answer),
      contains_answer: containsAnswer(recalledText, item.answer),
      search_hits: searchResults.length,
    };
    if (judgeScore >= 0) {
      scores.llm_judge = judgeScore;
    }

    tasks.push({
      taskId: `q${item.question_id}`,
      question: item.question,
      expected: item.answer,
      actual: recalledText,
      scores,
      latencyMs: durationMs,
      tokens: { input: 0, output: 0 },
      details: {
        questionType: item.question_type,
        questionDate: item.question_date,
        haystackDates: item.haystack_dates,
        haystackSessionIds: item.haystack_session_ids,
        answerSessionIds: item.answer_session_ids,
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
  if (datasetDir) {
    const datasetErrors: string[] = [];
    for (const filename of [
      "longmemeval_oracle.json",
      "longmemeval_s_cleaned.json",
      "longmemeval.json",
    ]) {
      try {
        const raw = await readFile(path.join(datasetDir, filename), "utf8");
        const parsed = JSON.parse(raw) as LongMemEvalItem[];
        return limit ? parsed.slice(0, limit) : parsed;
      } catch (error) {
        datasetErrors.push(
          `${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }

    throw new Error(
      `LongMemEval dataset not found under ${datasetDir}. Tried longmemeval_oracle.json, longmemeval_s_cleaned.json, and longmemeval.json. Errors: ${datasetErrors.join(" | ")}`,
    );
  }

  if (mode === "full") {
    throw new Error(
      "LongMemEval full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  const bundledFixture = limit
    ? LONG_MEM_EVAL_SMOKE_FIXTURE.slice(0, limit)
    : LONG_MEM_EVAL_SMOKE_FIXTURE;
  if (bundledFixture.length > 0) {
    return bundledFixture;
  }

  throw new Error("LongMemEval dataset not found and bundled smoke fixture is empty.");
}
