import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computePairId,
  writePair,
  writePairs,
  readPair,
  listPairs,
  isCoolingDown,
  resolvePair,
  type ContradictionPair,
} from "./contradiction-review.js";
import { _pairKey, _contentHash } from "./contradiction-judge.js";
import { isValidResolutionVerb } from "./resolution.js";
import { ACTIVE_STATUSES } from "./contradiction-scan.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function makeTempDir(prefix = "contradiction-test-"): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function makePair(overrides?: Partial<ContradictionPair>): Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] } {
  return {
    memoryIds: ["mem-a-001", "mem-b-002"],
    verdict: "contradicts",
    rationale: "Test rationale",
    confidence: 0.9,
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Pair ID determinism ────────────────────────────────────────────────────────

test("computePairId is deterministic and order-independent", () => {
  const ab = computePairId("a", "b");
  const ba = computePairId("b", "a");
  assert.equal(ab, ba, "Pair ID should be the same regardless of argument order");
});

test("computePairId produces different IDs for different pairs", () => {
  const ab = computePairId("a", "b");
  const ac = computePairId("a", "c");
  assert.notEqual(ab, ac);
});

// ── Review queue write/read ────────────────────────────────────────────────────

test("writePair and readPair round-trip", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const pair = makePair();
    const written = writePair(dir, pair);
    assert.ok(written.pairId, "Written pair should have a pairId");
    assert.deepEqual(written.memoryIds, pair.memoryIds);

    const read = readPair(dir, written.pairId);
    assert.ok(read, "Should read back the pair");
    assert.equal(read!.pairId, written.pairId);
    assert.equal(read!.verdict, "contradicts");
  } finally {
    await cleanup();
  }
});

test("writePair is idempotent", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const pair = makePair();
    const first = writePair(dir, pair);
    const second = writePair(dir, pair);
    assert.equal(first.pairId, second.pairId);
  } finally {
    await cleanup();
  }
});

test("writePair preserves user resolution", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const pair = makePair();
    const written = writePair(dir, pair);
    resolvePair(dir, written.pairId, "keep-a");

    const updated = writePair(dir, makePair({ memoryIds: ["mem-a-001", "mem-b-002"], confidence: 0.95 }));
    assert.equal(updated.resolution, "keep-a", "Should preserve existing resolution");
  } finally {
    await cleanup();
  }
});

// ── Batch dedup (rule 49) ──────────────────────────────────────────────────────

test("writePairs deduplicates batch inputs", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const pair = makePair();
    // Same pair submitted 3 times
    const results = writePairs(dir, [pair, pair, pair]);
    assert.equal(results.length, 1, "Should deduplicate identical pairs in batch");
  } finally {
    await cleanup();
  }
});

// ── List and filter ────────────────────────────────────────────────────────────

test("listPairs filters by verdict", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    writePair(dir, makePair({ verdict: "contradicts", memoryIds: ["a1", "b1"] }));
    writePair(dir, makePair({ verdict: "independent", memoryIds: ["a2", "b2"] }));
    writePair(dir, makePair({ verdict: "duplicates", memoryIds: ["a3", "b3"] }));

    const contradicts = listPairs(dir, { filter: "contradicts" });
    assert.equal(contradicts.pairs.length, 1);
    assert.equal(contradicts.pairs[0].verdict, "contradicts");

    const all = listPairs(dir, { filter: "all" });
    assert.equal(all.pairs.length, 3);
  } finally {
    await cleanup();
  }
});

test("listPairs respects limit", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    for (let i = 0; i < 5; i++) {
      writePair(dir, makePair({ memoryIds: [`a-${i}`, `b-${i}`] }));
    }
    const result = listPairs(dir, { filter: "all", limit: 2 });
    assert.equal(result.pairs.length, 2);
    assert.equal(result.total, 5, "total should reflect all matching pairs, not just returned");
  } finally {
    await cleanup();
  }
});

test("listPairs filters by namespace", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    writePair(dir, makePair({ namespace: "ns1", memoryIds: ["a1", "b1"] }));
    writePair(dir, makePair({ namespace: "ns2", memoryIds: ["a2", "b2"] }));

    const ns1 = listPairs(dir, { namespace: "ns1" });
    assert.equal(ns1.pairs.length, 1);
    assert.equal(ns1.pairs[0].namespace, "ns1");
  } finally {
    await cleanup();
  }
});

test("listPairs returns empty when dir does not exist", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const result = listPairs(path.join(dir, "nonexistent"));
    assert.equal(result.pairs.length, 0);
    assert.equal(result.total, 0);
  } finally {
    await cleanup();
  }
});

// ── Cooldown ───────────────────────────────────────────────────────────────────

test("isCoolingDown returns false when no lastReviewedAt", () => {
  const pair: ContradictionPair = {
    pairId: "test",
    memoryIds: ["a", "b"],
    verdict: "independent",
    rationale: "",
    confidence: 0.8,
    detectedAt: new Date().toISOString(),
  };
  assert.equal(isCoolingDown(pair, 14), false);
});

