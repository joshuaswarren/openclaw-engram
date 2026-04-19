import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LastRecallStore } from "./recall-state.js";
import type { RecallTierExplain } from "./types.js";

async function freshStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-state-"));
  const store = new LastRecallStore(dir);
  await store.load();
  return { store, dir };
}

// ── Tier-explain field is optional and absent by default ───────────────────

test("LastRecallStore.record omits tierExplain when caller did not provide it", async () => {
  const { store } = await freshStore();
  await store.record({ sessionKey: "s1", query: "q", memoryIds: [] });
  const snap = store.get("s1");
  assert.ok(snap);
  assert.equal(snap.tierExplain, undefined);
});

// ── Tier-explain is persisted and round-trips through disk ─────────────────

test("LastRecallStore.record persists tierExplain and round-trips to JSON on disk", async () => {
  const { store, dir } = await freshStore();
  const tierExplain: RecallTierExplain = {
    tier: "direct-answer",
    tierReason: "trusted decisions, unambiguous, token-overlap 0.86",
    filteredBy: ["below-token-overlap-floor"],
    candidatesConsidered: 4,
    latencyMs: 12,
    sourceAnchors: [{ path: "/memory/pm.md", lineRange: [10, 14] }],
  };

  await store.record({
    sessionKey: "s1",
    query: "package manager remnic",
    memoryIds: ["pm"],
    tierExplain,
  });

  const snap = store.get("s1");
  assert.ok(snap);
  assert.deepEqual(snap.tierExplain, tierExplain);

  // Confirm disk shape matches the in-memory snapshot.
  const raw = await readFile(path.join(dir, "state", "last_recall.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, { tierExplain?: RecallTierExplain }>;
  assert.deepEqual(parsed["s1"]?.tierExplain, tierExplain);
});

// ── Defensive copies isolate the stored snapshot from caller mutation ──────

test("LastRecallStore.record copies filteredBy so caller mutation does not tear the snapshot", async () => {
  const { store } = await freshStore();
  const filteredBy = ["below-importance-floor"];
  const tierExplain: RecallTierExplain = {
    tier: "direct-answer",
    tierReason: "unambiguous",
    filteredBy,
    candidatesConsidered: 2,
    latencyMs: 5,
  };

  await store.record({
    sessionKey: "s1",
    query: "q",
    memoryIds: [],
    tierExplain,
  });

  // Mutate the caller's array after record() returns.
  filteredBy.push("not-trusted-zone");

  const snap = store.get("s1");
  assert.deepEqual(snap?.tierExplain?.filteredBy, ["below-importance-floor"]);
});

test("LastRecallStore.get returns a defensive copy; mutation does not tear the store", async () => {
  // Regression for PR #535 review: get() previously returned a live
  // reference to internal state, so a caller that mutated memoryIds,
  // budgetsApplied.includedSections, or tierExplain fields would
  // corrupt subsequent reads.
  const { store } = await freshStore();
  await store.record({
    sessionKey: "s1",
    query: "q",
    memoryIds: ["m-1"],
    budgetsApplied: {
      appliedTopK: 1,
      recallBudgetChars: 8000,
      maxMemoryTokens: 2000,
      includedSections: ["profile", "recent"],
    },
    tierExplain: {
      tier: "direct-answer",
      tierReason: "unambiguous",
      filteredBy: ["below-token-overlap-floor"],
      candidatesConsidered: 3,
      latencyMs: 7,
      sourceAnchors: [{ path: "/a.md", lineRange: [2, 5] }],
    },
  });

  const snap = store.get("s1");
  assert.ok(snap);
  // Mutate every mutable field on the returned copy.
  snap.memoryIds.push("leak");
  snap.budgetsApplied?.includedSections?.push("leak");
  snap.tierExplain?.filteredBy.push("leak");
  const firstAnchor = snap.tierExplain?.sourceAnchors?.[0];
  if (firstAnchor?.lineRange) firstAnchor.lineRange[0] = 999;

  const fresh = store.get("s1");
  assert.deepEqual(fresh?.memoryIds, ["m-1"]);
  assert.deepEqual(fresh?.budgetsApplied?.includedSections, ["profile", "recent"]);
  assert.deepEqual(fresh?.tierExplain?.filteredBy, ["below-token-overlap-floor"]);
  assert.deepEqual(fresh?.tierExplain?.sourceAnchors?.[0]?.lineRange, [2, 5]);
});

test("LastRecallStore.getMostRecent returns a defensive copy", async () => {
  const { store } = await freshStore();
  await store.record({
    sessionKey: "s1",
    query: "q",
    memoryIds: ["m-1"],
  });
  const snap = store.getMostRecent();
  assert.ok(snap);
  snap.memoryIds.push("leak");

  const fresh = store.getMostRecent();
  assert.deepEqual(fresh?.memoryIds, ["m-1"]);
});

test("LastRecallStore.record copies memoryIds so caller mutation does not tear the snapshot", async () => {
  const { store } = await freshStore();
  const memoryIds = ["m-1"];
  await store.record({ sessionKey: "s1", query: "q", memoryIds });
  memoryIds.push("leak");
  const snap = store.get("s1");
  assert.deepEqual(snap?.memoryIds, ["m-1"]);
});

test("LastRecallStore.annotateTierExplain attaches tierExplain to an existing snapshot", async () => {
  const { store, dir } = await freshStore();
  await store.record({ sessionKey: "s1", query: "q", memoryIds: ["m-1"] });

  const explain: RecallTierExplain = {
    tier: "direct-answer",
    tierReason: "trusted decision, unambiguous",
    filteredBy: [],
    candidatesConsidered: 1,
    latencyMs: 4,
  };
  await store.annotateTierExplain("s1", explain);

  const snap = store.get("s1");
  assert.ok(snap);
  assert.deepEqual(snap.tierExplain, explain);

  // Round-trips to disk.
  const raw = await readFile(path.join(dir, "state", "last_recall.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, { tierExplain?: RecallTierExplain }>;
  assert.deepEqual(parsed["s1"]?.tierExplain, explain);
});

test("LastRecallStore.annotateTierExplain is a no-op when the session has no snapshot", async () => {
  const { store } = await freshStore();
  await store.annotateTierExplain("ghost", {
    tier: "direct-answer",
    tierReason: "",
    filteredBy: [],
    candidatesConsidered: 0,
    latencyMs: 0,
  });
  assert.equal(store.get("ghost"), null);
});

test("LastRecallStore.annotateTierExplain deep-copies the caller's block", async () => {
  const { store } = await freshStore();
  await store.record({ sessionKey: "s1", query: "q", memoryIds: [] });

  const filteredBy = ["a"];
  await store.annotateTierExplain("s1", {
    tier: "direct-answer",
    tierReason: "",
    filteredBy,
    candidatesConsidered: 0,
    latencyMs: 0,
  });
  filteredBy.push("leak");

  const snap = store.get("s1");
  assert.deepEqual(snap?.tierExplain?.filteredBy, ["a"]);
});

// ── Stale-snapshot guard on annotateTierExplain ─────────────────────────────

test("LastRecallStore.annotateTierExplain drops write when expected traceId no longer matches", async () => {
  // Regression for PR #540 review: back-to-back recalls on the same
  // sessionKey overwrite the snapshot, so an async observation that
  // enqueued against the earlier snapshot must not overwrite the newer
  // one with a stale tier-explain block.
  const { store } = await freshStore();
  await store.record({
    sessionKey: "s1",
    query: "q1",
    memoryIds: [],
    traceId: "trace-1",
  });
  const capturedIdentity = { traceId: "trace-1" };
  // Simulate a second recall landing before the observation from
  // recall #1 resolves — the stored snapshot is replaced with a new
  // traceId.
  await store.record({
    sessionKey: "s1",
    query: "q2",
    memoryIds: [],
    traceId: "trace-2",
  });

  await store.annotateTierExplain(
    "s1",
    {
      tier: "direct-answer",
      tierReason: "stale",
      filteredBy: [],
      candidatesConsidered: 7,
      latencyMs: 1,
    },
    capturedIdentity,
  );

  const snap = store.get("s1");
  assert.ok(snap);
  // Snapshot must still reflect the newer query and must NOT carry
  // the stale observation's tier-explain block.
  assert.equal(snap.traceId, "trace-2");
  assert.equal(snap.tierExplain, undefined);
});

test("LastRecallStore.annotateTierExplain writes when expected traceId matches", async () => {
  const { store } = await freshStore();
  await store.record({
    sessionKey: "s1",
    query: "q1",
    memoryIds: [],
    traceId: "trace-1",
  });

  await store.annotateTierExplain(
    "s1",
    {
      tier: "direct-answer",
      tierReason: "fresh",
      filteredBy: [],
      candidatesConsidered: 2,
      latencyMs: 3,
    },
    { traceId: "trace-1" },
  );

  const snap = store.get("s1");
  assert.ok(snap);
  assert.equal(snap.tierExplain?.tierReason, "fresh");
});

test("LastRecallStore.annotateTierExplain falls back to recordedAt when traceId is absent", async () => {
  const { store } = await freshStore();
  await store.record({
    sessionKey: "s1",
    query: "q1",
    memoryIds: [],
  });
  const current = store.get("s1");
  assert.ok(current);
  const staleRecordedAt = "1970-01-01T00:00:00.000Z";

  // Mismatched recordedAt → write is dropped.
  await store.annotateTierExplain(
    "s1",
    {
      tier: "direct-answer",
      tierReason: "stale",
      filteredBy: [],
      candidatesConsidered: 0,
      latencyMs: 0,
    },
    { recordedAt: staleRecordedAt },
  );
  assert.equal(store.get("s1")?.tierExplain, undefined);

  // Matching recordedAt → write succeeds.
  await store.annotateTierExplain(
    "s1",
    {
      tier: "direct-answer",
      tierReason: "fresh",
      filteredBy: [],
      candidatesConsidered: 0,
      latencyMs: 0,
    },
    { recordedAt: current.recordedAt },
  );
  assert.equal(store.get("s1")?.tierExplain?.tierReason, "fresh");
});

test("LastRecallStore.record copies sourceAnchors array and lineRange tuple", async () => {
  const { store } = await freshStore();
  const anchors: RecallTierExplain["sourceAnchors"] = [
    { path: "/a.md", lineRange: [1, 2] },
  ];
  const tierExplain: RecallTierExplain = {
    tier: "direct-answer",
    tierReason: "ok",
    filteredBy: [],
    candidatesConsidered: 1,
    latencyMs: 1,
    sourceAnchors: anchors,
  };

  await store.record({
    sessionKey: "s1",
    query: "q",
    memoryIds: [],
    tierExplain,
  });

  // Mutate original.
  anchors!.push({ path: "/b.md" });
  const firstAnchor = anchors![0];
  if (firstAnchor?.lineRange) firstAnchor.lineRange[0] = 99;

  const snap = store.get("s1");
  assert.equal(snap?.tierExplain?.sourceAnchors?.length, 1);
  assert.equal(snap?.tierExplain?.sourceAnchors?.[0]?.path, "/a.md");
  assert.deepEqual(snap?.tierExplain?.sourceAnchors?.[0]?.lineRange, [1, 2]);
});
