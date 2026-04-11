import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import {
  applyTemporalSupersession,
  computeSupersessionKey,
  lookupAttributeByNormalizedKey,
  normalizeSupersessionKey,
  shouldFilterSupersededFromRecall,
  shouldSupersedeExisting,
  supersessionKeysForFact,
} from "./temporal-supersession.js";
import type { MemoryFrontmatter } from "./types.js";

const TEST_ENTITY = "project-x";

async function makeStorage(prefix = "engram-temporal-supersession-"): Promise<{
  storage: StorageManager;
  memoryDir: string;
  cleanup: () => Promise<void>;
}> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const storage = new StorageManager(memoryDir);
  await storage.ensureDirectories();
  // Clear any cached state from previous runs to avoid cross-test leakage.
  StorageManager.clearAllStaticCaches();
  storage.invalidateAllMemoriesCacheForDir();
  return {
    storage,
    memoryDir,
    cleanup: async () => {
      StorageManager.clearAllStaticCaches();
      await rm(memoryDir, { recursive: true, force: true });
    },
  };
}

async function writeFact(
  storage: StorageManager,
  content: string,
  entityRef: string,
  attrs: Record<string, string>,
): Promise<string> {
  return storage.writeMemory("fact", content, {
    entityRef,
    structuredAttributes: attrs,
    source: "test",
    confidence: 0.9,
    tags: [],
  });
}

async function readFrontmatterById(
  storage: StorageManager,
  id: string,
): Promise<MemoryFrontmatter | null> {
  storage.invalidateAllMemoriesCacheForDir();
  const mems = await storage.readAllMemories();
  return mems.find((m) => m.frontmatter.id === id)?.frontmatter ?? null;
}

test("computeSupersessionKey normalizes entity + attribute", () => {
  assert.equal(
    computeSupersessionKey("Project X", "City"),
    "project-x::city",
  );
  assert.equal(
    computeSupersessionKey("  project-x ", "  city "),
    "project-x::city",
  );
  assert.equal(computeSupersessionKey(undefined, "city"), null);
  assert.equal(computeSupersessionKey("entity", ""), null);
});

test("supersessionKeysForFact returns all keys for structured attributes", () => {
  const keys = supersessionKeysForFact({
    entityRef: "user-1",
    structuredAttributes: { city: "Austin", tool: "vim" },
  });
  assert.deepEqual(keys.sort(), ["user-1::city", "user-1::tool"]);
});

test("supersessionKeysForFact returns [] when inputs are missing", () => {
  assert.deepEqual(supersessionKeysForFact({}), []);
  assert.deepEqual(
    supersessionKeysForFact({ entityRef: "user-1" }),
    [],
  );
  assert.deepEqual(
    supersessionKeysForFact({ structuredAttributes: { city: "NYC" } }),
    [],
  );
});

