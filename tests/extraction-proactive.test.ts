import test from "node:test";
import assert from "node:assert/strict";
import { ExtractionEngine } from "../src/extraction.ts";
import { parseConfig } from "../src/config.ts";
import { ProactiveExtractionResultSchema } from "../src/schemas.ts";
import type { ExtractionResult } from "../src/types.ts";

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
        promptedByQuestion: "What deadline did they commit to?",
      },
    ],
    profileUpdates: ["User prefers concise review status updates."],
    entities: [
      {
        name: "Alex",
        type: "person",
        facts: ["Owns the review timeline."],
        source: "proactive",
        promptedByQuestion: "What deadline did they commit to?",
      },
    ],
    relationships: [
      {
        source: "Alex",
        target: "review timeline",
        label: "owns",
        extractionSource: "proactive",
        promptedByQuestion: "What deadline did they commit to?",
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
  assert.equal(result.facts[1]?.promptedByQuestion, "What deadline did they commit to?");
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0]?.source, "proactive");
  assert.equal(result.entities[0]?.promptedByQuestion, "What deadline did they commit to?");
  assert.deepEqual(result.questions, base.questions);
  assert.deepEqual(result.profileUpdates, []);
});

test("normalizeExtractionResultPayload preserves proactive promptedByQuestion provenance", () => {
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
  });

  const engine = new ExtractionEngine(config);
  const parsed = ProactiveExtractionResultSchema.parse({
    facts: [
      {
        category: "fact",
        content: "Alex committed to ship the review on Friday.",
        confidence: 0.93,
        tags: ["deadline"],
        promptedByQuestion: "What deadline did they commit to?",
      },
    ],
    profileUpdates: [],
    entities: [
      {
        name: "Alex",
        type: "person",
        facts: ["Owns the review timeline."],
        promptedByQuestion: "Who owns the review timeline?",
      },
    ],
    relationships: [
      {
        source: "Alex",
        target: "review timeline",
        label: "owns",
        promptedByQuestion: "Who owns the review timeline?",
      },
    ],
  });

  const normalized = (engine as any).normalizeExtractionResultPayload(parsed) as ExtractionResult;
  assert.equal(normalized.facts[0]?.promptedByQuestion, "What deadline did they commit to?");
  assert.equal(normalized.entities[0]?.promptedByQuestion, "Who owns the review timeline?");
  assert.equal(normalized.relationships?.[0]?.promptedByQuestion, "Who owns the review timeline?");
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
