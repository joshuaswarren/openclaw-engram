import test from "node:test";
import assert from "node:assert/strict";
import { ExtractionEngine, mergeProactiveQuestions } from "../src/extraction.ts";
import { parseConfig } from "../src/config.ts";
import type { ExtractionResult } from "../src/types.ts";

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

test("mergeProactiveQuestions reserves question budget for proactive additions under total cap", () => {
  const base = [
    { question: "Base Q1", context: "existing", priority: 0.7 },
    { question: "Base Q2", context: "existing", priority: 0.7 },
    { question: "Base Q3", context: "existing", priority: 0.7 },
  ];
  const proactive = [
    { question: "Proactive Q1", context: "new", priority: 0.8 },
    { question: "Proactive Q2", context: "new", priority: 0.6 },
  ];

  const merged = mergeProactiveQuestions(base, proactive, 2, 3);
  assert.deepEqual(
    merged.map((q) => q.question),
    ["Base Q1", "Proactive Q1", "Proactive Q2"],
  );
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

test("applyProactiveQuestionPass answers proactive questions into additive memories without persisting internal questions", async () => {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    proactiveExtractionEnabled: true,
    maxProactiveQuestionsPerExtraction: 2,
  });

  const engine = new ExtractionEngine(config);
  (engine as any).generateProactiveQuestions = async () => [
    { question: "What deadline did they commit to?", context: "commitment gap", priority: 0.8 },
  ];
  (engine as any).answerProactiveQuestions = async (): Promise<ExtractionResult> => ({
    facts: [
      {
        category: "commitment",
        content: "Alex committed to ship the review on Friday.",
        confidence: 0.91,
        tags: ["deadline"],
        source: "proactive",
      },
    ],
    profileUpdates: ["User prefers concise review status updates."],
    entities: [
      {
        name: "Alex",
        type: "person",
        facts: ["Owns the review timeline."],
        source: "proactive",
      },
    ],
    questions: [
      { question: "internal only", context: "should not persist", priority: 0.2 },
    ],
  });

  const base: ExtractionResult = {
    facts: [
      {
        category: "fact",
        content: "The review is active.",
        confidence: 0.8,
        tags: [],
        source: "base",
      },
    ],
    profileUpdates: [],
    entities: [],
    questions: [
      { question: "What is still unclear?", context: "base question", priority: 0.5 },
    ],
  };

  const result = await (engine as any).applyProactiveQuestionPass("conversation", base);
  assert.equal(result.facts.length, 2);
  assert.equal(result.facts[1]?.source, "proactive");
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0]?.source, "proactive");
  assert.deepEqual(result.questions, base.questions);
  assert.deepEqual(result.profileUpdates, []);
});

test("applyProactiveQuestionPass filters proactive facts by allowlist and confidence", async () => {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    proactiveExtractionEnabled: true,
    maxProactiveQuestionsPerExtraction: 2,
    proactiveExtractionCategoryAllowlist: ["decision"],
  });

  const engine = new ExtractionEngine(config);
  (engine as any).generateProactiveQuestions = async () => [
    { question: "What decision did they make?", context: "decision gap", priority: 0.8 },
  ];
  (engine as any).answerProactiveQuestions = async (): Promise<ExtractionResult> => ({
    facts: [
      {
        category: "fact",
        content: "They mentioned a tentative idea.",
        confidence: 0.99,
        tags: [],
        source: "proactive",
      },
      {
        category: "decision",
        content: "They decided to ship on Friday.",
        confidence: 0.61,
        tags: [],
        source: "proactive",
      },
    ],
    profileUpdates: [],
    entities: [],
    questions: [],
  });

  const base: ExtractionResult = { facts: [], profileUpdates: [], entities: [], questions: [] };
  const result = await (engine as any).applyProactiveQuestionPass("conversation", base);
  assert.deepEqual(result.facts, []);
});