test("shouldSupersedeExisting only matches older conflicting values for same entity", () => {
  const baseFm = (overrides: Partial<MemoryFrontmatter>): MemoryFrontmatter => ({
    id: "fact-old-1",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    entityRef: TEST_ENTITY,
    structuredAttributes: { city: "Austin" },
    status: "active",
    ...overrides,
  });

  // conflicting value — matches
  const conflict = shouldSupersedeExisting({
    candidate: baseFm({}),
    newEntityRef: TEST_ENTITY,
    newAttributes: { city: "NYC" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-new-1",
  });
  assert.ok(conflict);
  assert.deepEqual(conflict?.matchedKeys, [`${TEST_ENTITY}::city`]);

  // identical value — no supersession
  const sameValue = shouldSupersedeExisting({
    candidate: baseFm({}),
    newEntityRef: TEST_ENTITY,
    newAttributes: { city: "Austin" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-new-1",
  });
  assert.equal(sameValue, null);

  // different entity — no supersession
  const diffEntity = shouldSupersedeExisting({
    candidate: baseFm({ entityRef: "other-entity" }),
    newEntityRef: TEST_ENTITY,
    newAttributes: { city: "NYC" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-new-1",
  });
  assert.equal(diffEntity, null);

  // already superseded — skip
  const alreadySuperseded = shouldSupersedeExisting({
    candidate: baseFm({ status: "superseded" }),
    newEntityRef: TEST_ENTITY,
    newAttributes: { city: "NYC" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-new-1",
  });
  assert.equal(alreadySuperseded, null);

  // newer than new fact — skip
  const newerCandidate = shouldSupersedeExisting({
    candidate: baseFm({ created: "2026-03-01T00:00:00.000Z" }),
    newEntityRef: TEST_ENTITY,
    newAttributes: { city: "NYC" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-new-1",
  });
  assert.equal(newerCandidate, null);
});

test("shouldSupersedeExisting only fires on overlapping attribute keys", () => {
  const candidateFm: MemoryFrontmatter = {
    id: "fact-old-1",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    entityRef: TEST_ENTITY,
    structuredAttributes: { city: "Austin", tool: "vim" },
    status: "active",
  };

  // city conflicts, tool does not overlap with the new fact's attributes
  const decision = shouldSupersedeExisting({
    candidate: candidateFm,
    newEntityRef: TEST_ENTITY,
    newAttributes: { city: "NYC" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-new-1",
  });
  assert.ok(decision);
  assert.deepEqual(decision?.matchedKeys, [`${TEST_ENTITY}::city`]);
});

test("shouldFilterSupersededFromRecall respects enabled + includeInRecall", () => {
  const superseded: MemoryFrontmatter = {
    id: "fact-1",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    status: "superseded",
  };

  // enabled + not included => filter
  assert.equal(
    shouldFilterSupersededFromRecall(superseded, {
      enabled: true,
      includeInRecall: false,
    }),
    true,
  );

  // disabled => never filter
  assert.equal(
    shouldFilterSupersededFromRecall(superseded, {
      enabled: false,
      includeInRecall: false,
    }),
    false,
  );

  // includeInRecall opt-in => never filter
  assert.equal(
    shouldFilterSupersededFromRecall(superseded, {
      enabled: true,
      includeInRecall: true,
    }),
    false,
  );

  // active memory => never filter
  const active: MemoryFrontmatter = { ...superseded, status: "active" };
  assert.equal(
    shouldFilterSupersededFromRecall(active, {
      enabled: true,
      includeInRecall: false,
    }),
    false,
  );
});

test("applyTemporalSupersession: city update retires old fact, leaves unrelated fact alone", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const oldCity = await writeFact(
      storage,
      "project X is based in Austin",
      TEST_ENTITY,
      { city: "Austin" },
    );
    // Ensure the new fact has a strictly greater created timestamp.  The
    // filename contains Date.now() so adding a small delay is sufficient for
    // monotonic ISO timestamps at millisecond resolution.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const unrelated = await writeFact(
      storage,
      "project X uses vim as editor",
      TEST_ENTITY,
      { tool: "vim" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newCity = await writeFact(
      storage,
      "project X relocated to NYC",
      TEST_ENTITY,
      { city: "NYC" },
    );

    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newCity,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: new Date().toISOString(),
      enabled: true,
    });

    assert.deepEqual(result.supersededIds, [oldCity]);
    assert.deepEqual(result.matchedKeys, [`${TEST_ENTITY}::city`]);

    const oldFm = await readFrontmatterById(storage, oldCity);
    assert.equal(oldFm?.status, "superseded");
    assert.equal(oldFm?.supersededBy, newCity);
    assert.ok(oldFm?.supersededAt, "supersededAt should be populated");

    const unrelatedFm = await readFrontmatterById(storage, unrelated);
    assert.equal(unrelatedFm?.status ?? "active", "active");

    const newFm = await readFrontmatterById(storage, newCity);
    assert.equal(newFm?.status ?? "active", "active");
  } finally {
    await cleanup();
  }
});

test("applyTemporalSupersession: no structured attributes is a no-op", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const oldFact = await storage.writeMemory(
      "fact",
      "project X is based in Austin",
      {
        entityRef: TEST_ENTITY,
        source: "test",
        confidence: 0.9,
        tags: [],
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newFact = await storage.writeMemory(
      "fact",
      "project X uses vim",
      {
        entityRef: TEST_ENTITY,
        source: "test",
        confidence: 0.9,
        tags: [],
      },
    );

    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newFact,
      entityRef: TEST_ENTITY,
      structuredAttributes: undefined,
      createdAt: new Date().toISOString(),
      enabled: true,
    });

    assert.deepEqual(result.supersededIds, []);
    assert.deepEqual(result.matchedKeys, []);

    const oldFm = await readFrontmatterById(storage, oldFact);
    assert.equal(oldFm?.status ?? "active", "active");
  } finally {
    await cleanup();
  }
});

test("applyTemporalSupersession: only overlapping attribute keys are superseded", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const oldMulti = await writeFact(
      storage,
      "project X was in Austin and used vim",
      TEST_ENTITY,
      { city: "Austin", tool: "vim" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newCityOnly = await writeFact(
      storage,
      "project X moved to NYC",
      TEST_ENTITY,
      { city: "NYC" },
    );

    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newCityOnly,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: new Date().toISOString(),
      enabled: true,
    });

    assert.deepEqual(result.supersededIds, [oldMulti]);
    assert.deepEqual(result.matchedKeys, [`${TEST_ENTITY}::city`]);

    // The old fact is marked superseded (its city no longer current).  The
    // tool attribute survives by virtue of the surviving older fact still
    // being on disk — the supersession linkage points to newCityOnly.
    const oldFm = await readFrontmatterById(storage, oldMulti);
    assert.equal(oldFm?.status, "superseded");
    assert.equal(oldFm?.supersededBy, newCityOnly);
  } finally {
    await cleanup();
  }
});

test("applyTemporalSupersession: disabled flag is a no-op", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    const oldCity = await writeFact(
      storage,
      "project X in Austin",
      TEST_ENTITY,
      { city: "Austin" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newCity = await writeFact(
      storage,
      "project X in NYC",
      TEST_ENTITY,
      { city: "NYC" },
    );

    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newCity,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: new Date().toISOString(),
      enabled: false,
    });

    assert.deepEqual(result.supersededIds, []);
    const oldFm = await readFrontmatterById(storage, oldCity);
    assert.equal(oldFm?.status ?? "active", "active");
  } finally {
    await cleanup();
  }
});

