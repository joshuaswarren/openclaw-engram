import assert from "node:assert/strict";
import test from "node:test";

import { beamDefinition, runBeamBenchmark } from "./runner.ts";

test("BEAM quick mode uses answer formats for concise facts and remembered instructions", async () => {
  const prompts: string[] = [];
  const result = await runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    system: {
      async reset() {},
      async store() {},
      async recall(_sessionId, question) {
        return [
          "I want sprint one to end on March 29.",
          "For the transactions table, I want to add two new columns: category and notes.",
          "Whenever I ask about implementation, format the answer with syntax-highlighted code blocks.",
          "The dashboard API now averages around 250ms.",
          `Question: ${question}`,
        ].join("\n");
      },
      async search() {
        return [{ id: "hit", text: "hit" }];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond(question) {
          prompts.push(question);
          if (question.includes("How many new columns")) {
            assert.match(question, /concrete named items/);
            return {
              text: "Two columns: category and notes.",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "beam-test-responder",
            };
          }
          if (question.includes("implement a login feature")) {
            assert.match(question, /answer with that remembered instruction/);
            return {
              text: "Always format implementation help with syntax-highlighted code blocks.",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "beam-test-responder",
            };
          }
          return {
            text: question.includes("sprint") ? "March 29" : "250ms",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "beam-test-responder",
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
            model: "beam-test-judge",
          };
        },
      },
    },
  });

  assert.equal(result.results.tasks.length, 4);
  assert.ok(prompts.some((prompt) => /concrete named items/.test(prompt)));
  assert.ok(
    prompts.some((prompt) =>
      /answer with that remembered instruction/.test(prompt),
    ),
  );
  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.actual,
    "Always format implementation help with syntax-highlighted code blocks.",
  );
  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("multi_session_reasoning"),
    )?.scores.rubric_coverage,
    1,
  );
  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

test("BEAM rubric coverage does not reward negated syntax highlighting answers", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Do not use syntax highlighting for implementation help.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage checks negation before exact syntax containment", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Do not use code blocks with syntax highlighting.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage does not reward post-mention negation", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Syntax highlighting is not required for implementation help.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage does not reward weakened syntax highlighting", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Syntax-highlighted code blocks are optional for implementation help.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage requires code blocks for syntax highlighting rubric", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Syntax highlighting is useful for implementation help.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    0,
  );
});

test("BEAM rubric coverage allows compliant contrastive syntax answers", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Always use syntax-highlighted code blocks, not plain text.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

test("BEAM rubric coverage allows pre-mention contrastive negation", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Do not use plain text; use code blocks with syntax highlighting.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

test("BEAM rubric coverage allows comma-separated contrastive negation", async () => {
  const result = await runBeamWithInstructionAnswer(
    "Do not use plain text, use code blocks with syntax highlighting.",
  );

  assert.equal(
    result.results.tasks.find((task) =>
      task.taskId.includes("instruction_following"),
    )?.scores.rubric_coverage,
    1,
  );
});

async function runBeamWithInstructionAnswer(instructionAnswer: string) {
  return runBeamBenchmark({
    benchmark: beamDefinition,
    mode: "quick",
    system: {
      async reset() {},
      async store() {},
      async recall(_sessionId, question) {
        return [
          "I want sprint one to end on March 29.",
          "For the transactions table, I want to add two new columns: category and notes.",
          "Whenever I ask about implementation, format the answer with syntax-highlighted code blocks.",
          "The dashboard API now averages around 250ms.",
          `Question: ${question}`,
        ].join("\n");
      },
      async search() {
        return [{ id: "hit", text: "hit" }];
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond(question) {
          if (question.includes("implement a login feature")) {
            return {
              text: instructionAnswer,
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "beam-test-responder",
            };
          }
          return {
            text: question.includes("sprint")
              ? "March 29"
              : question.includes("dashboard API")
                ? "250ms"
                : "Two columns: category and notes.",
            tokens: { input: 1, output: 1 },
            latencyMs: 1,
            model: "beam-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 0;
        },
      },
    },
  });
}
