/**
 * LongMemEval runner — long-term memory evaluation for chat assistants.
 *
 * Tests retrieval across categories: single-session, cross-session, temporal reasoning.
 * Feeds conversation history, then probes with factual questions.
 *
 * Dataset: https://huggingface.co/datasets/dt-research-group/LongMemEval
 * Citation: LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory (ICLR 2025)
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

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  session_id?: string;
  timestamp?: string;
}

interface LongMemQuery {
  query: string;
  expected_answer: string;
  evidence_turns?: number[];
  category: "single_session" | "cross_session" | "temporal" | "knowledge_update";
}

interface LongMemTask {
  id: string;
  conversations: ConversationTurn[];
  queries: LongMemQuery[];
}

async function loadDataset(datasetDir: string, limit?: number): Promise<LongMemTask[]> {
  try {
    const raw = await readFile(path.join(datasetDir, "longmemeval.json"), "utf-8");
    const data = JSON.parse(raw);
    const tasks: LongMemTask[] = Array.isArray(data) ? data : data.tasks ?? [];
    return limit ? tasks.slice(0, limit) : tasks;
  } catch {
    try {
      const tasksDir = path.join(datasetDir, "tasks");
      let files = (await readdir(tasksDir)).filter((f) => f.endsWith(".json")).sort();
      if (limit) files = files.slice(0, limit);
      const tasks: LongMemTask[] = [];
      for (const file of files) {
        const raw = await readFile(path.join(tasksDir, file), "utf-8");
        tasks.push(JSON.parse(raw));
      }
      return tasks;
    } catch {
      throw new Error(
        `LongMemEval dataset not found at ${datasetDir}. Run: bash evals/scripts/download-datasets.sh --benchmark longmemeval`,
      );
    }
  }
}

const meta: BenchmarkMeta = {
  name: "longmemeval",
  version: "1.0.0",
  description: "Long-term memory evaluation — single/cross-session retrieval and temporal reasoning",
  category: "retrieval",
  citation: "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory (ICLR 2025)",
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

    // Phase 1: Ingest conversations, respecting session boundaries
    const sessionBatches = new Map<string, ConversationTurn[]>();
    for (const turn of task.conversations) {
      const sid = turn.session_id ?? `longmem-${task.id}`;
      if (!sessionBatches.has(sid)) sessionBatches.set(sid, []);
      sessionBatches.get(sid)!.push(turn);
    }

    for (const [sessionId, turns] of sessionBatches) {
      const messages = turns.map((t) => ({
        role: t.role,
        content: t.content,
      }));
      await system.store(sessionId, messages);
    }

    // Phase 2: Query across stored sessions
    const sessionIds = [...sessionBatches.keys()];
    for (const q of task.queries) {
      const queryId = `${task.id}-${q.category}-${q.query.slice(0, 25).replace(/\s+/g, "_")}`;

      // Recall from all sessions and concatenate results
      const { result: recallText, durationMs } = await timed(async () => {
        const parts: string[] = [];
        for (const sid of sessionIds) {
          const r = await system.recall(sid, q.query);
          if (r) parts.push(r);
        }
        return parts.join("\n\n");
      });

      // Search globally (no session filter) to test cross-session FTS
      const searchResults = await system.search(q.query, 5);
      const searchHits = searchResults.length;

      const f1 = f1Score(recallText, q.expected_answer);
      const contains = containsAnswer(recallText, q.expected_answer);

      scores.push({
        taskId: queryId,
        metrics: {
          f1,
          contains_answer: contains,
          search_hits: searchHits,
        },
        details: {
          query: q.query,
          expected: q.expected_answer,
          category: q.category,
          evidence_turns: q.evidence_turns,
          recalled_length: recallText.length,
        },
        latencyMs: durationMs,
      });
    }
  }

  const durationMs = Math.round(performance.now() - overallStart);

  // Category-specific aggregates
  const aggregate = aggregateScores(scores.map((s) => s.metrics));
  const categories = ["single_session", "cross_session", "temporal", "knowledge_update"];
  for (const cat of categories) {
    const catScores = scores.filter((s) => (s.details as any)?.category === cat);
    if (catScores.length > 0) {
      const catF1s = catScores.map((s) => s.metrics.f1);
      aggregate[`${cat}_f1_mean`] = catF1s.reduce((a, b) => a + b, 0) / catF1s.length;
    }
  }

  return enrichResult({
    meta,
    engramVersion: "",
    gitSha: "",
    timestamp: "",
    adapterMode: "direct",
    taskCount: scores.length,
    scores,
    aggregate,
    config: {
      limit: options.limit,
      datasetDir: options.datasetDir,
    },
    durationMs,
  });
}

export const longMemEvalRunner: BenchmarkRunner = { meta, run };