test("shouldFilterSupersededFromRecall: includeInRecall=true returns both superseded and current", () => {
  // Simulate a mix of candidate memories flowing through the recall filter.
  const supersededFm: MemoryFrontmatter = {
    id: "fact-old",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    status: "superseded",
  };
  const activeFm: MemoryFrontmatter = {
    ...supersededFm,
    id: "fact-new",
    status: "active",
  };

  // Default recall excludes superseded.
  const defaultFiltered = [supersededFm, activeFm].filter(
    (fm) =>
      !shouldFilterSupersededFromRecall(fm, {
        enabled: true,
        includeInRecall: false,
      }),
  );
  assert.deepEqual(
    defaultFiltered.map((fm) => fm.id),
    ["fact-new"],
  );

  // Opt-in returns both.
  const auditFiltered = [supersededFm, activeFm].filter(
    (fm) =>
      !shouldFilterSupersededFromRecall(fm, {
        enabled: true,
        includeInRecall: true,
      }),
  );
  assert.deepEqual(
    auditFiltered.map((fm) => fm.id),
    ["fact-old", "fact-new"],
  );
});

// ─── Regression: Finding 2 — case/whitespace-normalized attribute key lookup ──

test("lookupAttributeByNormalizedKey: exact match works", () => {
  assert.equal(lookupAttributeByNormalizedKey({ city: "Austin" }, "city"), "Austin");
});

test("lookupAttributeByNormalizedKey: mixed-case key is found", () => {
  assert.equal(lookupAttributeByNormalizedKey({ City: "Austin" }, "city"), "Austin");
  assert.equal(lookupAttributeByNormalizedKey({ CITY: "Austin" }, "City"), "Austin");
});

test("lookupAttributeByNormalizedKey: whitespace-padded key is found", () => {
  assert.equal(lookupAttributeByNormalizedKey({ " city ": "Austin" }, "city"), "Austin");
  assert.equal(lookupAttributeByNormalizedKey({ city: "Austin" }, " city "), "Austin");
});

test("lookupAttributeByNormalizedKey: missing key returns undefined", () => {
  assert.equal(lookupAttributeByNormalizedKey({ tool: "vim" }, "city"), undefined);
});

