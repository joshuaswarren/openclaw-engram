import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile, open, symlink } from "node:fs/promises";
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

  // --- Fix 1: Reject invalid memoryDir paths ---

  it("throws when memoryDir does not exist", async () => {
    const dir = await makeTmpDir();
    const nonExistent = path.join(dir, "no-such-dir");

    await assert.rejects(
      () => convertMemoriesToRecords({ memoryDir: nonExistent }),
      (err: Error) => {
        assert.match(err.message, /memoryDir does not exist/);
        return true;
      },
    );
  });

  it("throws when memoryDir is a file, not a directory (CLAUDE.md #24)", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "not-a-dir.txt");
    const handle = await open(filePath, "w");
    await handle.writeFile("I am a file, not a directory.");
    await handle.close();

    await assert.rejects(
      () => convertMemoriesToRecords({ memoryDir: filePath }),
      (err: Error) => {
        assert.match(err.message, /memoryDir is not a directory/);
        return true;
      },
    );
  });

  // --- Fix 2: Deterministic output ordering ---

  it("returns records in deterministic sorted order", async () => {
    const dir = await makeTmpDir();
    // Create files with names that would sort differently from filesystem order
    await writeSyntheticMemory(dir, "facts", "z-last.md", {
      id: "z-last",
      content: "Z comes last alphabetically.",
    });
    await writeSyntheticMemory(dir, "facts", "a-first.md", {
      id: "a-first",
      content: "A comes first alphabetically.",
    });
    await writeSyntheticMemory(dir, "facts", "m-middle.md", {
      id: "m-middle",
      content: "M is in the middle.",
    });

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 3);
    assert.deepEqual(
      records.map((r) => r.sourceIds?.[0]),
      ["a-first", "m-middle", "z-last"],
    );
  });

  // --- Fix 3: includeTopics gate ---

  it("throws 'not implemented' when includeTopics is true (CLAUDE.md #51, #55)", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      content: "Some content.",
    });

    await assert.rejects(
      () => convertMemoriesToRecords({ memoryDir: dir, includeTopics: true }),
      (err: Error) => {
        assert.match(err.message, /includeTopics is not yet implemented/);
        return true;
      },
    );
  });

  it("does not throw when includeTopics is false or undefined", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      content: "Some content.",
    });

    // includeTopics=false should not throw
    const records1 = await convertMemoriesToRecords({ memoryDir: dir, includeTopics: false });
    assert.equal(records1.length, 1);

    // includeTopics=undefined (default) should not throw
    const records2 = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records2.length, 1);
  });

  // --- Fix 4: Reject symlinked markdown files during directory scan ---

  it("skips symlinked files to prevent data exfiltration", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "facts"), { recursive: true });

    // Create a real memory that should be included
    await writeSyntheticMemory(dir, "facts", "real.md", {
      id: "real",
      content: "A real memory file.",
    });

    // Create an external file outside memoryDir
    const externalDir = await makeTmpDir();
    const externalFile = path.join(externalDir, "secret.txt");
    await writeFile(externalFile, "---\nid: secret\ncategory: fact\nconfidence: 0.9\ncreated: 2026-01-15T10:00:00.000Z\n---\n\nSecret data that should not be exported.", "utf-8");

    // Create a symlink inside facts/ pointing to the external file
    await symlink(externalFile, path.join(dir, "facts", "linked.md"));

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    // Only the real file should be included; the symlink should be skipped
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "real");
  });

  it("skips symlinked directories during recursive scan", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "facts"), { recursive: true });

    await writeSyntheticMemory(dir, "facts", "real.md", {
      id: "real",
      content: "A real memory file.",
    });

    // Create an external directory with a memory file
    const externalDir = await makeTmpDir();
    await mkdir(path.join(externalDir, "leaked"), { recursive: true });
    await writeFile(
      path.join(externalDir, "leaked", "secret.md"),
      "---\nid: leaked\ncategory: fact\nconfidence: 0.9\ncreated: 2026-01-15T10:00:00.000Z\n---\n\nLeaked from symlinked directory.",
      "utf-8",
    );

    // Create a symlink to the external directory inside facts/
    await symlink(path.join(externalDir, "leaked"), path.join(dir, "facts", "linked-dir"));

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "real");
  });

  // --- Fix 5: Exclude undated memories from date-filtered exports ---

  it("excludes memories with missing created date when since filter is active", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "facts"), { recursive: true });

    // Memory with a valid date — should be included
    await writeSyntheticMemory(dir, "facts", "dated.md", {
      id: "dated",
      created: "2026-02-15T10:00:00.000Z",
      content: "A dated memory.",
    });

    // Memory with no created field — write raw to omit created
    await writeFile(
      path.join(dir, "facts", "undated.md"),
      "---\nid: undated\ncategory: fact\nconfidence: 0.9\n---\n\nAn undated memory.",
      "utf-8",
    );

    // Without date filter: both should appear
    const allRecords = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(allRecords.length, 2);

    // With since filter: only the dated memory should appear
    const filteredRecords = await convertMemoriesToRecords({
      memoryDir: dir,
      since: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(filteredRecords.length, 1);
    assert.equal(filteredRecords[0].sourceIds?.[0], "dated");
  });

  it("excludes memories with unparseable created date when until filter is active", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "facts"), { recursive: true });

    // Memory with a valid date — should be included
    await writeSyntheticMemory(dir, "facts", "dated.md", {
      id: "dated",
      created: "2026-01-15T10:00:00.000Z",
      content: "A dated memory.",
    });

    // Memory with garbage created field
    await writeFile(
      path.join(dir, "facts", "garbled.md"),
      "---\nid: garbled\ncategory: fact\nconfidence: 0.9\ncreated: not-a-date\n---\n\nMemory with garbled date.",
      "utf-8",
    );

    const filteredRecords = await convertMemoriesToRecords({
      memoryDir: dir,
      until: new Date("2026-12-31T00:00:00.000Z"),
    });
    assert.equal(filteredRecords.length, 1);
    assert.equal(filteredRecords[0].sourceIds?.[0], "dated");
  });
});
