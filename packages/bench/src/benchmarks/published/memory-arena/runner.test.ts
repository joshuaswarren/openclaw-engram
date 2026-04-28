import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryArenaDefinition, runMemoryArenaBenchmark } from "./runner.ts";

test("MemoryArena derives missing categories from the source filename", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "formal_reasoning_math.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 7,
        category: null,
        questions: ["Which proof topic did we review?"],
        answers: ["number theory"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "number theory";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
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
    assert.equal(
      result.results.tasks[0]?.details?.category,
      "formal_reasoning_math",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena quick fixture seeds prerequisite subtasks before scoring follow-ups", async () => {
  const storedMessages: string[] = [];
  const recalledQueries: string[] = [];
  const completedCounts: number[] = [];

  const result = await runMemoryArenaBenchmark({
    benchmark: memoryArenaDefinition,
    mode: "quick",
    system: {
      async store(_sessionId, messages) {
        storedMessages.push(...messages.map((message) => message.content));
      },
      async recall(_sessionId, query) {
        recalledQueries.push(query);
        return storedMessages.join("\n\n");
      },
      async search() {
        return [];
      },
      async reset() {
        storedMessages.length = 0;
      },
      async destroy() {},
      async drain() {},
      async getStats() {
        return { totalMessages: storedMessages.length, totalSummaryNodes: 0, maxDepth: 0 };
      },
      judge: {
        async score() {
          return 1;
        },
        async scoreWithMetrics(_question, predicted, expected) {
          return {
            score: predicted.includes(expected) ? 1 : 0,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "judge-smoke",
          };
        },
      },
    },
    onTaskComplete(_task, completed) {
      completedCounts.push(completed);
    },
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.taskId, "bundled_shopping-t1-q1");
  assert.equal(result.results.tasks[0]?.expected, "trail mix");
  assert.equal(result.results.tasks[0]?.scores.contains_answer, 1);
  assert.equal(result.results.tasks[0]?.scores.process_score, 1);
  assert.equal(result.results.tasks[0]?.scores.task_success_rate, 1);
  assert.match(result.results.tasks[0]?.actual ?? "", /trail mix/);
  assert.deepEqual(completedCounts, [1]);
  assert.equal(recalledQueries.length, 1);
  assert.match(storedMessages.join("\n"), /Environment result: trail mix/);
});

test("MemoryArena accepts optional string-array backgrounds from dataset files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 8,
        category: "shopping",
        questions: [
          "What did the previous shopper choose?",
          "Which item should be packed?",
        ],
        answers: ["trail mix", "trail mix"],
        backgrounds: ["The shopper already bought trail mix.", ""],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "trail mix";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
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

    assert.equal(result.results.tasks.length, 2);
    assert.equal(result.results.tasks[0]?.taskId, "shopping-t8-q0");
    assert.equal(result.results.tasks[1]?.taskId, "shopping-t8-q1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena passes the live task prompt into answer context", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");
  let responderContext = "";

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 9,
        category: "bundled_shopping",
        questions: [
          "Product 1 options: ASIN A costs $4. Product 2 options: ASIN B costs $5. Which bundle should be purchased?",
        ],
        answers: ["ASIN A | ASIN B"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "Prior memory context.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        responder: {
          async respond(_question, context) {
            responderContext = context;
            return {
              text: "ASIN A | ASIN B",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "responder-smoke",
            };
          },
        },
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
    assert.match(responderContext, /Current MemoryArena task prompt/);
    assert.match(responderContext, /Product 1 options: ASIN A/);
    assert.match(responderContext, /Prior memory context/);
    assert.match(
      String(result.results.tasks[0]?.details?.answerContext ?? ""),
      /Product 2 options: ASIN B/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryArena no-responder runs do not score the live task prompt as recall", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-memory-arena-"));
  const datasetPath = path.join(tempDir, "bundled_shopping.jsonl");

  try {
    await writeFile(
      datasetPath,
      JSON.stringify({
        id: 10,
        category: "bundled_shopping",
        questions: [
          "Product options include ASIN A. Which item should be purchased?",
        ],
        answers: ["ASIN A"],
      }) + "\n",
      "utf8",
    );

    const result = await runMemoryArenaBenchmark({
      benchmark: memoryArenaDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store() {},
        async recall() {
          return "Prior memory context without the answer.";
        },
        async search() {
          return [];
        },
        async reset() {},
        async destroy() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        judge: {
          async score() {
            return 0;
          },
          async scoreWithMetrics() {
            return {
              score: 0,
              tokens: { input: 0, output: 0 },
              latencyMs: 0,
              model: "judge-smoke",
            };
          },
        },
      },
    });

    assert.equal(result.results.tasks[0]?.actual, "Prior memory context without the answer.");
    assert.equal(result.results.tasks[0]?.scores.contains_answer, 0);
    assert.match(
      String(result.results.tasks[0]?.details?.answerContext ?? ""),
      /Product options include ASIN A/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
