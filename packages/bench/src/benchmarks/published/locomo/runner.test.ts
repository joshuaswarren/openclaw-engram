import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Message } from "../../../adapters/types.js";
import { locomoDefinition, runLoCoMoBenchmark } from "./runner.ts";

test("LoCoMo normalizes numeric answers and adversarial-answer fallbacks from the official dataset", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-"));
  const datasetPath = path.join(tempDir, "locomo10.json");
  const storedMessages: Message[] = [];
  const respondentQuestions: string[] = [];

  try {
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          sample_id: "locomo-normalized-1",
          conversation: {
            speaker_a: "Maya",
            speaker_b: "Assistant",
            session_1: [
              { speaker: "Maya", dia_id: "D1:1", text: "I moved in 2022." },
              {
                speaker: "Maya",
                dia_id: "D1:2",
                text: "The jacket was blue.",
              },
            ],
          },
          qa: [
            {
              question: "What year did Maya move?",
              answer: 2022,
              evidence: ["D1:1"],
              category: 1,
            },
            {
              question: "What color was the jacket?",
              adversarial_answer: "blue",
              evidence: ["D1:2"],
              category: 5,
            },
          ],
        },
      ]),
      "utf8",
    );

    const result = await runLoCoMoBenchmark({
      benchmark: locomoDefinition,
      mode: "full",
      datasetDir: tempDir,
      system: {
        async store(_sessionId, messages) {
          storedMessages.push(...messages);
        },
        async recall(_sessionId, question) {
          if (question.includes("year")) {
            return "2022";
          }
          return "blue";
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
          async respond(question) {
            respondentQuestions.push(question);
            return {
              text: question.includes("jacket") ? "blue" : "2022",
              tokens: { input: 1, output: 1 },
              latencyMs: 1,
              model: "locomo-test-responder",
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

    assert.equal(result.results.tasks.length, 2);
    assert.equal(result.results.tasks[0]?.expected, "2022");
    assert.equal(result.results.tasks[1]?.expected, "blue");
    assert.equal(result.results.tasks[0]?.actual, "2022");
    assert.equal(result.results.tasks[1]?.actual, "blue");
    assert.equal(result.results.tasks[0]?.details.answerFormat, "short");
    assert.ok(
      respondentQuestions.every((question) =>
        /shortest complete answer/.test(question),
      ),
    );
    assert.equal(storedMessages[0]?.content, "[D1:1] Maya: I moved in 2022.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
