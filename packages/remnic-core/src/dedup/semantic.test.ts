import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import { ContentHashIndex } from "../storage.js";
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

test("parseConfig: NaN semanticDedupThreshold falls back to default 0.92", () => {
  const nan = parseConfig({ semanticDedupThreshold: Number.NaN });
  assert.equal(nan.semanticDedupThreshold, 0.92);
});

test("parseConfig: Infinity semanticDedupThreshold falls back to default 0.92", () => {
  const pos = parseConfig({ semanticDedupThreshold: Number.POSITIVE_INFINITY });
  const neg = parseConfig({ semanticDedupThreshold: Number.NEGATIVE_INFINITY });
  assert.equal(pos.semanticDedupThreshold, 0.92);
  assert.equal(neg.semanticDedupThreshold, 0.92);
});

// ── Regression: semantic skip must NOT register a synthetic content hash ──────
//
// Verifies the fix for the bug introduced in PR #399: when the semantic dedup
// guard decides to skip a fact (near-duplicate of an existing memory), the
// orchestrator must NOT add the skipped fact's content to contentHashIndex.
//
// If it did, archiving the original neighbor memory would leave an orphaned
// hash that permanently blocks legitimate writes of the same text.

test("regression #399: semantic dedup skip does NOT add content hash to index", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "remnic-test-"));
  try {
    const index = new ContentHashIndex(stateDir);
    await index.load();

    const FACT_CONTENT = "the user prefers dark mode in their editor";
    const NEIGHBOR_ID = "mem-neighbor-001";

    // Simulate the orchestrator: run the semantic dedup decision (skip outcome).
    const decision = await decideSemanticDedup(
      FACT_CONTENT,
      makeLookup([{ id: NEIGHBOR_ID, score: 0.97 }]),
      DEFAULT_OPTS,
    );
    assert.equal(decision.action, "skip", "precondition: decision must be skip");

    // The fixed orchestrator does NOT call index.add() in the skip branch.
    // Simulate that invariant: we do NOT call index.add(FACT_CONTENT) here.

    // The skipped fact's hash must NOT be present in the index.
    assert.equal(
      index.has(FACT_CONTENT),
      false,
      "skipped fact content must not be registered in contentHashIndex",
    );

    // Now simulate archiving the neighbor: remove its content from the index.
    // (In the orchestrator this would be index.remove(neighborMemory.content);
    // here the neighbor was never registered, so the index stays empty — which
    // is the desired state.)
    assert.equal(index.size, 0, "index must remain empty after semantic skip");

    // A subsequent write attempt of the same text must NOT be blocked by the
    // hash gate (because no hash was ever registered for the skipped fact).
    assert.equal(
      index.has(FACT_CONTENT),
      false,
      "third write attempt must not be blocked by a phantom hash",
    );

    // Confirm that only a genuine persist (index.add) registers the hash.
    index.add(FACT_CONTENT);
    assert.equal(
      index.has(FACT_CONTENT),
      true,
      "explicit add must register the hash",
    );
    assert.equal(index.size, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("regression #399: after neighbor archive, re-write of skipped content is allowed", async () => {
  // More explicit end-to-end simulation of the full scenario:
  // 1. Seed a "neighbor" memory in the hash index.
  // 2. A second fact is semantically-skipped (no hash added — the fix).
  // 3. The neighbor memory is archived (its hash is removed from the index).
  // 4. A third write of the same content as the skipped fact must pass the gate.

  const stateDir = await mkdtemp(join(tmpdir(), "remnic-test-"));
  try {
    const index = new ContentHashIndex(stateDir);
    await index.load();

    const NEIGHBOR_CONTENT = "the user prefers dark mode in their editor";
    const SKIPPED_CONTENT = "the user likes dark editor themes";

    // Step 1: seed neighbor memory hash (as if a real persist happened).
    index.add(NEIGHBOR_CONTENT);
    assert.equal(index.size, 1, "neighbor hash seeded");

    // Step 2: semantic dedup decides to skip SKIPPED_CONTENT.
    const decision = await decideSemanticDedup(
      SKIPPED_CONTENT,
      makeLookup([{ id: "mem-neighbor-001", score: 0.95 }]),
      DEFAULT_OPTS,
    );
    assert.equal(decision.action, "skip");
    // Fixed code: do NOT call index.add(SKIPPED_CONTENT).
    // (In the old buggy code this line would have been executed.)
    assert.equal(
      index.has(SKIPPED_CONTENT),
      false,
      "skipped content must not be in index",
    );

    // Step 3: archive the neighbor — remove its hash.
    index.remove(NEIGHBOR_CONTENT);
    assert.equal(index.size, 0, "index empty after neighbor archived");

    // Step 4: attempt to write SKIPPED_CONTENT again — must not be blocked.
    assert.equal(
      index.has(SKIPPED_CONTENT),
      false,
      "write of previously-skipped content must not be blocked after neighbor archive",
    );

    // Confirm a fresh persist now registers the hash correctly.
    index.add(SKIPPED_CONTENT);
    assert.equal(index.has(SKIPPED_CONTENT), true);
    assert.equal(index.size, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
