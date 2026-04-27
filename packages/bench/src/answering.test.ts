import assert from "node:assert/strict";
import test from "node:test";

import {
  answerBenchmarkQuestion,
  buildStrictBenchmarkQuestion,
  inferAnswerFormat,
} from "./answering.ts";

test("without a responder the benchmark answer falls back to recalled text", async () => {
  const result = await answerBenchmarkQuestion({
    question: "What happened?",
    recalledText: "The recalled memory.",
  });

  assert.equal(result.finalAnswer, "The recalled memory.");
  assert.equal(result.recalledText, "The recalled memory.");
  assert.equal(result.answeredText, "The recalled memory.");
  assert.deepEqual(result.tokens, {
    input: 0,
    output: 0,
  });
  assert.equal(result.latencyMs, 0);
});

test("with a responder the benchmark answer uses the generated final answer and preserves usage", async () => {
  const result = await answerBenchmarkQuestion({
    question: "What happened?",
    recalledText: "The recalled memory.",
    answerMode: "strict",
    responder: {
      async respond(question, recalledText) {
        assert.match(question, /What happened\?/);
        assert.match(question, /Benchmark answer protocol:/);
        assert.equal(recalledText, "The recalled memory.");
        return {
          text: "The generated answer.",
          tokens: {
            input: 32,
            output: 9,
          },
          latencyMs: 44,
          model: "gpt-5.4-mini",
        };
      },
    },
  });

  assert.equal(result.finalAnswer, "The generated answer.");
  assert.equal(result.recalledText, "The recalled memory.");
  assert.equal(result.answeredText, "The generated answer.");
  assert.deepEqual(result.tokens, {
    input: 32,
    output: 9,
  });
  assert.equal(result.latencyMs, 44);
  assert.equal(result.model, "gpt-5.4-mini");
});

test("default answering preserves legacy exact questions", async () => {
  const result = await answerBenchmarkQuestion({
    question: "What happened?",
    recalledText: "The recalled memory.",
    answerMode: "default",
    responder: {
      async respond(question) {
        assert.equal(question, "What happened?");
        return {
          text: "The generated answer.",
          tokens: { input: 1, output: 1 },
          latencyMs: 1,
          model: "test-model",
        };
      },
    },
  });

  assert.equal(result.finalAnswer, "The generated answer.");
});

test("strict question builder preserves structured protocols", () => {
  assert.equal(
    inferAnswerFormat("Choices:\nA. Tea\nB. Coffee\nPlease output the correct option"),
    "choice-letter",
  );
  assert.equal(
    inferAnswerFormat("Answer choices:\n1. Tea\n2. Coffee"),
    "choice-number",
  );
  assert.match(
    buildStrictBenchmarkQuestion("Final output format:\n=== Traveler Plan ==="),
    /Preserve the requested structured output format exactly/,
  );
});

test("strict question builder preserves free-form summarization prompts", () => {
  const question = [
    "You are given a book above and you are tasked to summarize it.",
    "Now summarize the book.",
  ].join("\n");

  assert.equal(inferAnswerFormat(question), "auto");
  assert.doesNotMatch(
    buildStrictBenchmarkQuestion(question),
    /shortest complete answer/,
  );
  assert.match(
    buildStrictBenchmarkQuestion(question, "short"),
    /shortest complete answer/,
  );
});

test("strict question builder supports concise answers with required specifics", () => {
  const question = "How many columns did I add?";
  const prompt = buildStrictBenchmarkQuestion(question, "short-with-specifics");

  assert.match(prompt, /shortest complete answer/);
  assert.match(prompt, /concrete named items/);
  assert.match(prompt, /Two columns: category and notes/);
  assert.match(prompt, /without hedge words/);
  assert.match(prompt, /Prefer exact values/);
});

test("strict question builder can answer remembered instructions", () => {
  const prompt = buildStrictBenchmarkQuestion(
    "Could you show me how to implement a login feature?",
    "instruction",
  );

  assert.match(prompt, /answer with that remembered instruction/);
  assert.match(prompt, /instead of performing the requested task/);
  assert.match(prompt, /Always format implementation help/);
  assert.match(prompt, /Do not quote a "please remember" request verbatim/);
  assert.match(prompt, /code blocks with syntax highlighting/);
  assert.match(prompt, /do not answer "unknown"/);
});