test("shouldSupersedeExisting: mixed-case attribute keys trigger supersession", () => {
  // Candidate stored key is "City" (mixed-case), new fact uses "city" (lower).
  const candidateFm: MemoryFrontmatter = {
    id: "fact-old-mixed",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    entityRef: TEST_ENTITY,
    structuredAttributes: { City: "NYC" },
    status: "active",
  };

  const decision = shouldSupersedeExisting({
    candidate: candidateFm,
    newEntityRef: TEST_ENTITY,
    newAttributes: { city: "Austin" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-new-mixed",
  });
  assert.ok(decision, "mixed-case key should trigger supersession");
  assert.deepEqual(decision?.matchedKeys, [`${TEST_ENTITY}::city`]);
});

test("shouldSupersedeExisting: whitespace-padded attribute keys trigger supersession", () => {
  // Candidate stored key has surrounding whitespace.
  const candidateFm: MemoryFrontmatter = {
    id: "fact-old-ws",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    entityRef: TEST_ENTITY,
    structuredAttributes: { " city ": "NYC" },
    status: "active",
  };

  const decision = shouldSupersedeExisting({
    candidate: candidateFm,
    newEntityRef: TEST_ENTITY,
    newAttributes: { city: "Austin" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-new-ws",
  });
  assert.ok(decision, "whitespace-padded key should trigger supersession");
  assert.deepEqual(decision?.matchedKeys, [`${TEST_ENTITY}::city`]);
});

test("shouldSupersedeExisting: identical values with mixed-case keys are a no-op", () => {
  const candidateFm: MemoryFrontmatter = {
    id: "fact-old-same",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    entityRef: TEST_ENTITY,
    structuredAttributes: { City: "Austin" },
    status: "active",
  };

  const decision = shouldSupersedeExisting({
    candidate: candidateFm,
    newEntityRef: TEST_ENTITY,
    newAttributes: { city: "Austin" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-new-same",
  });
  assert.equal(decision, null, "identical values (case-insensitive match) should not supersede");
});

// ─── Regression: Finding 1 — persisted frontmatter.created for ordering ───────

test("applyTemporalSupersession: uses persisted frontmatter.created, old memory is superseded when T0 < T1", async () => {
  // Seed an existing memory with a known T0 timestamp.  Then write a newer
  // memory (T1 > T0) and call applyTemporalSupersession.  The old memory
  // must be marked superseded regardless of when the wall clock is sampled.
  const { storage, cleanup } = await makeStorage("engram-temporal-t0-t1-");
  try {
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-02-01T00:00:00.000Z";

    // Write old fact (T0).
    const oldId = await writeFact(storage, "entity lives in Austin", TEST_ENTITY, { city: "Austin" });
    // Manually patch the created timestamp to T0 so the test is deterministic.
    storage.invalidateAllMemoriesCacheForDir();
    const oldMem = (await storage.readAllMemories()).find((m) => m.frontmatter.id === oldId);
    assert.ok(oldMem, "old memory should exist");
    await storage.writeMemoryFrontmatter(oldMem!, { created: t0, updated: t0 });

    // Write new fact — its persisted created will be T1-ish (we patch it too).
    const newId = await writeFact(storage, "entity moved to NYC", TEST_ENTITY, { city: "NYC" });
    storage.invalidateAllMemoriesCacheForDir();
    const newMem = (await storage.readAllMemories()).find((m) => m.frontmatter.id === newId);
    assert.ok(newMem, "new memory should exist");
    await storage.writeMemoryFrontmatter(newMem!, { created: t1, updated: t1 });

    // Pass a stale wall-clock time that is EARLIER than T0 — the fix should
    // ignore this in favour of the on-disk T1 for the new memory.
    const staleWallClock = "2025-12-01T00:00:00.000Z"; // before T0

    storage.invalidateAllMemoriesCacheForDir();
    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: staleWallClock,
      enabled: true,
    });

    // With the fix the persisted T1 is used, so old (T0) is correctly older.
    assert.deepEqual(result.supersededIds, [oldId], "old fact (T0) should be superseded by new fact (T1)");

    const oldFm = await readFrontmatterById(storage, oldId);
    assert.equal(oldFm?.status, "superseded");
    assert.equal(oldFm?.supersededBy, newId);
  } finally {
    await cleanup();
  }
});

test("applyTemporalSupersession: supersededAt/updated are monotonic when wall clock is stale", async () => {
  // Finding 2 regression: when the caller-supplied `createdAt` is earlier
  // than the old memory's persisted `created`, the written `supersededAt`
  // must not predate the old memory's own createdAt — otherwise the
  // supersession event appears to occur before the fact it supersedes.
  //
  // Setup: old fact persisted at T_old = 2026-04-11T12:00:00Z.
  // New fact persisted at T_new = 2026-04-11T13:00:00Z (newer — so old is
  // eligible for supersession).
  // Caller passes stale wall-clock createdAt = 2026-04-11T11:00:00Z
  // (earlier than BOTH).  The written supersededAt must equal the max of
  // the three (T_new = 13:00), never the stale 11:00.
  const { storage, cleanup } = await makeStorage("engram-temporal-monotonic-");
  try {
    const tOld = "2026-04-11T12:00:00.000Z";
    const tNew = "2026-04-11T13:00:00.000Z";
    const staleWallClock = "2026-04-11T11:00:00.000Z";

    // Write old fact and patch created to T_old.
    const oldId = await writeFact(storage, "entity lives in Austin", TEST_ENTITY, { city: "Austin" });
    storage.invalidateAllMemoriesCacheForDir();
    const oldMem = (await storage.readAllMemories()).find((m) => m.frontmatter.id === oldId);
    assert.ok(oldMem);
    await storage.writeMemoryFrontmatter(oldMem!, { created: tOld, updated: tOld });

    // Write new fact and patch created to T_new (so persisted T_new > T_old).
    const newId = await writeFact(storage, "entity moved to NYC", TEST_ENTITY, { city: "NYC" });
    storage.invalidateAllMemoriesCacheForDir();
    const newMem = (await storage.readAllMemories()).find((m) => m.frontmatter.id === newId);
    assert.ok(newMem);
    await storage.writeMemoryFrontmatter(newMem!, { created: tNew, updated: tNew });

    storage.invalidateAllMemoriesCacheForDir();
    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: staleWallClock, // stale — earlier than both persisted timestamps
      enabled: true,
    });

    assert.deepEqual(result.supersededIds, [oldId], "old fact should still be superseded");

    const oldFm = await readFrontmatterById(storage, oldId);
    assert.equal(oldFm?.status, "superseded");
    assert.equal(oldFm?.supersededBy, newId);
    // The written supersededAt / updated must be the monotonic max — the
    // new fact's persisted T_new — NOT the stale wall-clock value.
    assert.equal(
      oldFm?.supersededAt,
      tNew,
      "supersededAt must be the monotonic max of (old.created, new.created, args.createdAt)",
    );
    assert.equal(
      oldFm?.updated,
      tNew,
      "updated must match supersededAt after supersession",
    );

    // Sanity check: supersededAt is never earlier than the old fact's own
    // createdAt — time must not run backwards.
    const oldCreatedMs = new Date(oldFm!.created).getTime();
    const supersededAtMs = new Date(oldFm!.supersededAt!).getTime();
    assert.ok(
      supersededAtMs >= oldCreatedMs,
      `supersededAt (${oldFm?.supersededAt}) must not predate created (${oldFm?.created})`,
    );
  } finally {
    await cleanup();
  }
});

