import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../config.js";
import {
  decideSemanticDedup,
  type SemanticDedupHit,
  type SemanticDedupLookup,
  type SemanticDedupOptions,
} from "./semantic.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLookup(hits: SemanticDedupHit[]): SemanticDedupLookup {
  return async () => hits;
}

const DEFAULT_OPTS: SemanticDedupOptions = {
  enabled: true,
  threshold: 0.92,
  candidates: 5,
};

// ── decideSemanticDedup ───────────────────────────────────────────────────────

test("semantic dedup: returns keep/disabled when enabled flag is false", async () => {
  const decision = await decideSemanticDedup(
    "hello world",
    makeLookup([{ id: "m1", score: 0.99 }]),
    { ...DEFAULT_OPTS, enabled: false },
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "disabled");
});

test("semantic dedup: keeps content when lookup returns no hits (fail-open)", async () => {
  const decision = await decideSemanticDedup(
    "some novel statement",
    makeLookup([]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "backend_unavailable");
});

test("semantic dedup: keeps content when top score is below threshold", async () => {
  const decision = await decideSemanticDedup(
    "the user prefers tabs over spaces",
    makeLookup([
      { id: "m1", score: 0.82 },
      { id: "m2", score: 0.74 },
    ]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "no_near_duplicate");
  if (decision.action === "keep") {
    assert.equal(decision.topId, "m1");
    assert.equal(decision.topScore, 0.82);
  }
});

test("semantic dedup: skips content when top score meets threshold exactly", async () => {
  const decision = await decideSemanticDedup(
    "the user prefers tabs",
    makeLookup([{ id: "m1", score: 0.92 }]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.reason, "near_duplicate");
    assert.equal(decision.topId, "m1");
    assert.equal(decision.topScore, 0.92);
  }
});

test("semantic dedup: skips content when top score exceeds threshold", async () => {
  // Simulates a paraphrase that collides with an existing memory.
  const decision = await decideSemanticDedup(
    "tabs are preferred by the user for indentation",
    makeLookup([
      { id: "existing-pref-42", score: 0.96, path: "/tmp/pref.md" },
      { id: "existing-pref-43", score: 0.81 },
    ]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.topId, "existing-pref-42");
    assert.equal(decision.topPath, "/tmp/pref.md");
    assert.ok(decision.topScore >= 0.92);
  }
});

test("semantic dedup: picks highest-scoring hit even if unsorted", async () => {
  const decision = await decideSemanticDedup(
    "anything",
    makeLookup([
      { id: "m1", score: 0.5 },
      { id: "m2", score: 0.97 },
      { id: "m3", score: 0.6 },
    ]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "skip");
  if (decision.action === "skip") {
    assert.equal(decision.topId, "m2");
    assert.equal(decision.topScore, 0.97);
  }
});

test("semantic dedup: ignores non-finite scores", async () => {
  const decision = await decideSemanticDedup(
    "content",
    makeLookup([
      { id: "m1", score: Number.NaN },
      { id: "m2", score: Number.POSITIVE_INFINITY },
      { id: "m3", score: 0.5 },
    ]),
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "no_near_duplicate");
  if (decision.action === "keep") {
    assert.equal(decision.topId, "m3");
  }
});

test("semantic dedup: treats lookup throw as fail-open keep", async () => {
  const decision = await decideSemanticDedup(
    "content",
    async () => {
      throw new Error("network down");
    },
    DEFAULT_OPTS,
  );
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "backend_unavailable");
});

test("semantic dedup: empty/whitespace content never triggers lookup", async () => {
  let called = 0;
  const decision = await decideSemanticDedup(
    "   \n  ",
    async () => {
      called++;
      return [{ id: "m1", score: 0.99 }];
    },
    DEFAULT_OPTS,
  );
  assert.equal(called, 0);
  assert.equal(decision.action, "keep");
});

test("semantic dedup: candidates option is forwarded to lookup", async () => {
  let limitSeen = -1;
  await decideSemanticDedup(
    "anything",
    async (_content, limit) => {
      limitSeen = limit;
      return [];
    },
    { ...DEFAULT_OPTS, candidates: 11 },
  );
  assert.equal(limitSeen, 11);
});

test("semantic dedup: candidates=0 short-circuits without calling lookup", async () => {
  let called = 0;
  const decision = await decideSemanticDedup(
    "anything",
    async () => {
      called++;
      return [];
    },
    { ...DEFAULT_OPTS, candidates: 0 },
  );
  assert.equal(called, 0, "lookup must not be called when candidates=0");
  assert.equal(decision.action, "keep");
  assert.equal(decision.reason, "disabled");
});

// ── Config flag parsing ───────────────────────────────────────────────────────

test("parseConfig: semantic dedup flags default to enabled/0.92/5", () => {
  const config = parseConfig({});
  assert.equal(config.semanticDedupEnabled, true);
  assert.equal(config.semanticDedupThreshold, 0.92);
  assert.equal(config.semanticDedupCandidates, 5);
});

test("parseConfig: semantic dedup flags respect explicit settings", () => {
  const config = parseConfig({
    semanticDedupEnabled: false,
    semanticDedupThreshold: 0.88,
    semanticDedupCandidates: 10,
  });
  assert.equal(config.semanticDedupEnabled, false);
  assert.equal(config.semanticDedupThreshold, 0.88);
  assert.equal(config.semanticDedupCandidates, 10);
});

test("parseConfig: semantic dedup threshold clamps to [0, 1]", () => {
  const below = parseConfig({ semanticDedupThreshold: -0.5 });
  const above = parseConfig({ semanticDedupThreshold: 5 });
  assert.equal(below.semanticDedupThreshold, 0);
  assert.equal(above.semanticDedupThreshold, 1);
});

test("parseConfig: semanticDedupCandidates=0 is preserved (operator disable signal)", () => {
  const zero = parseConfig({ semanticDedupCandidates: 0 });
  assert.equal(zero.semanticDedupCandidates, 0);
});

test("parseConfig: negative semanticDedupCandidates falls back to default 5", () => {
  const negative = parseConfig({ semanticDedupCandidates: -3 });
  assert.equal(negative.semanticDedupCandidates, 5);
});

test("parseConfig: NaN semanticDedupCandidates falls back to default 5", () => {
  const nan = parseConfig({ semanticDedupCandidates: Number.NaN });
  assert.equal(nan.semanticDedupCandidates, 5);
});
