import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  StorageManager,
  isEntitySynthesisStale,
  normalizeEntityName,
  parseEntityFile,
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