test("applyTemporalSupersession: stale extraction (new write has T0, existing has T1) does not supersede existing", async () => {
  // Simulate stale extraction: an existing memory has T1 (newer) but a new
  // write arrives with T0 (older persisted created).  The existing T1 memory
  // should NOT be superseded because it is newer.
  const { storage, cleanup } = await makeStorage("engram-temporal-stale-");
  try {
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-02-01T00:00:00.000Z";

    // Write "existing" fact and patch to T1.
    const existingId = await writeFact(storage, "entity lives in NYC", TEST_ENTITY, { city: "NYC" });
    storage.invalidateAllMemoriesCacheForDir();
    const existingMem = (await storage.readAllMemories()).find((m) => m.frontmatter.id === existingId);
    assert.ok(existingMem);
    await storage.writeMemoryFrontmatter(existingMem!, { created: t1, updated: t1 });

    // Write "stale" fact and patch to T0 (older).
    const staleId = await writeFact(storage, "entity lived in Austin", TEST_ENTITY, { city: "Austin" });
    storage.invalidateAllMemoriesCacheForDir();
    const staleMem = (await storage.readAllMemories()).find((m) => m.frontmatter.id === staleId);
    assert.ok(staleMem);
    await storage.writeMemoryFrontmatter(staleMem!, { created: t0, updated: t0 });

    storage.invalidateAllMemoriesCacheForDir();
    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: staleId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "Austin" },
      createdAt: new Date().toISOString(), // wall-clock, should be overridden by persisted T0
      enabled: true,
    });

    // The stale write (T0) is older than the existing memory (T1), so it
    // cannot supersede it.
    assert.deepEqual(result.supersededIds, [], "stale write (T0) must not supersede newer existing (T1)");

    const existingFm = await readFrontmatterById(storage, existingId);
    assert.equal(existingFm?.status ?? "active", "active", "newer existing fact should remain active");
  } finally {
    await cleanup();
  }
});

