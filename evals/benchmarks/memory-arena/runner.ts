/**
 * MemoryArena runner — interdependent agentic memory tasks.
 *
 * Tests multi-step flows: store → update → cross-reference → recall.
 * Each task builds on prior stored context, exercising temporal ordering
 * and cross-session references.
 *
 * Dataset: https://github.com/shenzhi-wang/MemoryArena
 * Citation: MemoryArena: Evaluating Memory in Agentic AI Systems (2024)
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
import { f1Score, containsAnswer, exactMatch, aggregateScores, timed } from "../../scorer.js";
import { enrichResult } from "../../reporter.js";

interface ArenaStep {
  action: "store" | "update" | "query";
  session_id?: string;
  content?: string;
  query?: string;
  expected_answer?: string;
  depends_on?: string[];
}

interface ArenaTask {
  id: string;
  description: string;
  steps: ArenaStep[];
  category?: string;
}

async function loadDataset(datasetDir: string, limit?: number): Promise<ArenaTask[]> {
  try {
    const raw = await readFile(path.join(datasetDir, "arena-tasks.json"), "utf-8");
    const data = JSON.parse(raw);
    const tasks: ArenaTask[] = Array.isArray(data) ? data : data.tasks ?? [];
    return limit ? tasks.slice(0, limit) : tasks;
  } catch {
    // Try individual task files
    try {
      const tasksDir = path.join(datasetDir, "tasks");
      let files = (await readdir(tasksDir)).filter((f) => f.endsWith(".json")).sort();
      if (limit) files = files.slice(0, limit);
      const tasks: ArenaTask[] = [];
      for (const file of files) {
        const raw = await readFile(path.join(tasksDir, file), "utf-8");
        tasks.push(JSON.parse(raw));
      }
      return tasks;
    } catch {
      throw new Error(
        `MemoryArena dataset not found at ${datasetDir}. Run: bash evals/scripts/download-datasets.sh --benchmark memory-arena`,
      );
    }
  }
}

const meta: BenchmarkMeta = {
  name: "memory-arena",
  version: "1.0.0",
  description: "Interdependent agentic memory tasks — store, update, cross-reference, recall",
  category: "agentic",
  citation: "MemoryArena: Evaluating Memory in Agentic AI Systems (2024)",
};

async function run(
  system: MemorySystem,
  options: { limit?: number; datasetDir: string },
): Promise<BenchmarkResult> {
  const tasks = await loadDataset(options.datasetDir, options.limit);
  const scores: TaskScore[] = [];
  const overallStart = performance.now();

  for (const task of tasks) {
    await system.reset();
    const defaultSessionId = `arena-${task.id}`;

    for (let stepIdx = 0; stepIdx < task.steps.length; stepIdx++) {
      const step = task.steps[stepIdx];
      const sessionId = step.session_id ?? defaultSessionId;
      const stepId = `${task.id}-step${stepIdx}`;

      if (step.action === "store" && step.content) {
        await system.store(sessionId, [
          { role: "user", content: step.content },
        ]);
      } else if (step.action === "update" && step.content) {
        // Updates are stores with newer info that should supersede prior facts
        await system.store(sessionId, [
          { role: "user", content: `[UPDATE] ${step.content}` },
        ]);
      } else if (step.action === "query" && step.query && step.expected_answer) {
        const { result: recallText, durationMs } = await timed(() =>
          system.recall(sessionId, step.query!),
        );

        const f1 = f1Score(recallText, step.expected_answer!);
        const contains = containsAnswer(recallText, step.expected_answer!);
        const exact = exactMatch(recallText, step.expected_answer!);
        const hasCrossRef = step.depends_on && step.depends_on.length > 0 ? 1.0 : 0.0;

        scores.push({
          taskId: stepId,
          metrics: {
            f1,
            contains_answer: contains,
            exact_match: exact,
            is_cross_reference: hasCrossRef,
          },
          details: {
            query: step.query,
            expected: step.expected_answer,
            recalled_length: recallText.length,
            depends_on: step.depends_on,
            category: task.category,
          },
          latencyMs: durationMs,
        });
      }
    }
  }

  const durationMs = Math.round(performance.now() - overallStart);

  // Compute cross-reference specific aggregate
  const crossRefScores = scores.filter((s) => s.metrics.is_cross_reference === 1.0);
  const baseAggregate = aggregateScores(scores.map((s) => s.metrics));

  if (crossRefScores.length > 0) {
    const crossRefF1s = crossRefScores.map((s) => s.metrics.f1);
    baseAggregate.cross_reference_f1_mean =
      crossRefF1s.reduce((a, b) => a + b, 0) / crossRefF1s.length;
  }

  return enrichResult({
    meta,
    engramVersion: "",
    gitSha: "",
    timestamp: "",
    adapterMode: "direct",
    taskCount: scores.length,
    scores,
    aggregate: baseAggregate,
    config: {
      limit: options.limit,
      datasetDir: options.datasetDir,
    },
    durationMs,
  });
}

export const memoryArenaRunner: BenchmarkRunner = { meta, run };
