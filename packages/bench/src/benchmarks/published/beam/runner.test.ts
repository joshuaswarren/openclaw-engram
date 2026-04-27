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
