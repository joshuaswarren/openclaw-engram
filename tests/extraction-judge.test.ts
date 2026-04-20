import test from "node:test";
import assert from "node:assert/strict";
import {
  judgeFactDurability,
  clearVerdictCache,
  verdictCacheSize,
  validateProcedureExtraction,
  getVerdictKind,
  isDurableVerdict,
  isValidCachedVerdict,
  type JudgeCandidate,
  type JudgeVerdict,
  type JudgeVerdictKind,
} from "../packages/remnic-core/src/extraction-judge.ts";
import { parseConfig } from "../packages/remnic-core/src/config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
    openaiApiKey: "test-key",
    extractionJudgeEnabled: true,
    extractionJudgeBatchSize: 20,
    extractionJudgeShadow: false,
    ...overrides,
  });
}

function makeMockLocalLlm(response: string | null) {
  return {
    chatCompletion: async () =>
      response ? { content: response } : null,
  };
}

function makeMockFallbackLlm(response: string | null) {
  return {
    chatCompletion: async () =>
      response ? { content: response, modelUsed: "mock-model" } : null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("judge auto-approves correction category facts", async () => {
  clearVerdictCache();
  const candidates: JudgeCandidate[] = [
    { text: "Actually the API uses v3 not v2", category: "correction", confidence: 0.95 },
  ];
  const config = makeConfig();
  const result = await judgeFactDurability(candidates, config, null, null);

  assert.equal(result.verdicts.size, 1);
  assert.equal(result.verdicts.get(0)?.durable, true);
  assert.ok(result.verdicts.get(0)?.reason.includes("Auto-approved"));
  assert.equal(result.judged, 0, "Should not call LLM for auto-approved categories");
});

test("judge auto-approves principle category facts", async () => {
  clearVerdictCache();
  const candidates: JudgeCandidate[] = [
    { text: "Always use dependency injection", category: "principle", confidence: 0.9 },
  ];
  const config = makeConfig();
  const result = await judgeFactDurability(candidates, config, null, null);

  assert.equal(result.verdicts.size, 1);
  assert.equal(result.verdicts.get(0)?.durable, true);
  assert.ok(result.verdicts.get(0)?.reason.includes("principle"));
});

test("judge auto-approves critical importance facts", async () => {
  clearVerdictCache();
  const candidates: JudgeCandidate[] = [
    {
      text: "My name is Alex",
      category: "fact",
      confidence: 0.99,
      importanceLevel: "critical",
    },
  ];
  const config = makeConfig();
  const result = await judgeFactDurability(candidates, config, null, null);

  assert.equal(result.verdicts.size, 1);
  assert.equal(result.verdicts.get(0)?.durable, true);
  assert.ok(result.verdicts.get(0)?.reason.includes("critical"));
  assert.equal(result.judged, 0);
});

test("judge batches candidates correctly and respects batchSize", async () => {
  clearVerdictCache();
  let callCount = 0;
  const mockLocalLlm = {
    chatCompletion: async (_msgs: any) => {
      callCount++;
      // Parse the user prompt to find the indices and return verdicts
      const userMsg = _msgs[1].content;
      const items = JSON.parse(userMsg) as Array<{ index: number }>;
      const verdicts = items.map((item) => ({
        index: item.index,
        durable: true,
        reason: "Durable fact",
      }));
      return { content: JSON.stringify(verdicts) };
    },
  };

  const candidates: JudgeCandidate[] = [];
  for (let i = 0; i < 5; i++) {
    candidates.push({
      text: `Fact number ${i} about something durable`,
      category: "fact",
      confidence: 0.8,
      importanceLevel: "normal",
    });
  }

  const config = makeConfig({ extractionJudgeBatchSize: 3 });
  const result = await judgeFactDurability(
    candidates,
    config,
    mockLocalLlm as any,
    null,
  );

  assert.equal(result.verdicts.size, 5);
  // With batchSize=3 and 5 candidates, should be 2 LLM calls
  assert.equal(callCount, 2, "Should make 2 batch calls for 5 candidates with batchSize=3");
  assert.equal(result.judged, 5);
});

test("judge returns cached verdicts without LLM call", async () => {
  clearVerdictCache();
  let callCount = 0;
  const mockLocalLlm = {
    chatCompletion: async (_msgs: any) => {
      callCount++;
      const userMsg = _msgs[1].content;
      const items = JSON.parse(userMsg) as Array<{ index: number }>;
      const verdicts = items.map((item) => ({
        index: item.index,
        durable: true,
        reason: "Cached test",
      }));
      return { content: JSON.stringify(verdicts) };
    },
  };

  const candidates: JudgeCandidate[] = [
    { text: "Repeatable fact for caching", category: "fact", confidence: 0.8, importanceLevel: "normal" },
  ];

  const config = makeConfig();

  // First call should hit the LLM
  const result1 = await judgeFactDurability(candidates, config, mockLocalLlm as any, null);
  assert.equal(callCount, 1);
  assert.equal(result1.judged, 1);
  assert.equal(result1.cached, 0);

  // Second call with same content should use cache
  const result2 = await judgeFactDurability(candidates, config, mockLocalLlm as any, null);
  assert.equal(callCount, 1, "Should not make a second LLM call for cached content");
  assert.equal(result2.judged, 0);
  assert.equal(result2.cached, 1);
  assert.equal(result2.verdicts.get(0)?.durable, true);
});

test("judge filters non-durable facts in active mode", async () => {
  clearVerdictCache();
  const mockLocalLlm = {
    chatCompletion: async (_msgs: any) => {
      const userMsg = _msgs[1].content;
      const items = JSON.parse(userMsg) as Array<{ index: number; text: string }>;
      const verdicts = items.map((item) => ({
        index: item.index,
        durable: item.text.includes("durable"),
        reason: item.text.includes("durable") ? "Stable preference" : "Transient task state",
      }));
      return { content: JSON.stringify(verdicts) };
    },
  };

  const candidates: JudgeCandidate[] = [
    { text: "This is a durable preference", category: "preference", confidence: 0.9, importanceLevel: "high" },
    { text: "Currently running npm install", category: "fact", confidence: 0.6, importanceLevel: "normal" },
  ];

  const config = makeConfig();
  const result = await judgeFactDurability(candidates, config, mockLocalLlm as any, null);

  assert.equal(result.verdicts.size, 2);
  assert.equal(result.verdicts.get(0)?.durable, true);
  assert.equal(result.verdicts.get(1)?.durable, false);
  assert.equal(result.verdicts.get(1)?.reason, "Transient task state");
});

test("empty candidate list returns empty result", async () => {
  clearVerdictCache();
  const config = makeConfig();
  const result = await judgeFactDurability([], config, null, null);

  assert.equal(result.verdicts.size, 0);
  assert.equal(result.cached, 0);
  assert.equal(result.judged, 0);
  assert.equal(result.elapsed, 0);
});

test("judge fails open when LLM returns null", async () => {
  clearVerdictCache();
  const mockLocalLlm = {
    chatCompletion: async () => null,
  };

  const candidates: JudgeCandidate[] = [
    { text: "Some fact to judge", category: "fact", confidence: 0.7, importanceLevel: "normal" },
  ];

  const config = makeConfig();
  const result = await judgeFactDurability(candidates, config, mockLocalLlm as any, null);

  assert.equal(result.verdicts.size, 1);
  // Fail-open: fact should be approved
  assert.equal(result.verdicts.get(0)?.durable, true);
  assert.ok(result.verdicts.get(0)?.reason.includes("default"));
});

test("judge fails open when LLM throws", async () => {
  clearVerdictCache();
  const mockLocalLlm = {
    chatCompletion: async () => {
      throw new Error("LLM service unavailable");
    },
  };

  const candidates: JudgeCandidate[] = [
    { text: "Some fact to judge", category: "fact", confidence: 0.7, importanceLevel: "normal" },
  ];

  const config = makeConfig();
  const result = await judgeFactDurability(candidates, config, mockLocalLlm as any, null);

  assert.equal(result.verdicts.size, 1);
  assert.equal(result.verdicts.get(0)?.durable, true, "Should approve on LLM error (fail-open)");
});

test("judge falls back to fallback LLM when local fails", async () => {
  clearVerdictCache();
  let localCalled = false;
  let fallbackCalled = false;

  const mockLocalLlm = {
    chatCompletion: async () => {
      localCalled = true;
      throw new Error("local unavailable");
    },
  };

  const mockFallbackLlm = {
    chatCompletion: async (_msgs: any) => {
      fallbackCalled = true;
      const userMsg = _msgs[1].content;
      const items = JSON.parse(userMsg) as Array<{ index: number }>;
      const verdicts = items.map((item) => ({
        index: item.index,
        durable: true,
        reason: "Approved by fallback",
      }));
      return { content: JSON.stringify(verdicts), modelUsed: "fallback-model" };
    },
  };

  const candidates: JudgeCandidate[] = [
    { text: "A durable preference fact", category: "fact", confidence: 0.8, importanceLevel: "normal" },
  ];

  const config = makeConfig();
  const result = await judgeFactDurability(
    candidates,
    config,
    mockLocalLlm as any,
    mockFallbackLlm as any,
  );

  assert.equal(localCalled, true, "Should try local LLM first");
  assert.equal(fallbackCalled, true, "Should fall back to fallback LLM");
  assert.equal(result.verdicts.get(0)?.durable, true);
});

test("judge handles malformed LLM response gracefully", async () => {
  clearVerdictCache();
  const mockLocalLlm = {
    chatCompletion: async () => ({
      content: "This is not valid JSON at all!",
    }),
  };

  const candidates: JudgeCandidate[] = [
    { text: "Some fact", category: "fact", confidence: 0.7, importanceLevel: "normal" },
  ];

  const config = makeConfig();
  const result = await judgeFactDurability(candidates, config, mockLocalLlm as any, null);

  // Should fail-open
  assert.equal(result.verdicts.size, 1);
  assert.equal(result.verdicts.get(0)?.durable, true);
});

test("judge config disabled means function is never called in orchestrator context", async () => {
  // This tests the config gating — when extractionJudgeEnabled is false,
  // the orchestrator does not call judgeFactDurability at all.
  // We verify this by checking that parseConfig correctly defaults to false.
  const config = parseConfig({
    memoryDir: ".tmp/memory",
    workspaceDir: ".tmp/workspace",
  });
  assert.equal(config.extractionJudgeEnabled, false, "Judge should be disabled by default");
  assert.equal(config.extractionJudgeShadow, false, "Shadow mode should be disabled by default");
  assert.equal(config.extractionJudgeBatchSize, 20, "Default batch size should be 20");
  assert.equal(config.extractionJudgeModel, "", "Default model should be empty string");
});

test("verdict cache can be cleared", async () => {
  clearVerdictCache();
  assert.equal(verdictCacheSize(), 0);

  const mockLocalLlm = {
    chatCompletion: async (_msgs: any) => {
      const userMsg = _msgs[1].content;
      const items = JSON.parse(userMsg) as Array<{ index: number }>;
      return {
        content: JSON.stringify(
          items.map((item) => ({ index: item.index, durable: true, reason: "test" })),
        ),
      };
    },
  };

  const candidates: JudgeCandidate[] = [
    { text: "Cache test fact", category: "fact", confidence: 0.8, importanceLevel: "normal" },
  ];

  const config = makeConfig();
  await judgeFactDurability(candidates, config, mockLocalLlm as any, null);
  assert.ok(verdictCacheSize() > 0, "Cache should have entries after judging");

  clearVerdictCache();
  assert.equal(verdictCacheSize(), 0, "Cache should be empty after clearing");
});

test("judge mixed batch: auto-approved + LLM-judged", async () => {
  clearVerdictCache();
  let llmCallItems: any[] = [];
  const mockLocalLlm = {
    chatCompletion: async (_msgs: any) => {
      const userMsg = _msgs[1].content;
      llmCallItems = JSON.parse(userMsg);
      const verdicts = llmCallItems.map((item: any) => ({
        index: item.index,
        durable: false,
        reason: "Transient state",
      }));
      return { content: JSON.stringify(verdicts) };
    },
  };

  const candidates: JudgeCandidate[] = [
    { text: "Correction: use v3 API", category: "correction", confidence: 0.95 },
    { text: "Currently debugging line 42", category: "fact", confidence: 0.5, importanceLevel: "normal" },
    { text: "Always test before deploy", category: "principle", confidence: 0.9 },
    { text: "Running npm install now", category: "fact", confidence: 0.4, importanceLevel: "low" },
    { text: "Critical identity info", category: "fact", confidence: 0.99, importanceLevel: "critical" },
  ];

  const config = makeConfig();
  const result = await judgeFactDurability(candidates, config, mockLocalLlm as any, null);

  assert.equal(result.verdicts.size, 5);

  // Index 0: correction => auto-approved
  assert.equal(result.verdicts.get(0)?.durable, true);
  assert.ok(result.verdicts.get(0)?.reason.includes("Auto-approved"));

  // Index 1: normal fact => LLM judged as not durable
  assert.equal(result.verdicts.get(1)?.durable, false);

  // Index 2: principle => auto-approved
  assert.equal(result.verdicts.get(2)?.durable, true);

  // Index 3: low importance fact => LLM judged as not durable
  assert.equal(result.verdicts.get(3)?.durable, false);

  // Index 4: critical => auto-approved
  assert.equal(result.verdicts.get(4)?.durable, true);

  // Only indices 1 and 3 should have been sent to the LLM
  assert.equal(llmCallItems.length, 2, "Only non-auto-approved facts should go to LLM");
  assert.deepEqual(
    llmCallItems.map((i: any) => i.index),
    [1, 3],
  );
});

test("judge elapsed time is reported", async () => {
  clearVerdictCache();
  const mockLocalLlm = {
    chatCompletion: async (_msgs: any) => {
      const userMsg = _msgs[1].content;
      const items = JSON.parse(userMsg) as Array<{ index: number }>;
      return {
        content: JSON.stringify(
          items.map((item) => ({ index: item.index, durable: true, reason: "ok" })),
        ),
      };
    },
  };

  const candidates: JudgeCandidate[] = [
    { text: "Measure elapsed", category: "fact", confidence: 0.8, importanceLevel: "normal" },
  ];

  const config = makeConfig();
  const result = await judgeFactDurability(candidates, config, mockLocalLlm as any, null);
  assert.ok(typeof result.elapsed === "number");
  assert.ok(result.elapsed >= 0);
});

test("validateProcedureExtraction approves two steps with trigger phrasing", () => {
  const v = validateProcedureExtraction({
    content: "When you deploy to production, follow this checklist.",
    procedureSteps: [
      { order: 1, intent: "Run the test suite" },
      { order: 2, intent: "Push the release tag" },
    ],
  });
  assert.equal(v.durable, true);
});

test("validateProcedureExtraction rejects fewer than two steps", () => {
  const v = validateProcedureExtraction({
    content: "When you deploy, do the thing.",
    procedureSteps: [{ order: 1, intent: "Only one step" }],
  });
  assert.equal(v.durable, false);
});

test("validateProcedureExtraction rejects missing trigger phrasing", () => {
  const v = validateProcedureExtraction({
    content: "Release checklist for the service.",
    procedureSteps: [
      { order: 1, intent: "Run tests" },
      { order: 2, intent: "Tag release" },
    ],
  });
  assert.equal(v.durable, false);
});

// ---------------------------------------------------------------------------
// Issue #562 PR 1 — defer verdict kind (type extension only, no behavior yet)
// ---------------------------------------------------------------------------

test("JudgeVerdictKind union accepts accept/reject/defer", () => {
  // Compile-time check: all three literals are assignable to JudgeVerdictKind.
  const accept: JudgeVerdictKind = "accept";
  const reject: JudgeVerdictKind = "reject";
  const defer: JudgeVerdictKind = "defer";
  assert.equal(accept, "accept");
  assert.equal(reject, "reject");
  assert.equal(defer, "defer");
});

test("JudgeVerdict accepts optional kind: 'defer'", () => {
  // Compile-time check: a verdict with kind="defer" is a valid JudgeVerdict.
  const v: JudgeVerdict = {
    durable: false,
    reason: "Ambiguous referent, revisit next turn",
    kind: "defer",
  };
  assert.equal(v.kind, "defer");
  assert.equal(v.durable, false);
});

test("getVerdictKind infers accept from durable=true when kind is absent", () => {
  const v: JudgeVerdict = { durable: true, reason: "Stable preference" };
  assert.equal(getVerdictKind(v), "accept");
});

test("getVerdictKind infers reject from durable=false when kind is absent", () => {
  const v: JudgeVerdict = { durable: false, reason: "Transient state" };
  assert.equal(getVerdictKind(v), "reject");
});

test("getVerdictKind returns explicit kind when set", () => {
  const accept: JudgeVerdict = { durable: true, reason: "ok", kind: "accept" };
  const reject: JudgeVerdict = { durable: false, reason: "no", kind: "reject" };
  const defer: JudgeVerdict = { durable: false, reason: "maybe", kind: "defer" };
  assert.equal(getVerdictKind(accept), "accept");
  assert.equal(getVerdictKind(reject), "reject");
  assert.equal(getVerdictKind(defer), "defer");
});

test("getVerdictKind ignores unknown kind values and falls back to durable", () => {
  // Forward-compat: an older build reading a future cache entry whose
  // `kind` is an unrecognised string must not crash — it should fall
  // back to the boolean.
  const unknown = {
    durable: true,
    reason: "future-kind",
    kind: "some-future-kind",
  } as unknown as JudgeVerdict;
  assert.equal(getVerdictKind(unknown), "accept");
});

test("isDurableVerdict is true only for accept", () => {
  assert.equal(
    isDurableVerdict({ durable: true, reason: "", kind: "accept" }),
    true,
  );
  assert.equal(
    isDurableVerdict({ durable: false, reason: "", kind: "reject" }),
    false,
  );
  assert.equal(
    isDurableVerdict({ durable: false, reason: "", kind: "defer" }),
    false,
    "Defer is not durable — caller should re-evaluate, not persist",
  );
  // Legacy shape without kind still works via durable fallback.
  assert.equal(isDurableVerdict({ durable: true, reason: "" }), true);
  assert.equal(isDurableVerdict({ durable: false, reason: "" }), false);
});

test("isValidCachedVerdict accepts legacy entries without kind", () => {
  // Simulates a cache entry produced before PR 1 — only durable + reason.
  const legacy = { durable: true, reason: "pre-PR1 entry" };
  assert.equal(isValidCachedVerdict(legacy), true);
});

test("isValidCachedVerdict accepts new entries with known kind", () => {
  assert.equal(
    isValidCachedVerdict({ durable: true, reason: "ok", kind: "accept" }),
    true,
  );
  assert.equal(
    isValidCachedVerdict({ durable: false, reason: "no", kind: "reject" }),
    true,
  );
  assert.equal(
    isValidCachedVerdict({ durable: false, reason: "maybe", kind: "defer" }),
    true,
  );
});

test("isValidCachedVerdict rejects entries with unknown kind", () => {
  assert.equal(
    isValidCachedVerdict({ durable: true, reason: "x", kind: "bogus" }),
    false,
  );
});

test("isValidCachedVerdict rejects structurally invalid entries", () => {
  assert.equal(isValidCachedVerdict(null), false);
  assert.equal(isValidCachedVerdict(undefined), false);
  assert.equal(isValidCachedVerdict("string"), false);
  assert.equal(isValidCachedVerdict({}), false);
  assert.equal(isValidCachedVerdict({ durable: "yes", reason: "x" }), false);
  assert.equal(isValidCachedVerdict({ durable: true }), false);
  assert.equal(isValidCachedVerdict({ reason: "x" }), false);
});

test("verdict cache loads legacy entries correctly via judgeFactDurability", async () => {
  // Seed a caller-provided cache with a legacy (pre-PR-1) entry — no kind
  // field. The judge must serve it from cache and the orchestrator-style
  // consumer (checking `durable`) must keep working.
  clearVerdictCache();
  const cache = new Map<string, JudgeVerdict>();

  const candidate: JudgeCandidate = {
    text: "Legacy-cached fact body",
    category: "fact",
    confidence: 0.8,
    importanceLevel: "normal",
  };
  // Mirror the internal cacheKey() helper: sha256 of "text\0category".
  const { createHash } = await import("node:crypto");
  const key = createHash("sha256")
    .update(`${candidate.text}\0${candidate.category}`)
    .digest("hex");
  cache.set(key, { durable: true, reason: "legacy entry without kind" });

  // LLM mock that would explode the test if called — serving from cache
  // should be hit-only.
  let llmCalled = false;
  const mockLocalLlm = {
    chatCompletion: async () => {
      llmCalled = true;
      return { content: "[]" };
    },
  };

  const config = makeConfig();
  const result = await judgeFactDurability(
    [candidate],
    config,
    mockLocalLlm as any,
    null,
    cache,
  );

  assert.equal(llmCalled, false, "Legacy cache hit must not call LLM");
  assert.equal(result.cached, 1);
  const v = result.verdicts.get(0);
  assert.ok(v, "verdict should be present");
  assert.equal(v!.durable, true);
  assert.equal(v!.reason, "legacy entry without kind");
  assert.equal(
    getVerdictKind(v!),
    "accept",
    "Legacy verdict should infer accept from durable=true",
  );
});

test("no emit path in current judge produces defer (PR 1 is type-only)", async () => {
  // Sanity: with a mock LLM that returns a well-formed durable/not-durable
  // response, the returned verdicts only carry accept/reject-equivalent
  // shapes. Defer is not emitted until PR 2 adds the capable prompt.
  clearVerdictCache();
  const mockLocalLlm = {
    chatCompletion: async (_msgs: any) => {
      const userMsg = _msgs[1].content;
      const items = JSON.parse(userMsg) as Array<{ index: number; text: string }>;
      const verdicts = items.map((item) => ({
        index: item.index,
        durable: item.text.includes("durable"),
        reason: "mock",
      }));
      return { content: JSON.stringify(verdicts) };
    },
  };

  const candidates: JudgeCandidate[] = [
    { text: "A durable preference fact", category: "fact", confidence: 0.8, importanceLevel: "normal" },
    { text: "Transient build state", category: "fact", confidence: 0.5, importanceLevel: "normal" },
  ];
  const config = makeConfig();
  const result = await judgeFactDurability(
    candidates,
    config,
    mockLocalLlm as any,
    null,
  );

  for (const v of result.verdicts.values()) {
    assert.notEqual(
      v.kind,
      "defer",
      "PR 1 must not emit defer — defer-capable prompt lands in PR 2",
    );
    assert.notEqual(
      getVerdictKind(v),
      "defer",
      "PR 1 must not emit defer even via inference",
    );
  }
});
