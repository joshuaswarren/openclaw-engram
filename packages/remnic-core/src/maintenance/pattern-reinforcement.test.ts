/**
 * Unit tests for the pattern-reinforcement maintenance job
 * (issue #687 PR 2/4).
 *
 * Uses an in-memory storage stub so tests focus on clustering /
 * supersession / idempotency behavior without booting a full
 * StorageManager. Storage round-trip for the new frontmatter fields is
 * covered separately in `storage.test.ts`-style coverage that
 * exercises `serializeFrontmatter` + `parseFrontmatter`.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";

import {
  patternReinforcementKey,
  runPatternReinforcement,
  type PatternReinforcementStorage,
} from "./pattern-reinforcement.js";
import { StorageManager } from "../storage.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";

interface StubWriteCall {
  memoryId: string;
  patch: Partial<MemoryFrontmatter>;
}

function makeMemory(overrides: Partial<MemoryFrontmatter> & { content?: string } = {}): MemoryFile {
  const { content, ...fmOverrides } = overrides;
  const id = fmOverrides.id ?? "m-default";
  return {
    path: `/tmp/mem/${id}.md`,
    content: content ?? "synthetic body",
    frontmatter: {
      id,
      category: "preference",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "high",
      tags: [],
      ...fmOverrides,
    } as MemoryFrontmatter,
  };
}

function makeStorageStub(memories: MemoryFile[]): {
  stub: PatternReinforcementStorage;
  writes: StubWriteCall[];
} {
  const writes: StubWriteCall[] = [];
  // Mutate the in-memory list so re-runs see the previous patch
  // (mirrors real on-disk semantics needed by the idempotency test).
  const stub: PatternReinforcementStorage = {
    readAllMemories: async () => memories,
    writeMemoryFrontmatter: async (memory, patch) => {
      writes.push({ memoryId: memory.frontmatter.id, patch });
      memory.frontmatter = { ...memory.frontmatter, ...patch };
      return true;
    },
  };
  return { stub, writes };
}

const FROZEN_NOW = new Date("2026-04-25T12:00:00.000Z");
const frozenNow = () => FROZEN_NOW;

test("patternReinforcementKey lowercases, collapses whitespace, truncates to 200 chars", () => {
  assert.equal(patternReinforcementKey("  Hello   WORLD  "), "hello world");
  const long = "x".repeat(300);
  assert.equal(patternReinforcementKey(long).length, 200);
  assert.equal(
    patternReinforcementKey("Mixed\nCase\tWith\r\nLines"),
    "mixed case with lines",
  );
});

test("runPatternReinforcement: clusters duplicates, marks canonical + supersedes older", async () => {
  // 5 duplicates with the same normalized content across different
  // sessions/timestamps + 1 unique memory that should remain
  // untouched.
  const dupContent = "I prefer dark mode for all editors.";
  const dups = [
    makeMemory({ id: "m-1", content: dupContent, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "m-2", content: dupContent, created: "2026-02-01T00:00:00Z", updated: "2026-02-01T00:00:00Z" }),
    makeMemory({ id: "m-3", content: dupContent, created: "2026-03-01T00:00:00Z", updated: "2026-03-01T00:00:00Z" }),
    makeMemory({ id: "m-4", content: dupContent, created: "2026-04-01T00:00:00Z", updated: "2026-04-01T00:00:00Z" }),
    makeMemory({ id: "m-5", content: dupContent, created: "2026-04-15T00:00:00Z", updated: "2026-04-15T00:00:00Z" }),
  ];
  const unique = makeMemory({
    id: "m-unique",
    content: "Completely different preference about tabs vs spaces.",
    created: "2026-03-10T00:00:00Z",
    updated: "2026-03-10T00:00:00Z",
  });
  const { stub, writes } = makeStorageStub([...dups, unique]);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference", "fact", "decision"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  assert.equal(result.canonicalsUpdated, 1);
  assert.equal(result.duplicatesSuperseded, 4);
  assert.equal(result.clusters.length, 1);

  const cluster = result.clusters[0];
  // Most-recent member wins.
  assert.equal(cluster.canonicalId, "m-5");
  assert.equal(cluster.count, 5);
  assert.deepEqual(cluster.sourceIds, ["m-1", "m-2", "m-3", "m-4", "m-5"]);
  assert.deepEqual(cluster.supersededIds.slice().sort(), ["m-1", "m-2", "m-3", "m-4"]);

  // Canonical was patched with reinforcement metadata.
  const canonicalWrite = writes.find((w) => w.memoryId === "m-5");
  assert.ok(canonicalWrite);
  assert.equal(canonicalWrite!.patch.reinforcement_count, 5);
  assert.equal(canonicalWrite!.patch.last_reinforced_at, FROZEN_NOW.toISOString());
  assert.equal(canonicalWrite!.patch.derived_via, "pattern-reinforcement");
  assert.deepEqual(canonicalWrite!.patch.derived_from, ["m-1", "m-2", "m-3", "m-4", "m-5"]);

  // Each duplicate was marked superseded with supersededBy set.
  for (const id of ["m-1", "m-2", "m-3", "m-4"]) {
    const w = writes.find((w) => w.memoryId === id);
    assert.ok(w, `expected supersede write for ${id}`);
    assert.equal(w!.patch.status, "superseded");
    assert.equal(w!.patch.supersededBy, "m-5");
    assert.equal(w!.patch.supersededAt, FROZEN_NOW.toISOString());
  }

  // Unique memory was NOT touched.
  assert.ok(!writes.some((w) => w.memoryId === "m-unique"));
});

test("runPatternReinforcement: idempotent re-run does not double-bump reinforcement_count", async () => {
  const dupContent = "Same content, repeated";
  const memories = [
    makeMemory({ id: "m-a", content: dupContent, updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "m-b", content: dupContent, updated: "2026-02-01T00:00:00Z" }),
    makeMemory({ id: "m-c", content: dupContent, updated: "2026-03-01T00:00:00Z" }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const first = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });
  assert.equal(first.canonicalsUpdated, 1);
  assert.equal(first.duplicatesSuperseded, 2);
  assert.equal(first.clusters[0]?.reinforcementBumped, true);

  // Second run on the same corpus.  After the first run, the older
  // members are `superseded` — but the cluster STILL counts them
  // toward the threshold (Codex P1 fix), so the cluster is found
  // again with size 3 and no new active duplicates remain.  Because
  // `reinforcement_count` is already 3, the bump-only-on-change
  // guard keeps the run a no-op write-wise.
  const writesBefore = writes.length;
  const second = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });
  assert.equal(second.clustersFound, 1);
  assert.equal(second.canonicalsUpdated, 0);
  assert.equal(second.duplicatesSuperseded, 0);
  assert.equal(second.clusters[0]?.reinforcementBumped, false);
  // No additional writes.
  assert.equal(writes.length, writesBefore);
});

test("runPatternReinforcement: established canonical grows when a single new duplicate arrives (Codex P1)", async () => {
  // Models the exact post-first-run scenario the Codex review flagged:
  // canonical + 2 already-superseded members + 1 brand-new active
  // duplicate.  The new duplicate must be absorbed and the count
  // bumped to 4, even though the active sub-cluster size is only 2.
  const dupContent = "established pattern";
  const memories = [
    makeMemory({
      id: "m-old1",
      content: dupContent,
      updated: "2026-01-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-canon",
    }),
    makeMemory({
      id: "m-old2",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-canon",
    }),
    makeMemory({
      id: "m-canon",
      content: dupContent,
      updated: "2026-03-01T00:00:00Z",
      reinforcement_count: 3,
      last_reinforced_at: "2026-03-01T00:00:00.000Z",
      derived_via: "pattern-reinforcement",
      derived_from: ["m-canon", "m-old1", "m-old2"],
    }),
    // A brand-new active duplicate from a later session.
    makeMemory({
      id: "m-new",
      content: dupContent,
      updated: "2026-04-15T00:00:00Z",
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  assert.equal(result.canonicalsUpdated, 1);
  assert.equal(result.duplicatesSuperseded, 1);
  assert.equal(result.clusters[0]?.count, 4);
  assert.equal(result.clusters[0]?.reinforcementBumped, true);
  // The most-recent active member becomes the new canonical.
  assert.equal(result.clusters[0]?.canonicalId, "m-new");
  // Source-ids include every member of the historical cluster.
  assert.deepEqual(
    result.clusters[0]?.sourceIds.slice().sort(),
    ["m-canon", "m-new", "m-old1", "m-old2"],
  );
  // The new active member was patched as canonical with count=4.
  const canonicalWrite = writes.find((w) => w.memoryId === "m-new");
  assert.ok(canonicalWrite);
  assert.equal(canonicalWrite!.patch.reinforcement_count, 4);
  // The previous canonical (still active before the run) was
  // superseded.
  const oldCanonWrite = writes.find((w) => w.memoryId === "m-canon");
  assert.ok(oldCanonWrite);
  assert.equal(oldCanonWrite!.patch.status, "superseded");
  assert.equal(oldCanonWrite!.patch.supersededBy, "m-new");
});

test("runPatternReinforcement: re-run with existing reinforcement_count does not bump when count unchanged", async () => {
  // Simulate a corpus where the canonical was previously reinforced
  // at count=3 and a later run sees the same cluster of 3 active
  // memories. (Edge case: status filter would normally have shrunk
  // the active set to 1, but if upstream policy un-supersedes some,
  // the bump-only-on-change guard still holds.)
  const dupContent = "stable cluster";
  const memories = [
    makeMemory({
      id: "m-x",
      content: dupContent,
      updated: "2026-01-01T00:00:00Z",
    }),
    makeMemory({
      id: "m-y",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
    }),
    makeMemory({
      id: "m-z",
      content: dupContent,
      updated: "2026-03-01T00:00:00Z",
      reinforcement_count: 3,
      last_reinforced_at: "2026-03-01T00:00:00.000Z",
      derived_via: "pattern-reinforcement",
      derived_from: ["m-x", "m-y", "m-z"],
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 1);
  // Reinforcement count is identical (3), so we MUST NOT bump.
  assert.equal(result.canonicalsUpdated, 0);
  assert.equal(result.clusters[0]?.reinforcementBumped, false);
  // No write to the canonical for reinforcement; supersede writes
  // for the older two ARE expected since they were still active.
  const canonicalWrites = writes.filter((w) => w.memoryId === "m-z");
  assert.equal(canonicalWrites.length, 0);
});

test("runPatternReinforcement: respects minCount threshold", async () => {
  const dupContent = "pair of duplicates";
  const memories = [
    makeMemory({ id: "m-1", content: dupContent, updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "m-2", content: dupContent, updated: "2026-02-01T00:00:00Z" }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 0);
  assert.equal(writes.length, 0);
});

test("runPatternReinforcement: skips out-of-scope categories", async () => {
  const dupContent = "procedural duplicate";
  const memories = [
    makeMemory({ id: "p-1", category: "procedure" as MemoryFrontmatter["category"], content: dupContent, updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "p-2", category: "procedure" as MemoryFrontmatter["category"], content: dupContent, updated: "2026-02-01T00:00:00Z" }),
    makeMemory({ id: "p-3", category: "procedure" as MemoryFrontmatter["category"], content: dupContent, updated: "2026-03-01T00:00:00Z" }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference", "fact", "decision"],
    minCount: 3,
    now: frozenNow,
  });

  assert.equal(result.clustersFound, 0);
  assert.equal(writes.length, 0);
});

test("runPatternReinforcement: counts both active and already-superseded members; only writes to active duplicates", async () => {
  const dupContent = "mixed status cluster";
  const memories = [
    makeMemory({
      id: "m-old1",
      content: dupContent,
      updated: "2026-01-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-prior",
    }),
    makeMemory({
      id: "m-old2",
      content: dupContent,
      updated: "2026-02-01T00:00:00Z",
      status: "superseded",
      supersededBy: "m-prior",
    }),
    makeMemory({
      id: "m-new1",
      content: dupContent,
      updated: "2026-03-01T00:00:00Z",
    }),
    makeMemory({
      id: "m-new2",
      content: dupContent,
      updated: "2026-04-01T00:00:00Z",
    }),
    makeMemory({
      id: "m-new3",
      content: dupContent,
      updated: "2026-04-15T00:00:00Z",
    }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: ["preference"],
    minCount: 3,
    now: frozenNow,
  });

  // All 5 cluster members count toward the threshold (Codex P1).
  assert.equal(result.clustersFound, 1);
  assert.equal(result.clusters[0]?.canonicalId, "m-new3");
  assert.equal(result.clusters[0]?.count, 5);
  // sourceIds includes every member, active and superseded.
  assert.deepEqual(result.clusters[0]?.sourceIds.slice().sort(), [
    "m-new1",
    "m-new2",
    "m-new3",
    "m-old1",
    "m-old2",
  ]);
  // Only the active duplicates were newly superseded — pre-existing
  // superseded memories are not re-touched.
  assert.deepEqual(
    result.clusters[0]?.supersededIds.slice().sort(),
    ["m-new1", "m-new2"],
  );
  // Already-superseded memories are NOT written to.
  assert.ok(!writes.some((w) => w.memoryId === "m-old1"));
  assert.ok(!writes.some((w) => w.memoryId === "m-old2"));
});

test("runPatternReinforcement: empty categories short-circuits with no work", async () => {
  const memories = [
    makeMemory({ id: "m-1", content: "anything", updated: "2026-01-01T00:00:00Z" }),
    makeMemory({ id: "m-2", content: "anything", updated: "2026-02-01T00:00:00Z" }),
    makeMemory({ id: "m-3", content: "anything", updated: "2026-03-01T00:00:00Z" }),
  ];
  const { stub, writes } = makeStorageStub(memories);

  const result = await runPatternReinforcement(stub, {
    categories: [],
    minCount: 3,
    now: frozenNow,
  });
  assert.equal(result.clustersFound, 0);
  assert.equal(writes.length, 0);
});

test("frontmatter round-trip preserves reinforcement_count + last_reinforced_at + derived_via=pattern-reinforcement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-pr-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const written = await storage.writeMemory(
      "fact",
      "Pattern-reinforcement round-trip body",
      { confidence: 0.9, tags: ["test"] },
    );
    assert.ok(written, "writeMemory must succeed");
    const id = written!;

    const all1 = await storage.readAllMemories();
    const target = all1.find((m) => m.frontmatter.id === id);
    assert.ok(target, "freshly-written memory must be visible");

    const ok = await storage.writeMemoryFrontmatter(target!, {
      reinforcement_count: 5,
      last_reinforced_at: "2026-04-25T12:00:00.000Z",
      derived_from: ["m-a", "m-b", "m-c", "m-d", "m-e"],
      derived_via: "pattern-reinforcement",
    });
    assert.ok(ok);

    // Force a fresh read off disk.
    storage.invalidateAllMemoriesCacheForDir();
    const all2 = await storage.readAllMemories();
    const reread = all2.find((m) => m.frontmatter.id === id);
    assert.ok(reread, "memory must still be readable after patch");
    assert.equal(reread!.frontmatter.reinforcement_count, 5);
    assert.equal(reread!.frontmatter.last_reinforced_at, "2026-04-25T12:00:00.000Z");
    assert.equal(reread!.frontmatter.derived_via, "pattern-reinforcement");
    assert.deepEqual(
      reread!.frontmatter.derived_from,
      ["m-a", "m-b", "m-c", "m-d", "m-e"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storage rejects non-positive or non-integer reinforcement_count on write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-pr-validate-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const id = await storage.writeMemory("fact", "Body for validation test.", {
      confidence: 0.9,
      tags: [],
    });
    assert.ok(id);

    await assert.rejects(
      () => storage.updateMemoryFrontmatter(id!, { reinforcement_count: 0 }),
      /reinforcement_count/,
    );
    await assert.rejects(
      () => storage.updateMemoryFrontmatter(id!, { reinforcement_count: -1 }),
      /reinforcement_count/,
    );
    await assert.rejects(
      () => storage.updateMemoryFrontmatter(id!, { reinforcement_count: 1.5 }),
      /reinforcement_count/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
