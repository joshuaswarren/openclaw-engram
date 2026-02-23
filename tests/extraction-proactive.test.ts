import test from "node:test";
import assert from "node:assert/strict";
import { ExtractionEngine, mergeProactiveQuestions } from "../src/extraction.ts";
import { parseConfig } from "../src/config.ts";

test("mergeProactiveQuestions appends unique proactive questions up to cap", () => {
  const base = [
    { question: "What deadline applies here?", context: "existing", priority: 0.7 },
  ];
  const proactive = [
    { question: "What risk is highest right now?", context: "new", priority: 0.8 },
    { question: "What dependency might block this?", context: "new", priority: 0.6 },
  ];

  const merged = mergeProactiveQuestions(base, proactive, 1);
  assert.equal(merged.length, 2);
  assert.equal(merged[1]?.question, "What risk is highest right now?");
});

test("mergeProactiveQuestions dedupes by normalized question text", () => {
  const base = [
    { question: "What should we verify first?", context: "existing", priority: 0.7 },
  ];
  const proactive = [
    { question: "  what should we verify first?  ", context: "dup", priority: 0.4 },
    { question: "What changed most recently?", context: "new", priority: 0.6 },
  ];

  const merged = mergeProactiveQuestions(base, proactive, 2);
  assert.equal(merged.length, 2);
  assert.equal(merged[1]?.question, "What changed most recently?");
});

test("mergeProactiveQuestions preserves base questions when cap is zero", () => {
  const base = [
    { question: "What decision was made?", context: "existing", priority: 0.5 },
  ];
  const proactive = [
    { question: "What assumption needs validation?", context: "new", priority: 0.8 },
  ];

  const merged = mergeProactiveQuestions(base, proactive, 0);
  assert.deepEqual(merged, base);
});

test("generateProactiveQuestions does not call cloud fallback when localLlmFallback is false", async () => {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    proactiveExtractionEnabled: true,
    maxProactiveQuestionsPerExtraction: 2,
    localLlmEnabled: true,
    localLlmFallback: false,
  });

  const engine = new ExtractionEngine(config);
  let fallbackCalled = false;
  (engine as any).localLlm = {
    chatCompletion: async () => ({ content: '{"questions":[]}' }),
  };
  (engine as any).fallbackLlm = {
    parseWithSchema: async () => {
      fallbackCalled = true;
      return { questions: [{ question: "fallback", context: "", priority: 0.5 }] };
    },
  };

  const questions = await (engine as any).generateProactiveQuestions(
    "user: hello\nassistant: hi",
    { facts: [], profileUpdates: [], entities: [], questions: [] },
    2,
  );

  assert.deepEqual(questions, []);
  assert.equal(fallbackCalled, false);
});
