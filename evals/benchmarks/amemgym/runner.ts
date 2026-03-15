/**
 * AMemGym runner — Agent Memory Gym for interactive personalization.
 *
 * Tests memory-driven personalization through simulated agent-user interactions.
 * The agent must remember user preferences and use them to personalize responses.
 *
 * Dataset: https://github.com/agiresearch/AMemGym
 * Citation: AMemGym: A Benchmark for Evaluating Agent Memory in Interactive Personalization (2024)
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

interface UserProfile {
  user_id: string;
  preferences: Record<string, string>;
  history: Array<{ role: string; content: string }>;
}

interface PersonalizationQuery {
  query: string;
  expected_answer: string;
  relevant_preferences: string[];
  difficulty?: "easy" | "medium" | "hard";
}

interface AmemGymTask {
  id: string;
  user_profile: UserProfile;
  queries: PersonalizationQuery[];
  category?: string;
}

async function loadDataset(datasetDir: string, limit?: number): Promise<AmemGymTask[]> {
  try {
    const raw = await readFile(path.join(datasetDir, "amemgym-tasks.json"), "utf-8");
    const data = JSON.parse(raw);
    const tasks: AmemGymTask[] = Array.isArray(data) ? data : data.tasks ?? [];
    return limit ? tasks.slice(0, limit) : tasks;
  } catch {
    try {
      const tasksDir = path.join(datasetDir, "tasks");
      let files = (await readdir(tasksDir)).filter((f) => f.endsWith(".json")).sort();
      if (limit) files = files.slice(0, limit);
      const tasks: AmemGymTask[] = [];
      for (const file of files) {
        const raw = await readFile(path.join(tasksDir, file), "utf-8");
        tasks.push(JSON.parse(raw));
      }
      return tasks;
    } catch {
      throw new Error(
        `AMemGym dataset not found at ${datasetDir}. Run: bash evals/scripts/download-datasets.sh --benchmark amemgym`,
      );
    }
  }
}

const meta: BenchmarkMeta = {
  name: "amemgym",
  version: "1.0.0",
  description: "Agent Memory Gym — interactive personalization via remembered preferences",
  category: "agentic",
  citation: "AMemGym: Evaluating Agent Memory in Interactive Personalization (2024)",
};

async function run(
  system: MemorySystem,
  options: { limit?: number; datasetDir: string },
): Promise<BenchmarkResult> {
  const tasks = await loadDataset(options.datasetDir, options.limit);
  const scores: TaskScore[] = [];
  const overallStart = performance.now();

  for (const task of tasks) {
    const sessionId = `amemgym-${task.id}`;
    await system.reset();

    // Phase 1: Ingest user profile — store preferences and conversation history
    const profileMessages = [
      {
        role: "system" as const,
        content: `User profile for ${task.user_profile.user_id}: ${JSON.stringify(task.user_profile.preferences)}`,
      },
    ];

    // Store conversation history as user/assistant turns
    const historyMessages = task.user_profile.history.map((h) => ({
      role: (h.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: h.content,
    }));

    await system.store(sessionId, [...profileMessages, ...historyMessages]);

    // Phase 2: Query — test personalization accuracy
    for (const q of task.queries) {
      const queryId = `${task.id}-${q.query.slice(0, 30).replace(/\s+/g, "_")}`;
      const { result: recallText, durationMs } = await timed(() =>
        system.recall(sessionId, q.query),
      );

      const f1 = f1Score(recallText, q.expected_answer);
      const contains = containsAnswer(recallText, q.expected_answer);

      // Memory utilization: did the recall include any of the relevant preferences?
      let prefsFound = 0;
      for (const pref of q.relevant_preferences) {
        if (recallText.toLowerCase().includes(pref.toLowerCase())) {
          prefsFound++;
        }
      }
      const memoryUtilization =
        q.relevant_preferences.length > 0
          ? prefsFound / q.relevant_preferences.length
          : 1.0;

      scores.push({
        taskId: queryId,
        metrics: {
          f1,
          contains_answer: contains,
          memory_utilization: memoryUtilization,
        },
        details: {
          query: q.query,
          expected: q.expected_answer,
          recalled_length: recallText.length,
          relevant_preferences: q.relevant_preferences,
          prefs_found: prefsFound,
          difficulty: q.difficulty,
          category: task.category,
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

export const amemGymRunner: BenchmarkRunner = { meta, run };