test("isCoolingDown returns true within cooldown window", () => {
  const pair: ContradictionPair = {
    pairId: "test",
    memoryIds: ["a", "b"],
    verdict: "independent",
    rationale: "",
    confidence: 0.8,
    detectedAt: new Date().toISOString(),
    lastReviewedAt: new Date().toISOString(),
  };
  assert.equal(isCoolingDown(pair, 14), true);
});

test("isCoolingDown returns false after cooldown expires", () => {
  const past = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const pair: ContradictionPair = {
    pairId: "test",
    memoryIds: ["a", "b"],
    verdict: "independent",
    rationale: "",
    confidence: 0.8,
    detectedAt: past,
    lastReviewedAt: past,
  };
  assert.equal(isCoolingDown(pair, 14), false);
});

test("isCoolingDown returns false when cooldownDays is 0 (rule 27)", () => {
  const pair: ContradictionPair = {
    pairId: "test",
    memoryIds: ["a", "b"],
    verdict: "independent",
    rationale: "",
    confidence: 0.8,
    detectedAt: new Date().toISOString(),
    lastReviewedAt: new Date().toISOString(),
  };
  assert.equal(isCoolingDown(pair, 0), false, "0 cooldownDays should disable cooldown");
});

// ── Resolution verbs ───────────────────────────────────────────────────────────

test("isValidResolutionVerb accepts valid verbs", () => {
  assert.equal(isValidResolutionVerb("keep-a"), true);
  assert.equal(isValidResolutionVerb("keep-b"), true);
  assert.equal(isValidResolutionVerb("merge"), true);
  assert.equal(isValidResolutionVerb("both-valid"), true);
  assert.equal(isValidResolutionVerb("needs-more-context"), true);
});

test("isValidResolutionVerb rejects invalid verbs", () => {
  assert.equal(isValidResolutionVerb("delete"), false);
  assert.equal(isValidResolutionVerb(""), false);
  assert.equal(isValidResolutionVerb("unknown"), false);
});

// ── resolvePair ────────────────────────────────────────────────────────────────

test("resolvePair sets resolution and lastReviewedAt", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const written = writePair(dir, makePair());
    const resolved = resolvePair(dir, written.pairId, "both-valid");
    assert.ok(resolved);
    assert.equal(resolved!.resolution, "both-valid");
    assert.ok(resolved!.lastReviewedAt);
  } finally {
    await cleanup();
  }
});

test("resolvePair returns null for nonexistent pair", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const result = resolvePair(dir, "nonexistent", "both-valid");
    assert.equal(result, null);
  } finally {
    await cleanup();
  }
});

// ── ACTIVE_STATUSES (rule 53) ──────────────────────────────────────────────────

test("ACTIVE_STATUSES contains only active", () => {
  assert.ok(ACTIVE_STATUSES.has("active"));
  assert.equal(ACTIVE_STATUSES.has("superseded"), false);
  assert.equal(ACTIVE_STATUSES.has("archived"), false);
  assert.equal(ACTIVE_STATUSES.has("quarantined"), false);
  assert.equal(ACTIVE_STATUSES.has("rejected"), false);
  assert.equal(ACTIVE_STATUSES.has("pending_review"), false);
});

// ── Judge helper: pairKey ──────────────────────────────────────────────────────

test("pairKey is order-independent", () => {
  assert.equal(_pairKey("a", "b"), _pairKey("b", "a"));
});

// ── Judge helper: contentHash ──────────────────────────────────────────────────

test("contentHash is deterministic", () => {
  const a = { memoryIdA: "1", memoryIdB: "2", textA: "hello", textB: "world" };
  const b = { memoryIdA: "1", memoryIdB: "2", textA: "hello", textB: "world" };
  assert.equal(_contentHash(a), _contentHash(b));
});

test("contentHash differs for different content", () => {
  const a = { memoryIdA: "1", memoryIdB: "2", textA: "hello", textB: "world" };
  const b = { memoryIdA: "1", memoryIdB: "2", textA: "goodbye", textB: "world" };
  assert.notEqual(_contentHash(a), _contentHash(b));
});

// ── JSON parse safety (rule 18) ────────────────────────────────────────────────

test("readPair returns null for invalid JSON", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const reviewDir = path.join(dir, ".review", "contradictions");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, "test-id.json"), "null");
    assert.equal(readPair(dir, "test-id"), null, "JSON.parse('null') should not be a valid pair");
  } finally {
    await cleanup();
  }
});

test("readPair returns null for non-object JSON", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const reviewDir = path.join(dir, ".review", "contradictions");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, "test-id.json"), '"a string"');
    assert.equal(readPair(dir, "test-id"), null);
  } finally {
    await cleanup();
  }
});
