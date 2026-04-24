/**
 * LongMemEval runner migrated into @remnic/bench for phase 1.
 *
 * As of issue #566 PR 2/7, the per-item lifecycle (reset → ingest →
 * recall → answer → judge → score) lives in `../harness.ts`. This
 * module only knows about dataset loading + how to translate a
 * `LongMemEvalItem` into a `HarnessPlan`.
 */

import { type LongMemEvalItem } from "./fixture.js";
import {
  LONG_MEM_EVAL_DATASET_FILENAMES,
  formatMissingDatasetError,
  loadLongMemEvalS,
} from "../dataset-loader.js";
import type { Message } from "../../../adapters/types.js";
import {
  runPublishedHarness,
  type HarnessPlan,
  type HarnessTrial,
} from "../harness.js";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";

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
  const dataset = await loadDataset(
    options.mode,
    options.datasetDir,
    options.limit,
  );

  const plans: HarnessPlan[] = dataset.map((item) => buildPlan(item, options));

  return runPublishedHarness({
    options,
    metricsSpec: {
      metrics: ["f1", "contains_answer", "llm_judge"],
    },
    plans,
    totalCount: plans.reduce((sum, plan) => sum + plan.trials.length, 0),
  });
}

function buildPlan(
  item: LongMemEvalItem,
  options: ResolvedRunBenchmarkOptions,
): HarnessPlan {
  const ingestSessions: HarnessPlan["ingestSessions"] = [];
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
    ingestSessions.push({ sessionId, messages });
  }

  const trial: HarnessTrial = {
    taskId: `q${item.question_id}`,
    question: item.question,
    expected: item.answer,
    recallSessionIds: sessionIds,
    extraDetails: {
      questionType: item.question_type,
      questionDate: item.question_date,
      haystackDates: item.haystack_dates,
      haystackSessionIds: item.haystack_session_ids,
      answerSessionIds: item.answer_session_ids,
    },
    postAnswerHook: async ({ question }) => {
      const searchResults = await options.system.search(question, 10);
      return { extraScores: { search_hits: searchResults.length } };
    },
  };

  return { ingestSessions, trials: [trial] };
}

async function loadDataset(
  mode: "full" | "quick",
  datasetDir: string | undefined,
  limit?: number,
): Promise<LongMemEvalItem[]> {
  const loaded = await loadLongMemEvalS({ mode, datasetDir, limit });

  if (loaded.source === "missing") {
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
    // eslint-disable-next-line no-console
    console.warn(
      "[remnic-bench] LongMemEval falling back to smoke fixture: " +
        loaded.errors.join(" | "),
    );
  }

  return loaded.items;
}
