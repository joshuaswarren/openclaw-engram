import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { convertMemoriesToRecords } from "./converter.js";

// ---------------------------------------------------------------------------
// Helper: create a synthetic memory file
// ---------------------------------------------------------------------------

interface SyntheticMemory {
  id: string;
  category?: string;
  confidence?: number;
  created?: string;
  tags?: string[];
  content: string;
}

async function writeSyntheticMemory(
  dir: string,
  subdir: string,
  filename: string,
  mem: SyntheticMemory,
): Promise<void> {
  const fullDir = path.join(dir, subdir);
  await mkdir(fullDir, { recursive: true });
  const tags = mem.tags ?? [];
  const md = [
    "---",
    `id: ${mem.id}`,
    `category: ${mem.category ?? "fact"}`,
    `created: ${mem.created ?? "2026-01-15T10:00:00.000Z"}`,
    `updated: ${mem.created ?? "2026-01-15T10:00:00.000Z"}`,
    `source: test`,
    `confidence: ${mem.confidence ?? 0.9}`,
    `confidenceTier: explicit`,
    `tags: [${tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
    "",
    mem.content,
  ].join("\n");
  await writeFile(path.join(fullDir, filename), md, "utf-8");
}

async function makeTmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "remnic-training-export-"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("convertMemoriesToRecords", () => {
  it("converts memory files to records", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem-001.md", {
      id: "mem-001",
      content: "TypeScript is a typed superset of JavaScript.",
      tags: ["typescript", "language"],
    });

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 1);
    assert.equal(records[0].output, "TypeScript is a typed superset of JavaScript.");
    assert.equal(records[0].input, "");
    assert.match(records[0].instruction, /factual memory/);
    assert.equal(records[0].category, "fact");
    assert.equal(records[0].confidence, 0.9);
    assert.deepEqual(records[0].sourceIds, ["mem-001"]);
  });

  it("filters by minConfidence", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "high.md", {
      id: "high",
      confidence: 0.95,
      content: "High confidence fact.",
    });
    await writeSyntheticMemory(dir, "facts", "low.md", {
      id: "low",
      confidence: 0.3,
      content: "Low confidence fact.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      minConfidence: 0.5,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "high");
  });

  it("filters by categories", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "fact.md", {
      id: "f1",
      category: "fact",
      content: "A fact.",
    });
    await writeSyntheticMemory(dir, "corrections", "corr.md", {
      id: "c1",
      category: "correction",
      content: "A correction.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      categories: ["correction"],
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].category, "correction");
  });

  it("filters by date range (since/until) with half-open semantics", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "old.md", {
      id: "old",
      created: "2025-06-01T00:00:00.000Z",
      content: "Old memory.",
    });
    await writeSyntheticMemory(dir, "facts", "mid.md", {
      id: "mid",
      created: "2026-01-15T00:00:00.000Z",
      content: "Mid memory.",
    });
    await writeSyntheticMemory(dir, "facts", "new.md", {
      id: "new",
      created: "2026-03-01T00:00:00.000Z",
      content: "New memory.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      since: new Date("2026-01-01T00:00:00.000Z"),
      until: new Date("2026-02-01T00:00:00.000Z"),
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "mid");
  });

  it("until filter uses exclusive upper bound (CLAUDE.md #35)", async () => {
    const dir = await makeTmpDir();
    const boundaryDate = "2026-02-01T00:00:00.000Z";
    await writeSyntheticMemory(dir, "facts", "boundary.md", {
      id: "boundary",
      created: boundaryDate,
      content: "Boundary memory.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      until: new Date(boundaryDate),
    });

    // Exact boundary should be excluded (half-open: created < until)
    assert.equal(records.length, 0);
  });

  it("handles empty memory directory", async () => {
    const dir = await makeTmpDir();
    // Don't create any subdirectories
    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.deepEqual(records, []);
  });

  it("handles malformed memory files gracefully", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "facts"), { recursive: true });
    // Write a file with no frontmatter
    await writeFile(
      path.join(dir, "facts", "broken.md"),
      "This file has no YAML frontmatter at all.",
      "utf-8",
    );

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.deepEqual(records, []);
  });

  it("skips files with empty content body", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "facts"), { recursive: true });
    const md = ["---", "id: empty", "category: fact", "confidence: 0.9", "---", ""].join("\n");
    await writeFile(path.join(dir, "facts", "empty.md"), md, "utf-8");

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.deepEqual(records, []);
  });

  it("includes entities directory when includeEntities is true", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "entities", "person-alice.md", {
      id: "entity-1",
      category: "entity",
      content: "Alice is a software engineer.",
    });

    // Without includeEntities — should not find entity
    const withoutEntities = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(withoutEntities.length, 0);

    // With includeEntities — should find entity
    const withEntities = await convertMemoriesToRecords({
      memoryDir: dir,
      includeEntities: true,
    });
    assert.equal(withEntities.length, 1);
    assert.equal(withEntities[0].category, "entity");
  });

  it("reads from nested subdirectories", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts/nested/deep", "deep.md", {
      id: "deep",
      content: "Deeply nested memory.",
    });

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "deep");
  });

  it("builds category-specific instructions", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "corrections", "pref.md", {
      id: "pref",
      category: "preference",
      content: "Prefers dark mode.",
    });

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 1);
    assert.match(records[0].instruction, /user preference/);
  });
});
