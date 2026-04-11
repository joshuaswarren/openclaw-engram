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
