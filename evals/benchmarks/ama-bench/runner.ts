/**
 * AMA-Bench runner — Agent Memory Abilities benchmark.
 *
 * Tests a 2-function memory interface: memorize(text) + recall(query) → text
 * Evaluates: recall accuracy, hallucination rate, session-boundary handling.
 *
 * Dataset: https://github.com/tongxin97/AMA-Bench
 * Citation: AMA-Bench (2024) — Evaluating agent memory abilities
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  BenchmarkRunner,
  BenchmarkResult,
  BenchmarkMeta,
  MemorySystem,
  TaskScore,
} from "../../adapter/types.js";
import { f1Score, containsAnswer, aggregateScores, timed } from "../../scorer.js";
import { enrichResult } from "../../reporter.js";

interface AmaTask {
  id: string;
  session_id: string;
  memorize_texts: string[];
  queries: Array<{
    query: string;
    expected_answer: string;
    category?: string;
  }>;
}

async function loadDataset(datasetDir: string, limit?: number): Promise<AmaTask[]> {
  const tasksDir = path.join(datasetDir, "tasks");
  let files: string[];
  try {
    files = (await readdir(tasksDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    // Fallback: single consolidated file
    try {
      const raw = await readFile(path.join(datasetDir, "ama-bench.json"), "utf-8");
      const data = JSON.parse(raw);
      const tasks = Array.isArray(data) ? data : data.tasks ?? [];
      return limit ? tasks.slice(0, limit) : tasks;
    } catch {
      throw new Error(
        `AMA-Bench dataset not found at ${datasetDir}. Run: bash evals/scripts/download-datasets.sh --benchmark ama-bench`,
      );
    }
  }

  if (limit) files = files.slice(0, limit);

  const tasks: AmaTask[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(tasksDir, file), "utf-8");
    tasks.push(JSON.parse(raw));
  }
  return tasks;
}

const meta: BenchmarkMeta = {
  name: "ama-bench",
  version: "1.0.0",
  description: "Agent Memory Abilities — 2-function memorize/recall interface",
  category: "agentic",
  citation: "AMA-Bench: Evaluating Agent Memory Abilities (2024)",
};

async function run(
  system: MemorySystem,
  options: { limit?: number; datasetDir: string },
): Promise<BenchmarkResult> {
  const tasks = await loadDataset(options.datasetDir, options.limit);
  const scores: TaskScore[] = [];
  const overallStart = performance.now();

  for (const task of tasks) {
    const sessionId = `ama-${task.id}`;
    await system.reset();

    // Phase 1: Memorize — feed all texts into memory
    const memorizeMessages = task.memorize_texts.map((text, i) => ({
      role: "user" as const,
      content: text,
    }));
    await system.store(sessionId, memorizeMessages);

    // Phase 2: Recall — query and score each
    for (const q of task.queries) {
      const queryId = `${task.id}-${q.query.slice(0, 30).replace(/\s+/g, "_")}`;
      const { result: recallText, durationMs } = await timed(() =>
        system.recall(sessionId, q.query),
      );

      const f1 = f1Score(recallText, q.expected_answer);
      const contains = containsAnswer(recallText, q.expected_answer);
      // Hallucination proxy: low F1 but non-empty response
      const hallucination = recallText.length > 10 && f1 < 0.1 ? 1.0 : 0.0;

      scores.push({
        taskId: queryId,
        metrics: {
          f1,
          contains_answer: contains,
          hallucination,
        },
        details: {
          query: q.query,
          expected: q.expected_answer,
          recalled_length: recallText.length,
          category: q.category,
        },
        latencyMs: durationMs,
      });
    }
  }

  const durationMs = Math.round(performance.now() - overallStart);

  return enrichResult({
    meta,
    engramVersion: "",
    gitSha: "",
    timestamp: "",
    adapterMode: "direct",
    taskCount: scores.length,
    scores,
    aggregate: aggregateScores(scores.map((s) => s.metrics)),
    config: {
      limit: options.limit,
      datasetDir: options.datasetDir,
    },
    durationMs,
  });
}

export const amaBenchRunner: BenchmarkRunner = { meta, run };