test("applyTemporalSupersession: CAS re-read skips candidate already superseded by concurrent writer", async () => {
  // Simulates two writers racing: writer A reads the memory snapshot, decides
  // to supersede candidate X, but before A actually patches X, writer B beats
  // A to it and marks X superseded with B's id.  A must notice on re-read and
  // skip the write so it does not clobber B's supersededBy link.
  //
  // We emulate the race by intercepting `readAllMemories` so that it returns
  // a stale "active" snapshot, then mutate disk with the concurrent writer's
  // patch.  applyTemporalSupersession's CAS re-read via readMemoryByPath()
  // will see the real disk state and must skip the write.
  const { storage, cleanup } = await makeStorage("engram-temporal-cas-");
  try {
    const oldCity = await writeFact(
      storage,
      "entity lives in Austin",
      TEST_ENTITY,
      { city: "Austin" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newCityA = await writeFact(
      storage,
      "entity moved to NYC",
      TEST_ENTITY,
      { city: "NYC" },
    );

    // Capture the snapshot writer A "sees" — both memories active.
    storage.invalidateAllMemoriesCacheForDir();
    const snapshot = await storage.readAllMemories();
    const staleSnapshot = snapshot.map((m) => ({
      path: m.path,
      frontmatter: { ...m.frontmatter },
      content: m.content,
    }));
    const oldFromSnapshot = staleSnapshot.find((m) => m.frontmatter.id === oldCity);
    assert.ok(oldFromSnapshot, "old memory must exist in snapshot");
    // Sanity: writer A's snapshot sees oldCity as active.
    assert.equal(oldFromSnapshot!.frontmatter.status ?? "active", "active");

    // Writer B beats A: mark oldCity superseded on disk with a different
    // supersededBy id.  This happens between writer A's snapshot read and
    // writer A's frontmatter patch.
    const concurrentWriterId = "fact-concurrent-writer";
    const concurrentSupersededAt = new Date().toISOString();
    const oldMemOnDisk = snapshot.find((m) => m.frontmatter.id === oldCity);
    assert.ok(oldMemOnDisk);
    await storage.writeMemoryFrontmatter(oldMemOnDisk!, {
      status: "superseded",
      supersededBy: concurrentWriterId,
      supersededAt: concurrentSupersededAt,
      updated: concurrentSupersededAt,
    });

    // Monkey-patch `readAllMemories` so writer A gets the stale snapshot.
    // `shouldSupersedeExisting` will then return a decision (it thinks the
    // candidate is still active) and the CAS re-read in
    // applyTemporalSupersession must notice disk says superseded and skip.
    const originalReadAll = storage.readAllMemories.bind(storage);
    (storage as unknown as { readAllMemories: () => Promise<unknown> }).readAllMemories =
      async () => staleSnapshot;

    try {
      const result = await applyTemporalSupersession({
        storage,
        newMemoryId: newCityA,
        entityRef: TEST_ENTITY,
        structuredAttributes: { city: "NYC" },
        createdAt: new Date().toISOString(),
        enabled: true,
      });

      assert.deepEqual(
        result.supersededIds,
        [],
        "CAS check should skip candidate already superseded by concurrent writer",
      );
    } finally {
      (storage as unknown as { readAllMemories: typeof originalReadAll }).readAllMemories =
        originalReadAll;
    }

    // Verify the concurrent writer's supersededBy link was preserved.
    const oldFm = await readFrontmatterById(storage, oldCity);
    assert.equal(oldFm?.status, "superseded");
    assert.equal(
      oldFm?.supersededBy,
      concurrentWriterId,
      "concurrent writer's supersededBy link must be preserved, not overwritten",
    );
    assert.equal(
      oldFm?.supersededAt,
      concurrentSupersededAt,
      "concurrent writer's supersededAt must be preserved",
    );
  } finally {
    await cleanup();
  }
});

// ─── Regression: Finding B — shared normalizeSupersessionKey helper ───────────

test("normalizeSupersessionKey: trims, lowercases, collapses whitespace to hyphens", () => {
  assert.equal(normalizeSupersessionKey("  Job Title  "), "job-title");
  assert.equal(normalizeSupersessionKey("job   title"), "job-title");
  assert.equal(normalizeSupersessionKey("job title"), "job-title");
  assert.equal(normalizeSupersessionKey("job-title"), "job-title");
  assert.equal(normalizeSupersessionKey("JOB TITLE"), "job-title");
  assert.equal(normalizeSupersessionKey("city"), "city");
});

test("computeSupersessionKey and lookupAttributeByNormalizedKey agree on 'job title' vs 'job-title'", () => {
  // computeSupersessionKey normalizes "job title" to "job-title"
  const key = computeSupersessionKey("user-1", "job title");
  assert.equal(key, "user-1::job-title");

  // lookupAttributeByNormalizedKey should find it whether stored as "job title" or "job-title"
  const storedAsSpaced = { "job title": "Engineer" };
  assert.equal(lookupAttributeByNormalizedKey(storedAsSpaced, "job-title"), "Engineer",
    "lookup with hyphenated key should find spaced stored key");
  assert.equal(lookupAttributeByNormalizedKey(storedAsSpaced, "job title"), "Engineer",
    "lookup with spaced key should find spaced stored key");

  const storedAsHyphen = { "job-title": "Engineer" };
  assert.equal(lookupAttributeByNormalizedKey(storedAsHyphen, "job title"), "Engineer",
    "lookup with spaced key should find hyphenated stored key");
  assert.equal(lookupAttributeByNormalizedKey(storedAsHyphen, "job-title"), "Engineer",
    "lookup with hyphenated key should find hyphenated stored key");
});

test("lookupAttributeByNormalizedKey: multiple internal spaces collapse to single hyphen", () => {
  const attrs = { "job   title": "Engineer" };
  assert.equal(lookupAttributeByNormalizedKey(attrs, "job title"), "Engineer",
    "'job   title' stored key should be found by 'job title' lookup");
  assert.equal(lookupAttributeByNormalizedKey(attrs, "job-title"), "Engineer",
    "'job   title' stored key should be found by 'job-title' lookup");
  assert.equal(lookupAttributeByNormalizedKey(attrs, "JOB TITLE"), "Engineer",
    "mixed-case 'JOB TITLE' lookup should find 'job   title' stored key");
});

test("shouldSupersedeExisting: 'job title' and 'job-title' resolve to the same supersession key", () => {
  // Old memory has "job title" (with space) as stored key.
  const candidateWithSpace: MemoryFrontmatter = {
    id: "fact-job-space",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    entityRef: TEST_ENTITY,
    structuredAttributes: { "job title": "Engineer" },
    status: "active",
  };

  // New fact uses hyphenated form "job-title".
  const decisionHyphen = shouldSupersedeExisting({
    candidate: candidateWithSpace,
    newEntityRef: TEST_ENTITY,
    newAttributes: { "job-title": "Senior Engineer" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-job-new-1",
  });
  assert.ok(decisionHyphen, "'job title' stored key should be superseded by 'job-title' new fact");
  assert.deepEqual(decisionHyphen?.matchedKeys, [`${TEST_ENTITY}::job-title`]);

  // Old memory has "job-title" (hyphenated) as stored key.
  const candidateWithHyphen: MemoryFrontmatter = {
    ...candidateWithSpace,
    id: "fact-job-hyphen",
    structuredAttributes: { "job-title": "Engineer" },
  };

  // New fact uses spaced form "job title".
  const decisionSpace = shouldSupersedeExisting({
    candidate: candidateWithHyphen,
    newEntityRef: TEST_ENTITY,
    newAttributes: { "job title": "Senior Engineer" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-job-new-2",
  });
  assert.ok(decisionSpace, "'job-title' stored key should be superseded by 'job title' new fact");
  assert.deepEqual(decisionSpace?.matchedKeys, [`${TEST_ENTITY}::job-title`]);
});

test("shouldSupersedeExisting: 'job   title' (multi-space) resolves same as 'job title'", () => {
  const candidateMultiSpace: MemoryFrontmatter = {
    id: "fact-job-multispace",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    entityRef: TEST_ENTITY,
    structuredAttributes: { "job   title": "Engineer" },
    status: "active",
  };

  const decision = shouldSupersedeExisting({
    candidate: candidateMultiSpace,
    newEntityRef: TEST_ENTITY,
    newAttributes: { "job title": "Senior Engineer" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-job-new-3",
  });
  assert.ok(decision, "'job   title' (multi-space) should supersede on 'job title' new fact");
});

test("shouldSupersedeExisting: 'Job Title' (mixed-case) resolves same as 'job title'", () => {
  const candidateMixedCase: MemoryFrontmatter = {
    id: "fact-job-mixedcase",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    entityRef: TEST_ENTITY,
    structuredAttributes: { "Job Title": "Engineer" },
    status: "active",
  };

  const decision = shouldSupersedeExisting({
    candidate: candidateMixedCase,
    newEntityRef: TEST_ENTITY,
    newAttributes: { "job title": "Senior Engineer" },
    newCreatedAt: "2026-02-01T00:00:00.000Z",
    newMemoryId: "fact-job-new-4",
  });
  assert.ok(decision, "'Job Title' (mixed-case) should supersede on 'job title' new fact");
  assert.deepEqual(decision?.matchedKeys, [`${TEST_ENTITY}::job-title`]);
});

// ─── Regression: Finding C — shouldFilterSupersededFromRecall is independent ──

test("shouldFilterSupersededFromRecall: filters superseded regardless of lifecycle policy", () => {
  // Finding A / C regression: supersession filter must apply independently of
  // any lifecycle flag.  If temporalSupersessionIncludeInRecall is false, a
  // superseded memory should always be filtered, even when the caller would
  // otherwise allow lifecycle-filtered (archived/retired) candidates.
  const supersededFm: MemoryFrontmatter = {
    id: "fact-superseded",
    category: "fact",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    source: "test",
    confidence: 0.9,
    confidenceTier: "explicit",
    tags: [],
    status: "superseded",
  };

  // With supersession enabled and includeInRecall=false, always filter.
  assert.equal(
    shouldFilterSupersededFromRecall(supersededFm, { enabled: true, includeInRecall: false }),
    true,
    "superseded memory must be filtered when includeInRecall=false",
  );

  // includeInRecall=true opts in to superseded history — do not filter.
  assert.equal(
    shouldFilterSupersededFromRecall(supersededFm, { enabled: true, includeInRecall: true }),
    false,
    "superseded memory must NOT be filtered when includeInRecall=true",
  );

  // An archived memory (non-superseded) is not touched by this filter.
  const archivedFm: MemoryFrontmatter = { ...supersededFm, id: "fact-archived", status: "archived" };
  assert.equal(
    shouldFilterSupersededFromRecall(archivedFm, { enabled: true, includeInRecall: false }),
    false,
    "archived (non-superseded) memory must not be filtered by supersession filter",
  );
});

// ─── Regression: P1 finding PRRT_kwDORJXyws56UBxt — cold-tier scan ───────────
//
// applyTemporalSupersession previously only scanned the hot tier via
// readAllMemories().  Memories already demoted to cold/ were never marked
// superseded, so cold fallback retrieval could surface stale truths when hot
// had no hits.

/**
 * Migrate a memory to the cold tier and return its new path.
 * Used only in cold-tier supersession regression tests.
 */
async function migrateFactToCold(
  storage: StorageManager,
  id: string,
): Promise<string> {
  storage.invalidateAllMemoriesCacheForDir();
  const mems = await storage.readAllMemories();
  const mem = mems.find((m) => m.frontmatter.id === id);
  assert.ok(mem, `memory ${id} not found for cold migration`);
  const { targetPath } = await storage.migrateMemoryToTier(mem!, "cold");
  storage.invalidateAllMemoriesCacheForDir();
  return targetPath;
}

test("applyTemporalSupersession: cold-tier memory with same key is marked superseded", async () => {
  // A memory is written to hot, then demoted to cold/.  A newer hot fact
  // arrives for the same entity+attribute.  The cold memory must be marked
  // superseded — the bug left it active because the scan never looked in cold/.
  const { storage, cleanup } = await makeStorage("engram-cold-supersession-basic-");
  try {
    // Write old cold fact (city = Austin).
    const oldId = await writeFact(storage, "entity lives in Austin", TEST_ENTITY, { city: "Austin" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const coldPath = await migrateFactToCold(storage, oldId);

    // Write new hot fact (city = NYC) — strictly newer.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newId = await writeFact(storage, "entity moved to NYC", TEST_ENTITY, { city: "NYC" });

    storage.invalidateAllMemoriesCacheForDir();
    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: new Date().toISOString(),
      enabled: true,
    });

    assert.deepEqual(result.supersededIds, [oldId], "cold-tier memory should be superseded");
    assert.deepEqual(result.matchedKeys, [`${TEST_ENTITY}::city`]);

    // Verify the written frontmatter on disk in the cold directory.
    const coldMem = await storage.readMemoryByPath(coldPath);
    assert.ok(coldMem, "cold memory file must still exist");
    assert.equal(coldMem!.frontmatter.status, "superseded", "cold memory status must be superseded");
    assert.equal(coldMem!.frontmatter.supersededBy, newId, "cold memory must link to new hot memory");
    assert.ok(coldMem!.frontmatter.supersededAt, "cold memory must have supersededAt timestamp");
  } finally {
    await cleanup();
  }
});

test("applyTemporalSupersession: cold-tier memory with different key is left unchanged", async () => {
  // A cold memory with a different attribute (tool) must NOT be superseded
  // when the new hot fact only covers city.
  const { storage, cleanup } = await makeStorage("engram-cold-supersession-diffkey-");
  try {
    const unrelatedId = await writeFact(
      storage,
      "entity uses vim",
      TEST_ENTITY,
      { tool: "vim" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const coldPath = await migrateFactToCold(storage, unrelatedId);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const newId = await writeFact(storage, "entity moved to NYC", TEST_ENTITY, { city: "NYC" });

    storage.invalidateAllMemoriesCacheForDir();
    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: new Date().toISOString(),
      enabled: true,
    });

    assert.deepEqual(result.supersededIds, [], "unrelated cold-tier memory must not be superseded");

    const coldMem = await storage.readMemoryByPath(coldPath);
    assert.ok(coldMem, "cold memory file must still exist");
    assert.equal(coldMem!.frontmatter.status ?? "active", "active", "unrelated cold memory must remain active");
  } finally {
    await cleanup();
  }
});

test("applyTemporalSupersession: both hot and cold memories sharing a key are processed; no double-processing", async () => {
  // Hot memory (city=Austin, older) and cold memory (city=Dallas, older) both
  // share the city key.  After the run, both must be superseded and neither
  // should be processed twice (dedup by path).
  const { storage, cleanup } = await makeStorage("engram-cold-supersession-both-");
  try {
    // Write hot old fact (city = Austin).
    const hotOldId = await writeFact(storage, "entity in Austin", TEST_ENTITY, { city: "Austin" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Write another old fact (city = Dallas) and demote to cold.
    const coldOldId = await writeFact(storage, "entity in Dallas", TEST_ENTITY, { city: "Dallas" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const coldPath = await migrateFactToCold(storage, coldOldId);

    // Write new hot fact (city = NYC) — strictly newer than both.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newId = await writeFact(storage, "entity moved to NYC", TEST_ENTITY, { city: "NYC" });

    storage.invalidateAllMemoriesCacheForDir();
    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: new Date().toISOString(),
      enabled: true,
    });

    // Both old memories (hot + cold) must be superseded.
    const sortedIds = [...result.supersededIds].sort();
    assert.deepEqual(sortedIds, [coldOldId, hotOldId].sort(), "both hot and cold memories must be superseded");
    assert.deepEqual(result.matchedKeys, [`${TEST_ENTITY}::city`]);

    // Verify cold memory on disk.
    const coldMem = await storage.readMemoryByPath(coldPath);
    assert.ok(coldMem, "cold memory file must still exist");
    assert.equal(coldMem!.frontmatter.status, "superseded");
    assert.equal(coldMem!.frontmatter.supersededBy, newId);
  } finally {
    await cleanup();
  }
});

test("applyTemporalSupersession: cold-tier writes use CAS re-read and monotonic supersededAt", async () => {
  // CAS regression for cold tier: supersededAt must be the monotonic max of
  // (cold.created, hot.created, args.createdAt) — same guarantee as hot tier.
  const { storage, cleanup } = await makeStorage("engram-cold-supersession-cas-");
  try {
    const tCold = "2026-04-11T10:00:00.000Z";
    const tNew  = "2026-04-11T12:00:00.000Z";
    const staleWallClock = "2026-04-11T09:00:00.000Z"; // earlier than tCold

    // Write old fact and patch its created to tCold, then demote to cold.
    const coldOldId = await writeFact(storage, "entity in Austin", TEST_ENTITY, { city: "Austin" });
    storage.invalidateAllMemoriesCacheForDir();
    const coldOldMem = (await storage.readAllMemories()).find((m) => m.frontmatter.id === coldOldId);
    assert.ok(coldOldMem);
    await storage.writeMemoryFrontmatter(coldOldMem!, { created: tCold, updated: tCold });
    storage.invalidateAllMemoriesCacheForDir();
    // Re-read after the frontmatter patch before migrating.
    const coldOldMemPatched = (await storage.readAllMemories()).find((m) => m.frontmatter.id === coldOldId);
    assert.ok(coldOldMemPatched);
    const coldPath = await migrateFactToCold(storage, coldOldId);

    // Write new hot fact and patch its created to tNew (> tCold).
    const newId = await writeFact(storage, "entity moved to NYC", TEST_ENTITY, { city: "NYC" });
    storage.invalidateAllMemoriesCacheForDir();
    const newMem = (await storage.readAllMemories()).find((m) => m.frontmatter.id === newId);
    assert.ok(newMem);
    await storage.writeMemoryFrontmatter(newMem!, { created: tNew, updated: tNew });

    storage.invalidateAllMemoriesCacheForDir();
    const result = await applyTemporalSupersession({
      storage,
      newMemoryId: newId,
      entityRef: TEST_ENTITY,
      structuredAttributes: { city: "NYC" },
      createdAt: staleWallClock, // stale — earlier than both persisted timestamps
      enabled: true,
    });

    assert.deepEqual(result.supersededIds, [coldOldId], "cold-tier memory should be superseded");

    const coldMem = await storage.readMemoryByPath(coldPath);
    assert.ok(coldMem, "cold memory file must still exist");
    assert.equal(coldMem!.frontmatter.status, "superseded");
    assert.equal(coldMem!.frontmatter.supersededBy, newId);

    // supersededAt must be the monotonic max (tNew) — not the stale wall clock.
    assert.equal(
      coldMem!.frontmatter.supersededAt,
      tNew,
      "supersededAt for cold-tier write must be the monotonic max of (cold.created, hot.created, args.createdAt)",
    );
    assert.equal(
      coldMem!.frontmatter.updated,
      tNew,
      "updated for cold-tier write must match supersededAt",
    );

    // Sanity: supersededAt must not predate cold.created.
    const coldCreatedMs = new Date(tCold).getTime();
    const supersededAtMs = new Date(coldMem!.frontmatter.supersededAt!).getTime();
    assert.ok(
      supersededAtMs >= coldCreatedMs,
      `supersededAt (${coldMem!.frontmatter.supersededAt}) must not predate cold.created (${tCold})`,
    );
  } finally {
    await cleanup();
  }
});
