import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  StorageManager,
  isEntitySynthesisStale,
  latestEntityTimelineTimestamp,
  normalizeEntityName,
  parseEntityFile,
  serializeEntityFile,
} from "../packages/remnic-core/src/storage.js";

test("writeEntity appends timeline evidence and marks older synthesis as stale", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);

    await storage.writeEntity(entityName, entityType, ["Leads the roadmap."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
      sessionKey: "session-1",
      principal: "agent:main",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe leads the roadmap.", {
      updatedAt: "2026-04-13T10:05:00.000Z",
    });

    await storage.writeEntity(entityName, entityType, ["Owns release approvals now."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
      sessionKey: "session-2",
      principal: "agent:main",
    });

    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.match(raw, /^---\n[\s\S]*synthesis_updated_at:/);
    assert.match(raw, /## Synthesis/);
    assert.match(raw, /## Timeline/);
    assert.equal(parsed.timeline.length, 2);
    assert.equal(parsed.timeline[0]?.text, "Leads the roadmap.");
    assert.equal(parsed.timeline[1]?.text, "Owns release approvals now.");
    assert.equal(parsed.timeline[1]?.sessionKey, "session-2");
    assert.equal(parsed.synthesis, "Jane Doe leads the roadmap.");
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity migration rewrites legacy summary plus facts files into synthesis plus timeline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = "person-jane-doe";
    const legacy = [
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-12T10:00:00.000Z",
      "",
      "## Summary",
      "",
      "Jane Doe leads roadmap work.",
      "",
      "## Facts",
      "",
      "- Leads roadmap work.",
      "- Prefers short updates.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", `${canonical}.md`), legacy, "utf-8");

    const result = await storage.migrateEntityFilesToCompiledTruthTimeline();
    const migratedRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(migratedRaw);

    assert.equal(result.total, 1);
    assert.equal(result.migrated, 1);
    assert.match(migratedRaw, /## Synthesis/);
    assert.match(migratedRaw, /## Timeline/);
    assert.equal(parsed.synthesis, "Jane Doe leads roadmap work.");
    assert.equal(parsed.timeline.length, 2);
    assert.deepEqual(
      parsed.timeline.map((entry) => entry.text),
      ["Leads roadmap work.", "Prefers short updates."],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serializeEntityFile persists stable created and updated frontmatter for entity reads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-frontmatter-stability-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe leads roadmap work.", {
      updatedAt: "2026-04-13T10:05:00.000Z",
    });

    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.match(raw, /^---\ncreated: 2026-04-13T10:00:00.000Z\nupdated: 2026-04-13T10:05:00.000Z/m);
    assert.equal(parsed.created, "2026-04-13T10:00:00.000Z");
    assert.equal(parsed.updated, "2026-04-13T10:05:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseEntityFile preserves bulleted synthesis text across round trips", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "- Leads roadmap work.",
    "- Owns release approvals.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.equal(parsed.synthesis, "- Leads roadmap work.\n- Owns release approvals.");
  assert.match(serialized, /## Synthesis\n\n- Leads roadmap work\.\n- Owns release approvals\./);
});

test("parseEntityFile preserves bracket-prefixed timeline facts", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] [source=extraction] [Q2] launched rollout",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.timeline[0]?.text, "[Q2] launched rollout");
  assert.equal(parsed.timeline[0]?.source, "extraction");
});

test("parseEntityFile preserves unknown bracket tokens after known timeline metadata", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] [source=extraction] [custom=val] launched rollout",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.timeline[0]?.source, "extraction");
  assert.equal(parsed.timeline[0]?.text, "[custom=val] launched rollout");
});

test("parseEntityFile merges legacy facts into mixed timeline entities", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
    "## Facts",
    "",
    "- Prefers short updates.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.deepEqual(parsed.facts, ["Leads roadmap work.", "Prefers short updates."]);
  assert.match(serialized, /## Timeline/);
  assert.match(serialized, /Leads roadmap work\./);
  assert.match(serialized, /Prefers short updates\./);
});

test("entity synthesis staleness uses parsed timestamps instead of raw string ordering", () => {
  const parsed = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T14:30:00Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T14:45:00Z] Reviewed rollout metrics",
    "- [2026-04-13T10:00:00-05:00] Approved production rollout",
    "",
  ].join("\n"));

  assert.equal(latestEntityTimelineTimestamp(parsed), "2026-04-13T10:00:00-05:00");
  assert.equal(isEntitySynthesisStale(parsed), true);
});

test("mergeFragmentedEntities prefers the freshest synthesis using parsed timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-synthesis-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T14:45:00Z",
      'synthesis_updated_at: "2026-04-13T14:45:00Z"',
      "synthesis_version: 1",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T14:45:00Z",
      "",
      "## Synthesis",
      "",
      "Older synthesis should lose.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T14:45:00Z] Older evidence",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:00:00-05:00",
      'synthesis_updated_at: "2026-04-13T10:00:00-05:00"',
      "synthesis_version: 2",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:00:00-05:00",
      "",
      "## Synthesis",
      "",
      "Newest offset synthesis should win.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:00:00-05:00] Newer evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    const merged = await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(merged, 2);
    assert.equal(parsed.synthesis, "Newest offset synthesis should win.");
    assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:00:00-05:00");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshEntitySynthesisQueue orders stale entities by parsed latest timeline timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-queue-order-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const newerCanonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Newest offset entity should lead the queue."], {
      timestamp: "2026-04-13T10:00:00-05:00",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(newerCanonical, "Jane Doe had an older synthesis.", {
      updatedAt: "2026-04-13T14:30:00Z",
    });

    const olderCanonical = normalizeEntityName("Project Beta", "project");
    await storage.writeEntity("Project Beta", "project", ["Older UTC entity should come second."], {
      timestamp: "2026-04-13T14:45:00Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(olderCanonical, "Project Beta had an older synthesis.", {
      updatedAt: "2026-04-13T14:40:00Z",
    });

    const queue = await storage.refreshEntitySynthesisQueue();

    assert.deepEqual(queue, [newerCanonical, olderCanonical]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshEntitySynthesisQueue keeps canonical filenames when headings drift", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-queue-filename-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe leads roadmap work.", {
      updatedAt: "2026-04-13T10:01:00.000Z",
    });
    await storage.writeEntity("Jane Do", "person", ["Newest stale fact."], {
      timestamp: "2026-04-13T10:02:00.000Z",
      source: "extraction",
    });

    const queue = await storage.refreshEntitySynthesisQueue();

    assert.deepEqual(queue, [canonical]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