test("applyProactiveQuestionPass enforces a single total addition budget across proactive outputs", async () => {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    proactiveExtractionEnabled: true,
    maxProactiveQuestionsPerExtraction: 2,
  });

  const engine = new ExtractionEngine(config);
  (engine as any).generateProactiveQuestions = async () => [
    { question: "What commitment was omitted?", context: "commitment gap", priority: 0.9 },
    { question: "Who owns it?", context: "owner gap", priority: 0.8 },
  ];
  (engine as any).answerProactiveQuestions = async (): Promise<ExtractionResult> => ({
    facts: [
      {
        category: "commitment",
        content: "Alex committed to ship on Friday.",
        confidence: 0.95,
        tags: [],
        source: "proactive",
      },
      {
        category: "decision",
        content: "The team chose the safer rollout.",
        confidence: 0.94,
        tags: [],
        source: "proactive",
      },
    ],
    profileUpdates: ["User wants daily status notes."],
    entities: [
      {
        name: "Alex",
        type: "person",
        facts: ["Owns the Friday ship date."],
        source: "proactive",
      },
    ],
    relationships: [
      {
        source: "Alex",
        target: "Friday ship date",
        label: "owns",
        extractionSource: "proactive",
      },
    ],
    questions: [],
  });

  const result = await (engine as any).applyProactiveQuestionPass("conversation", {
    facts: [],
    profileUpdates: [],
    entities: [],
    relationships: [],
    questions: [],
  });

  const totalAdditions = result.facts.length
    + result.entities.length
    + result.profileUpdates.length
    + (result.relationships?.length ?? 0);
  assert.equal(totalAdditions, 2);
  assert.deepEqual(
    result.facts.map((fact) => fact.content),
    [
      "Alex committed to ship on Friday.",
      "The team chose the safer rollout.",
    ],
  );
  assert.equal(result.entities.length, 0);
  assert.equal(result.profileUpdates.length, 0);
  assert.deepEqual(result.relationships, []);
});

test("proactive extraction forwards timeout/token budgets to local and fallback calls", async () => {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    proactiveExtractionEnabled: true,
    maxProactiveQuestionsPerExtraction: 2,
    proactiveExtractionTimeoutMs: 1234,
    proactiveExtractionMaxTokens: 321,
    localLlmEnabled: true,
    localLlmFallback: true,
  });

  const engine = new ExtractionEngine(config);
  let localQuestionOptions: Record<string, unknown> | undefined;
  let fallbackQuestionOptions: Record<string, unknown> | undefined;
  let localAnswerOptions: Record<string, unknown> | undefined;
  let fallbackAnswerOptions: Record<string, unknown> | undefined;
  (engine as any).localLlm = {
    chatCompletion: async (_messages: unknown, options: Record<string, unknown>) => {
      if (!localQuestionOptions) {
        localQuestionOptions = options;
      } else {
        localAnswerOptions = options;
      }
      return { content: "{\"questions\":[]}" };
    },
  };
  (engine as any).fallbackLlm = {
    parseWithSchema: async (_messages: unknown, _schema: unknown, options: Record<string, unknown>) => {
      if (!fallbackQuestionOptions) {
        fallbackQuestionOptions = options;
        return { questions: [] };
      }
      fallbackAnswerOptions = options;
      return { facts: [], profileUpdates: [], entities: [], relationships: [] };
    },
  };

  await (engine as any).generateProactiveQuestions("conversation", { facts: [], profileUpdates: [], entities: [], questions: [] }, 2);
  await (engine as any).answerProactiveQuestions("conversation", { facts: [], profileUpdates: [], entities: [], questions: [] }, [
    { question: "What was omitted?", context: "gap", priority: 0.8 },
  ], 2);

  assert.equal(localQuestionOptions?.timeoutMs, 1234);
  assert.equal(localQuestionOptions?.maxTokens, 321);
  assert.equal(fallbackQuestionOptions?.timeoutMs, 1234);
  assert.equal(fallbackQuestionOptions?.maxTokens, 321);
  assert.equal(localAnswerOptions?.timeoutMs, 1234);
  assert.equal(localAnswerOptions?.maxTokens, 321);
  assert.equal(fallbackAnswerOptions?.timeoutMs, 1234);
  assert.equal(fallbackAnswerOptions?.maxTokens, 321);
});
