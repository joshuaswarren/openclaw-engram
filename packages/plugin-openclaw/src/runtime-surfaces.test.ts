import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConsolidationObservation,
  MemoryFile,
  MemoryFrontmatter,
} from "../../../remnic-core/src/types.js";
import {
  parseDreamNarrativeResponse,
  planDreamEntryFromConsolidation,
  syncDreamSurfaceEntries,
  syncHeartbeatOutcomeLinks,
  syncHeartbeatSurfaceEntries,
} from "./runtime-surfaces.js";

function makeMemory(params: {
  id: string;
  category?: MemoryFrontmatter["category"];
  content: string;
  tags?: string[];
  created?: string;
  updated?: string;
  source?: string;
  memoryKind?: MemoryFrontmatter["memoryKind"];
  structuredAttributes?: Record<string, string>;
}): MemoryFile {
  return {
    path: `/tmp/${params.id}.md`,
    content: params.content,
    frontmatter: {
      id: params.id,
      category: params.category ?? "fact",
      created: params.created ?? "2026-04-12T12:00:00.000Z",
      updated: params.updated ?? params.created ?? "2026-04-12T12:00:00.000Z",
      source: params.source ?? "extraction",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: params.tags ?? [],
      memoryKind: params.memoryKind,
      structuredAttributes: params.structuredAttributes,
    },
  };
}

function makeStorage(initial: MemoryFile[] = []) {
  const memories = [...initial];
  return {
    memories,
    async readAllMemories() {
      return memories.map((memory) => ({
        ...memory,
        frontmatter: {
          ...memory.frontmatter,
          tags: [...(memory.frontmatter.tags ?? [])],
          structuredAttributes: memory.frontmatter.structuredAttributes
            ? { ...memory.frontmatter.structuredAttributes }
            : undefined,
        },
      }));
    },
    async writeMemory(
      category: MemoryFrontmatter["category"],
      content: string,
      options: {
        tags?: string[];
        source?: string;
        memoryKind?: MemoryFrontmatter["memoryKind"];
        structuredAttributes?: Record<string, string>;
      } = {},
    ) {
      const id = `${category}-${memories.length + 1}`;
      memories.push(
        makeMemory({
          id,
          category,
          content,
          tags: options.tags,
          source: options.source,
          memoryKind: options.memoryKind,
          structuredAttributes: options.structuredAttributes,
        }),
      );
      return id;
    },
    async updateMemory(id: string, newContent: string) {
      const memory = memories.find((entry) => entry.frontmatter.id === id);
      if (!memory) return false;
      memory.content = newContent;
      memory.frontmatter.updated = "2026-04-12T13:00:00.000Z";
      return true;
    },
    async writeMemoryFrontmatter(memory: MemoryFile, patch: Partial<MemoryFrontmatter>) {
      const current = memories.find((entry) => entry.frontmatter.id === memory.frontmatter.id);
      if (!current) return false;
      current.frontmatter = {
        ...current.frontmatter,
        ...patch,
        tags: patch.tags ?? current.frontmatter.tags,
        structuredAttributes:
          patch.structuredAttributes ?? current.frontmatter.structuredAttributes,
      };
      return true;
    },
  };
}

test("syncDreamSurfaceEntries imports dream entries once and updates existing metadata idempotently", async () => {
  const storage = makeStorage();
  const reindexed: string[] = [];
  const result = await syncDreamSurfaceEntries({
    storage,
    entries: [
      {
        id: "dream-a",
        timestamp: "2026-04-12T10:00:00Z",
        title: "Patterns in the test suite",
        body: "The failures clustered around one fragile adapter.",
        tags: ["debug", "recurring"],
        sourceOffset: 12,
      },
    ],
    journalPath: "/workspace/DREAMS.md",
    maxEntries: 10,
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(result, { created: 1, updated: 0, linked: 0 });
  assert.equal(storage.memories.length, 1);
  assert.equal(storage.memories[0]?.frontmatter.memoryKind, "dream");
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.remnicDreamEntryId,
    "dream-a",
  );
  assert.equal(reindexed[0], "moment-1");

  const rerun = await syncDreamSurfaceEntries({
    storage,
    entries: [
      {
        id: "dream-a",
        timestamp: "2026-04-12T10:00:00Z",
        title: "Patterns in the test suite",
        body: "The failures clustered around one fragile adapter.",
        tags: ["debug", "recurring"],
        sourceOffset: 12,
      },
    ],
    journalPath: "/workspace/DREAMS.md",
    maxEntries: 10,
    reindexMemory: async () => {
      throw new Error("reindex should not run on a stable rerun");
    },
  });

  assert.deepEqual(rerun, { created: 0, updated: 0, linked: 0 });
  assert.equal(storage.memories.length, 1);
});

test("syncHeartbeatSurfaceEntries creates procedural heartbeat memories and updates the same slug in place", async () => {
  const storage = makeStorage();

  const first = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci", "tests"],
        sourceOffset: 20,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
  });

  assert.deepEqual(first, { created: 1, updated: 0, linked: 0 });
  assert.equal(storage.memories[0]?.frontmatter.memoryKind, "procedural");
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    "check-test-suite",
  );

  const second = await syncHeartbeatSurfaceEntries({
    storage,
    entries: [
      {
        id: "heartbeat-b",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite, compare to the last run, and report new failures.",
        schedule: "hourly",
        tags: ["ci", "tests", "diff"],
        sourceOffset: 48,
      },
    ],
    journalPath: "/workspace/HEARTBEAT.md",
  });

  assert.deepEqual(second, { created: 0, updated: 1, linked: 0 });
  assert.match(storage.memories[0]?.content ?? "", /compare to the last run/);
  assert.deepEqual(storage.memories[0]?.frontmatter.tags, [
    "ci",
    "tests",
    "diff",
    "heartbeat",
    "procedural",
    "check-test-suite",
  ]);
});

