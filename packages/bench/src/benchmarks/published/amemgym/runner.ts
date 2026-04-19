/**
 * AMemGym runner migrated into @remnic/bench for phase 1.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../../../adapters/types.js";
import { answerBenchmarkQuestion } from "../../../answering.js";
import {
  AMEMGYM_SMOKE_FIXTURE,
  type AMemGymProfile,
  type AMemGymQA,
  type AMemGymSession,
} from "./fixture.js";
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

const DATASET_FILENAMES = [
  "amemgym-v1-base.json",
  "amemgym-tasks.json",
  "data.json",
] as const;

/**
 * For each QA, find the correct answer based on the final state.
 * The QA has answer_choices, each tied to specific state values.
 * We pick the one matching the user's final state.
 */
function findBestAnswer(qa: AMemGymQA, finalState: Record<string, string>): string {
  for (const choice of qa.answer_choices) {
    const requiredStates = choice.state;
    const matchValues = qa.required_info.map((key) => finalState[key]);
    if (requiredStates.length === matchValues.length &&
      requiredStates.every((s, i) => s === matchValues[i])) {
      return choice.answer;
    }
  }
  return qa.answer_choices[0]?.answer ?? "";
}

export const amemGymDefinition: BenchmarkDefinition = {
  id: "amemgym",
  title: "AMemGym",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "amemgym",
    version: "2.0.0",
    description:
      "Interactive personalization benchmark across evolving user profiles and memory probes.",
    category: "agentic",
    citation:
      "AMemGym: Interactive Memory Benchmarking for Assistants in Long-Horizon Conversations (2025)",
  },
};

export async function runAMemGymBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const profiles = await loadDataset(options.mode, options.datasetDir, options.limit);
  const tasks: TaskResult[] = [];

  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex += 1) {
    const profile = profiles[profileIndex]!;
    await options.system.reset();

    const sessionId = `amemgym-${profile.id}`;
    const finalState: Record<string, string> = {};

    for (const period of profile.periods) {
      Object.assign(finalState, period.state);

      for (const session of period.sessions) {
        const messages = buildSessionMessages(session);
        if (messages.length > 0) {
          await options.system.store(sessionId, messages);
        }
      }
    }

    for (
      let questionIndex = 0;
      questionIndex < profile.qas.length;
      questionIndex += 1
    ) {
      const qa = profile.qas[questionIndex]!;
      const expectedAnswer = findBestAnswer(qa, finalState);

      const { result: recallText, durationMs } = await timed(async () => {
        return options.system.recall(sessionId, qa.query);
      });
      const answered = await answerBenchmarkQuestion({
        question: qa.query,
        recalledText: recallText,
        responder: options.system.responder,
      });

      const scores: Record<string, number> = {
        f1: f1Score(answered.finalAnswer, expectedAnswer),
        contains_answer: containsAnswer(answered.finalAnswer, expectedAnswer),
      };
      const judgeScore = await llmJudgeScore(
        options.system.judge,
        qa.query,
        answered.finalAnswer,
        expectedAnswer,
      );
      if (judgeScore >= 0) {
        scores.llm_judge = judgeScore;
      }

      tasks.push({
        taskId: `${profile.id}-q${questionIndex}`,
        question: qa.query,
        expected: expectedAnswer,
        actual: answered.finalAnswer,
        scores,
        latencyMs: durationMs + answered.latencyMs,
        tokens: answered.tokens,
        details: {
          profileId: profile.id,
          profileName: profile.user_profile.name,
          questionIndex,
          periodCount: profile.periods.length,
          requiredInfo: qa.required_info,
          recalledLength: recallText.length,
          answeredLength: answered.finalAnswer.length,
          recalledText: recallText,
          answeredText: answered.finalAnswer,
          responderModel: answered.model,
        },
      });
    }
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
): Promise<AMemGymProfile[]> {
  const normalizedLimit = normalizeLimit(limit);
  const ensureDatasetProfiles = (
    profiles: AMemGymProfile[],
  ): AMemGymProfile[] => {
    if (profiles.length === 0) {
      throw new Error(
        "AMemGym dataset is empty after applying the requested limit.",
      );
    }
    return profiles;
  };

  if (datasetDir) {
    const datasetErrors: string[] = [];
    for (const filename of DATASET_FILENAMES) {
      try {
        const raw = await readFile(path.join(datasetDir, filename), "utf8");
        const parsed = parseDataset(raw, filename);
        return ensureDatasetProfiles(applyLimit(parsed, normalizedLimit));
      } catch (error) {
        datasetErrors.push(
          `${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new Error(
      `AMemGym dataset not found under ${datasetDir}. Tried ${DATASET_FILENAMES.join(", ")}. Errors: ${datasetErrors.join(" | ")}`,
    );
  }

  if (mode === "full") {
    throw new Error(
      "AMemGym full mode requires datasetDir. Pass a dataset path or use quick mode to run the bundled smoke fixture.",
    );
  }

  return ensureDatasetProfiles(applyLimit(AMEMGYM_SMOKE_FIXTURE, normalizedLimit));
}

function parseDataset(raw: string, filename: string): AMemGymProfile[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `AMemGym dataset file ${filename} must contain an array of user profiles.`,
    );
  }
  return parsed as AMemGymProfile[];
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      "AMemGym limit must be a non-negative integer when provided.",
    );
  }
  return limit;
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) {
    return items;
  }
  return items.slice(0, limit);
}

function buildSessionMessages(session: AMemGymSession): Message[] {
  const messages: Message[] = [];

  if (session.event) {
    messages.push({
      role: "assistant",
      content: `[Context update]: ${session.event}`,
    });
  }

  if (session.query) {
    messages.push({
      role: "user",
      content: session.query,
    });
  }

  for (const message of session.messages) {
    messages.push({
      role: normalizeRole(message.role),
      content: message.content,
    });
  }

  if (messages.length === 0 && Object.keys(session.exposed_states).length > 0) {
    const stateDescription = Object.entries(session.exposed_states)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ");
    messages.push({
      role: "user",
      content: `[User state]: ${stateDescription}`,
    });
  }

  return messages;
}

function normalizeRole(role: string): Message["role"] {
  if (role === "assistant" || role === "system") {
    return role;
  }
  return "user";
}
