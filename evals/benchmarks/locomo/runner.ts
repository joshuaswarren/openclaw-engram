/**
 * LoCoMo runner — Long Conversation Memory benchmark.
 *
 * Tests memory over extended multi-turn dialogues. Feeds conversation
 * segments, then asks questions requiring long-range context recall.
 *
 * Dataset: https://huggingface.co/datasets/LoCoMo
 * Citation: LoCoMo: Long Conversation Memory for Language Models (2024)
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
import { f1Score, containsAnswer, rougeL, aggregateScores, timed } from "../../scorer.js";
import { enrichResult } from "../../reporter.js";

interface LoCoMoTurn {
  role: "user" | "assistant";
  content: string;
}

interface LoCoMoQuestion {
  question: string;
  answer: string;
  evidence_turn_indices?: number[];
  question_type?: "factual" | "temporal" | "summary" | "comparison";
}

interface LoCoMoTask {
  id: string;
  conversation: LoCoMoTurn[];
  questions: LoCoMoQuestion[];
}

async function loadDataset(datasetDir: string, limit?: number): Promise<LoCoMoTask[]> {
  try {
    const raw = await readFile(path.join(datasetDir, "locomo.json"), "utf-8");
    const data = JSON.parse(raw);
    const tasks: LoCoMoTask[] = Array.isArray(data) ? data : data.tasks ?? [];
    return limit ? tasks.slice(0, limit) : tasks;
  } catch {
    try {
      const tasksDir = path.join(datasetDir, "tasks");
      let files = (await readdir(tasksDir)).filter((f) => f.endsWith(".json")).sort();
      if (limit) files = files.slice(0, limit);
      const tasks: LoCoMoTask[] = [];
      for (const file of files) {
        const raw = await readFile(path.join(tasksDir, file), "utf-8");
        tasks.push(JSON.parse(raw));
      }
      return tasks;
    } catch {
      throw new Error(
        `LoCoMo dataset not found at ${datasetDir}. Run: bash evals/scripts/download-datasets.sh --benchmark locomo`,
      );
    }
  }
}

const meta: BenchmarkMeta = {
  name: "locomo",
  version: "1.0.0",
  description: "Long Conversation Memory — extended multi-turn dialogue recall",
  category: "conversational",
  citation: "LoCoMo: Long Conversation Memory for Language Models (2024)",
};

async function run(
  system: MemorySystem,
  options: { limit?: number; datasetDir: string },
): Promise<BenchmarkResult> {
  const tasks = await loadDataset(options.datasetDir, options.limit);
  const scores: TaskScore[] = [];
  const overallStart = performance.now();

  for (const task of tasks) {
    const sessionId = `locomo-${task.id}`;
    await system.reset();

    // Feed the full conversation in batches (simulate multi-turn)
    const batchSize = 20;
    for (let i = 0; i < task.conversation.length; i += batchSize) {
      const batch = task.conversation.slice(i, i + batchSize).map((t) => ({
        role: t.role,
        content: t.content,
      }));
      await system.store(sessionId, batch);
    }

    // Query phase
    for (const q of task.questions) {
      const queryId = `${task.id}-${q.question.slice(0, 25).replace(/\s+/g, "_")}`;

      const { result: recallText, durationMs } = await timed(() =>
        system.recall(sessionId, q.question),
      );

      const f1 = f1Score(recallText, q.answer);
      const contains = containsAnswer(recallText, q.answer);
      const rouge = rougeL(recallText, q.answer);

      // Evidence grounding: check if search finds the right turn indices
      let evidenceRecall = 1.0;
      if (q.evidence_turn_indices && q.evidence_turn_indices.length > 0) {
        const searchResults = await system.search(q.question, 10, sessionId);
        const retrievedTurns = new Set(searchResults.map((r) => r.turnIndex));
        const evidenceFound = q.evidence_turn_indices.filter((t) =>
          retrievedTurns.has(t),
        ).length;
        evidenceRecall = evidenceFound / q.evidence_turn_indices.length;
      }

      scores.push({
        taskId: queryId,
        metrics: {
          f1,
          contains_answer: contains,
          rouge_l: rouge,
          evidence_recall: evidenceRecall,
        },
        details: {
          question: q.question,
          expected: q.answer,
          question_type: q.question_type,
          recalled_length: recallText.length,
          conversation_length: task.conversation.length,
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

export const locomoRunner: BenchmarkRunner = { meta, run };