test("syncHeartbeatOutcomeLinks annotates non-heartbeat memories that clearly reference one heartbeat slug", async () => {
  const storage = makeStorage([
    makeMemory({
      id: "fact-1",
      content: "During check-test-suite we found three new failures in the smoke run.",
      tags: ["ci"],
    }),
  ]);
  const reindexed: string[] = [];

  const result = await syncHeartbeatOutcomeLinks({
    storage,
    entries: [
      {
        id: "heartbeat-a",
        slug: "check-test-suite",
        title: "check-test-suite",
        body: "Run the suite and report new failures.",
        schedule: "hourly",
        tags: ["ci"],
        sourceOffset: 0,
      },
    ],
    reindexMemory: async (id) => {
      reindexed.push(id);
    },
  });

  assert.deepEqual(result, { created: 0, updated: 0, linked: 1 });
  assert.equal(
    storage.memories[0]?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
    "check-test-suite",
  );
  assert.deepEqual(storage.memories[0]?.frontmatter.tags, [
    "ci",
    "heartbeat:check-test-suite",
  ]);
  assert.deepEqual(reindexed, ["fact-1"]);
});

test("planDreamEntryFromConsolidation requires enough session-like spread, meta tags, and interval headroom", () => {
  const observation: ConsolidationObservation = {
    runAt: "2026-04-12T15:00:00.000Z",
    recentMemories: [
      makeMemory({
        id: "a",
        content: "A recurring failure showed up in the adapter tests.",
        tags: ["recurring", "debug"],
        created: "2026-04-12T10:00:00.000Z",
      }),
      makeMemory({
        id: "b",
        content: "Another surprising regression appeared in a different session.",
        tags: ["surprising"],
        created: "2026-04-12T11:00:00.000Z",
      }),
      makeMemory({
        id: "c",
        content: "The team felt stuck until the slot mismatch check clarified the path.",
        tags: ["stuck"],
        created: "2026-04-12T12:00:00.000Z",
      }),
    ],
    existingMemories: [],
    profile: "",
    result: { items: [], profileUpdates: [], entityUpdates: [] },
    merged: 0,
    invalidated: 0,
  };

  const plan = planDreamEntryFromConsolidation({
    observation,
    existingDreams: [],
    minIntervalMinutes: 120,
    now: new Date("2026-04-12T15:00:00.000Z"),
  });

  assert.ok(plan);
  assert.deepEqual(plan?.suggestedTags, ["recurring", "debug", "surprising", "stuck"]);
  assert.equal(plan?.sessionLikeCount, 3);
  assert.equal(plan?.memoryContext.length, 3);

  const suppressed = planDreamEntryFromConsolidation({
    observation,
    existingDreams: [
      {
        id: "dream-recent",
        timestamp: "2026-04-12T14:30:00.000Z",
        title: null,
        body: "A recent reflection already exists.",
        tags: [],
        sourceOffset: 10,
      },
    ],
    minIntervalMinutes: 120,
    now: new Date("2026-04-12T15:00:00.000Z"),
  });

  assert.equal(suppressed, null);
});

test("parseDreamNarrativeResponse extracts title, body, and tags with fallback tags", () => {
  const parsed = parseDreamNarrativeResponse(
    [
      "Title: Learning from recurring test drift",
      "Tags: #recurring #debug",
      "Body:",
      "The suite kept failing in the same corner until the adapter contract was clarified.",
    ].join("\n"),
    ["fallback"],
  );

  assert.deepEqual(parsed, {
    title: "Learning from recurring test drift",
    body: "The suite kept failing in the same corner until the adapter contract was clarified.",
    tags: ["recurring", "debug"],
  });

  const fallback = parseDreamNarrativeResponse("Body:\nA quieter reflection.", ["fallback"]);
  assert.deepEqual(fallback, {
    title: null,
    body: "A quieter reflection.",
    tags: ["fallback"],
  });
});
