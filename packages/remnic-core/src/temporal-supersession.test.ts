import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import {
  applyTemporalSupersession,
  computeSupersessionKey,
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
