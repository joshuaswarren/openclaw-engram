import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { amaBenchDefinition, runAmaBenchBenchmark } from "./runner.ts";

test("AMA-Bench normalizes sparse null trajectory fields from the official dataset", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-ama-bench-"));
  const datasetPath = path.join(tempDir, "open_end_qa_set.jsonl");
  const storedMessages: Array<{ role: string; content: string }> = [];

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        episode_id: 1,
        task: "Sparse AMA fixture",
        task_type: "web",
        domain: "WEB",
        success: true,
        num_turns: 2,
        total_tokens: 32,
        trajectory: [
          {
            turn_idx: 0,
            action: null,
            observation: "Observed the profile language.",
          },
          {
            turn_idx: 1,
            action: "Checked notification settings.",
            observation: null,
          },
        ],
        qa_pairs: [
          {
            question: "What language was observed?",
            answer: "Spanish",
            type: "recall",
            question_uuid: "ama-null-q1",
          },
        ],
      }) + "\n",
      "utf8",
    );

    const result = await runAmaBenchBenchmark({
      benchmark: amaBenchDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages);
        },
        async recall() {
          return "Spanish";
        },
        async search() {
          return [];
        },
        async reset() {},
        async getStats() {
          return {
            totalMessages: 4,
            totalSummaryNodes: 0,
            maxDepth: 0,
          };
        },
        async destroy() {},
        judge: {
          async score() {
            return 1;
          },
          async scoreWithMetrics() {
            return {
              score: 1,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks.length, 1);
    assert.equal(storedMessages.length, 4);
    assert.equal(storedMessages[0]?.content, "[Action 0]: ");
    assert.equal(storedMessages[1]?.content, "[Observation 0]: Observed the profile language.");
    assert.equal(storedMessages[2]?.content, "[Action 1]: Checked notification settings.");
    assert.equal(storedMessages[3]?.content, "[Observation 1]: ");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("AMA-Bench records recommended and cross-judge protocol metrics", async () => {
  const result = await runAmaBenchBenchmark({
    benchmark: amaBenchDefinition,
    mode: "quick",
    amaBenchJudgeProtocol: "recommended",
    amaBenchCrossJudgeProvider: {
      provider: "ollama",
      model: "qwen3:32b",
    },
    amaBenchCrossJudge: {
      async score() {
        return 0;
      },
      async scoreWithMetrics() {
        return {
          score: 0,
          tokens: { input: 1, output: 1 },
          latencyMs: 2,
          model: "cross-qwen3-32b",
        };
      },
    },
    system: {
      async store() {},
      async recall() {
        return "Spanish";
      },
      async search() {
        return [];
      },
      async reset() {},
      async getStats() {
        return {
          totalMessages: 4,
          totalSummaryNodes: 0,
          maxDepth: 0,
        };
      },
      async destroy() {},
      judge: {
        async score() {
          return 1;
        },
        async scoreWithMetrics() {
          return {
            score: 1,
            tokens: { input: 1, output: 1 },
            latencyMs: 2,
            model: "primary-qwen3-32b",
          };
        },
      },
    },
  });

  const first = result.results.tasks[0]!;
  assert.equal(first.scores.ama_bench_recommended_accuracy, 1);
  assert.equal(first.scores.ama_bench_cross_accuracy, 0);
  assert.equal(first.scores.ama_bench_cross_agreement, 0);
  assert.equal(first.details?.amaBenchJudgeProtocol, "recommended");
  assert.equal(first.details?.amaBenchCrossJudgeModel, "cross-qwen3-32b");
  assert.equal(
    result.config.benchmarkOptions?.amaBenchJudgeProtocol,
    "recommended",
  );
  assert.deepEqual(result.config.benchmarkOptions?.amaBenchCrossJudgeProvider, {
    provider: "ollama",
    model: "qwen3:32b",
  });
});
