import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildActiveRecallPrompt,
  buildActiveRecallQueryBundle,
  createActiveRecallEngine,
  normalizeActiveRecallSummary,
  type ActiveRecallConfig,
  type ActiveRecallInput,
} from "./active-recall.js";

function baseConfig(overrides: Partial<ActiveRecallConfig> = {}): ActiveRecallConfig {
  return {
    enabled: true,
    agents: null,
    allowedChatTypes: ["direct", "group", "channel"],
    queryMode: "recent",
    promptStyle: "balanced",
    promptOverride: null,
    promptAppend: null,
    maxSummaryChars: 64,
    recentUserTurns: 2,
    recentAssistantTurns: 1,
    recentUserChars: 40,
    recentAssistantChars: 40,
    thinking: "low",
    timeoutMs: 5000,
    cacheTtlMs: 10000,
    persistTranscripts: false,
    transcriptDir: path.join(os.tmpdir(), "active-recall"),
    entityGraphDepth: 1,
    includeCausalTrajectories: false,
    includeDaySummary: false,
    attachRecallExplain: false,
    modelOverride: null,
    modelFallbackPolicy: "default-remote",
    ...overrides,
  };
}

function baseInput(overrides: Partial<ActiveRecallInput> = {}): ActiveRecallInput {
  return {
    sessionKey: "session-a",
    agentId: "main",
    chatType: "direct",
    recentTurns: [
      { role: "user", content: "We fixed the CI worker drain yesterday." },
      { role: "assistant", content: "I noted the flaky Redis worker." },
      { role: "user", content: "Please remember the root cause." },
    ],
    currentMessage: "What happened with CI?",
    ...overrides,
  };
}

test("buildActiveRecallQueryBundle respects message/recent/full modes", () => {
  const input = baseInput();
  assert.equal(
    buildActiveRecallQueryBundle(input, baseConfig({ queryMode: "message" })),
    "What happened with CI?",
  );
  const recent = buildActiveRecallQueryBundle(
    input,
    baseConfig({ queryMode: "recent" }),
  );
  assert.match(recent, /current: What happened with CI\?/);
  assert.match(recent, /user:/);
  const full = buildActiveRecallQueryBundle(
    input,
    baseConfig({ queryMode: "full" }),
  );
  assert.match(full, /assistant:/);
  assert.match(full, /current: What happened with CI\?/);
});

test("buildActiveRecallPrompt varies by prompt style and optional sections", () => {
  const prompt = buildActiveRecallPrompt({
    config: baseConfig({ promptStyle: "precision-heavy", promptAppend: "Prefer hard evidence." }),
    queryBundle: "current: What happened with CI?",
    recallContext: "CI failed after the worker pool exhausted sockets.",
    graphContext: ["entity edge"],
    causalContext: ["causal link"],
    daySummary: "Debugged worker drain all morning.",
    recallExplain: "graph_mode",
  });
  assert.match(prompt, /Bias toward precision/);
  assert.match(prompt, /Entity graph/);
  assert.match(prompt, /Prefer hard evidence/);
});

test("normalizeActiveRecallSummary collapses NONE variants and truncates codepoint-safe", () => {
  assert.equal(normalizeActiveRecallSummary("NONE", 20), null);
  assert.equal(normalizeActiveRecallSummary("  no relevant memory  ", 20), null);
  const truncated = normalizeActiveRecallSummary("emoji 😀😀😀 trail", 8);
  assert.equal(truncated, "emoji 😀😀");
});

test("active recall engine caches results and short-circuits repeated calls", async () => {
  let generateCalls = 0;
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "CI worker drain after Redis reconnect storm.";
      },
      getLastRecallSnapshot() {
        return { memoryIds: ["mem-1"] };
      },
      async generateSummary() {
        generateCalls++;
        return { text: "Redis reconnect storm caused the worker drain." };
      },
      now: (() => {
        let tick = 10_000;
        return () => tick++;
      })(),
    },
    baseConfig({ cacheTtlMs: 5000 }),
  );

  const first = await engine.run(baseInput());
  const second = await engine.run(baseInput());
  assert.equal(generateCalls, 1);
  assert.equal(first.summary, "Redis reconnect storm caused the worker drain.");
  assert.equal(second.summary, first.summary);
});

test("active recall engine walks graph/day-summary/explain hooks when enabled", async () => {
  let graphDepth = 0;
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "Primary recall";
      },
      async walkEntityGraph(params) {
        graphDepth = params.depth;
        return ["graph hit"];
      },
      async loadCausalTrajectories() {
        return ["causal hit"];
      },
      async loadDaySummary() {
        return "day summary";
      },
      async explainLastRecall() {
        return "explain";
      },
      async generateSummary({ prompt }) {
        assert.match(prompt, /graph hit/);
        assert.match(prompt, /causal hit/);
        assert.match(prompt, /day summary/);
        assert.match(prompt, /Recall explain/);
        return { text: "Combined summary" };
      },
    },
    baseConfig({
      includeCausalTrajectories: true,
      includeDaySummary: true,
      attachRecallExplain: true,
      entityGraphDepth: 2,
    }),
  );

  const result = await engine.run(baseInput());
  assert.equal(graphDepth, 2);
  assert.equal(result.summary, "Combined summary");
});

test("active recall engine normalizes timeout to NONE and persists transcripts when enabled", async () => {
  const transcriptDir = await mkdtemp(path.join(os.tmpdir(), "active-recall-transcript-"));
  const engine = createActiveRecallEngine(
    {
      async recall() {
        return "Primary recall";
      },
      async generateSummary() {
        return { text: "timeout", modelUsed: "gpt-5.2-mini" };
      },
    },
    baseConfig({
      persistTranscripts: true,
      transcriptDir,
    }),
  );

  const result = await engine.run(baseInput());
  assert.equal(result.summary, null);
  assert.ok(result.transcriptPath, "expected transcript file path");
  const raw = await readFile(result.transcriptPath ?? "", "utf8");
  assert.match(raw, /"queryMode":"recent"/);
  assert.match(raw, /"summary":null/);
});
