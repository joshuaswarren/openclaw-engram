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

  // --- Fix 6: Reject symlinked source directories before scanning ---

  it("skips symlinked source directories (e.g. facts/ is a symlink)", async () => {
    const dir = await makeTmpDir();

    // Create a real corrections/ directory with a memory
    await writeSyntheticMemory(dir, "corrections", "real.md", {
      id: "real-corr",
      category: "correction",
      content: "A real correction.",
    });

    // Create an external directory with memory files
    const externalDir = await makeTmpDir();
    await writeSyntheticMemory(externalDir, ".", "secret.md", {
      id: "secret",
      content: "Leaked from symlinked source directory.",
    });

    // Make facts/ a symlink to the external directory
    await symlink(externalDir, path.join(dir, "facts"));

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    // Only the real corrections file should be included; facts/ symlink is skipped
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "real-corr");
  });

  it("skips symlinked entities/ directory when includeEntities is true", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "real.md", {
      id: "real-fact",
      content: "A real fact.",
    });

    // Create an external directory with entity files
    const externalDir = await makeTmpDir();
    await writeSyntheticMemory(externalDir, ".", "secret-entity.md", {
      id: "secret-entity",
      category: "entity",
      content: "Leaked entity.",
    });

    // Make entities/ a symlink to the external directory
    await symlink(externalDir, path.join(dir, "entities"));

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      includeEntities: true,
    });
    // Only the real fact should be included; entities/ symlink is skipped
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "real-fact");
  });

  // --- Fix 7: Propagate non-ENOENT readdir errors ---

  it("propagates EACCES errors from readdir instead of swallowing", async () => {
    const dir = await makeTmpDir();
    // Create facts/ then remove read permission
    await mkdir(path.join(dir, "facts"), { recursive: true });
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      content: "Some content.",
    });

    const { chmod } = await import("node:fs/promises");
    // Remove all permissions from the facts directory
    await chmod(path.join(dir, "facts"), 0o000);

    try {
      await assert.rejects(
        () => convertMemoriesToRecords({ memoryDir: dir }),
        (err: Error) => {
          assert.equal((err as NodeJS.ErrnoException).code, "EACCES");
          return true;
        },
      );
    } finally {
      // Restore permissions so cleanup can proceed
      await chmod(path.join(dir, "facts"), 0o755);
    }
  });

  // --- Fix 8: Entity file handling produces correct category and sourceId ---

  it("entity files get category 'entity' even when frontmatter defaults to 'fact'", async () => {
    const dir = await makeTmpDir();
    // Write an entity file with no explicit category (defaults to "fact" in parser)
    await mkdir(path.join(dir, "entities"), { recursive: true });
    await writeFile(
      path.join(dir, "entities", "person-bob.md"),
      "---\nid: entity-bob\nconfidence: 0.9\ncreated: 2026-01-15T10:00:00.000Z\n---\n\nBob is a test entity.",
      "utf-8",
    );

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      includeEntities: true,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].category, "entity");
    assert.match(records[0].instruction, /entity information/);
  });

  it("entity files derive sourceId from filename when frontmatter ID is missing", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "entities"), { recursive: true });
    // Write an entity file with no id field
    await writeFile(
      path.join(dir, "entities", "org-acme-corp.md"),
      "---\ncategory: entity\nconfidence: 0.9\ncreated: 2026-01-15T10:00:00.000Z\n---\n\nAcme Corp is an organization.",
      "utf-8",
    );

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      includeEntities: true,
    });
    assert.equal(records.length, 1);
    // sourceId should be derived from the filename (minus .md extension)
    assert.deepEqual(records[0].sourceIds, ["org-acme-corp"]);
  });

  it("entity files with explicit category preserve it", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "entities", "relationship.md", {
      id: "rel-1",
      category: "relationship",
      content: "Alice and Bob are colleagues.",
    });

    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      includeEntities: true,
    });
    assert.equal(records.length, 1);
    // Explicit "relationship" category should be preserved, not overridden
    assert.equal(records[0].category, "relationship");
  });

  // --- Fix 9: Skip non-regular files (FIFOs, sockets, devices) ---

  it("skips non-regular files like FIFOs during directory scan", async () => {
    const dir = await makeTmpDir();
    await mkdir(path.join(dir, "facts"), { recursive: true });

    // Create a real memory that should be included
    await writeSyntheticMemory(dir, "facts", "real.md", {
      id: "real",
      content: "A real memory file.",
    });

    // Create a FIFO named with .md extension — readFile would hang on this
    const { execSync } = await import("node:child_process");
    const fifoPath = path.join(dir, "facts", "pipe.md");
    try {
      execSync(`mkfifo ${JSON.stringify(fifoPath)}`);
    } catch {
      // mkfifo may not be available (e.g. Windows) — skip test gracefully
      return;
    }

    const records = await convertMemoriesToRecords({ memoryDir: dir });
    // Only the real file should be included; the FIFO should be skipped
    assert.equal(records.length, 1);
    assert.equal(records[0].sourceIds?.[0], "real");
  });

  // --- Fix 10: Validate Date bounds in programmatic API ---

  it("throws when since is an Invalid Date", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      content: "Some content.",
    });

    await assert.rejects(
      () => convertMemoriesToRecords({ memoryDir: dir, since: new Date("garbage") }),
      (err: Error) => {
        assert.match(err.message, /since is an Invalid Date/);
        return true;
      },
    );
  });

  it("throws when until is an Invalid Date", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      content: "Some content.",
    });

    await assert.rejects(
      () => convertMemoriesToRecords({ memoryDir: dir, until: new Date("not-a-date") }),
      (err: Error) => {
        assert.match(err.message, /until is an Invalid Date/);
        return true;
      },
    );
  });

  it("does not throw when since/until are valid Date objects", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      created: "2026-06-15T00:00:00.000Z",
      content: "Some content.",
    });

    // Should not throw — valid dates
    const records = await convertMemoriesToRecords({
      memoryDir: dir,
      since: new Date("2026-01-01T00:00:00.000Z"),
      until: new Date("2026-12-31T00:00:00.000Z"),
    });
    assert.equal(records.length, 1);
  });

  // --- Fix 11: Reject symlinked memoryDir root ---

  it("throws when memoryDir root is a symlink", async () => {
    const dir = await makeTmpDir();
    // Create a real directory to be the symlink target
    const realDir = await makeTmpDir();
    await writeSyntheticMemory(realDir, "facts", "mem.md", {
      id: "mem",
      content: "Should not be reachable via symlink.",
    });

    // Create a symlink at a new path pointing to the real directory
    const symlinkPath = path.join(dir, "symlinked-memory");
    await symlink(realDir, symlinkPath);

    await assert.rejects(
      () => convertMemoriesToRecords({ memoryDir: symlinkPath }),
      (err: Error) => {
        assert.match(err.message, /memoryDir must not be a symlink/);
        return true;
      },
    );
  });

  it("does not throw when memoryDir root is a real directory", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      content: "A normal memory.",
    });

    // Should succeed — real directory, not a symlink
    const records = await convertMemoriesToRecords({ memoryDir: dir });
    assert.equal(records.length, 1);
  });

  // --- Fix 12: Reject invalid minConfidence values (NaN, out of range) ---

  it("throws when minConfidence is NaN", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      content: "Some content.",
    });

    await assert.rejects(
      () => convertMemoriesToRecords({ memoryDir: dir, minConfidence: NaN }),
      (err: Error) => {
        assert.match(err.message, /minConfidence must be a finite number between 0 and 1/);
        return true;
      },
    );
  });

  it("throws when minConfidence is Infinity", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      content: "Some content.",
    });

    await assert.rejects(
      () => convertMemoriesToRecords({ memoryDir: dir, minConfidence: Infinity }),
      (err: Error) => {
        assert.match(err.message, /minConfidence must be a finite number between 0 and 1/);
        return true;
      },
    );
  });

  it("throws when minConfidence is negative", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      content: "Some content.",
    });

    await assert.rejects(
      () => convertMemoriesToRecords({ memoryDir: dir, minConfidence: -0.5 }),
      (err: Error) => {
        assert.match(err.message, /minConfidence must be a finite number between 0 and 1/);
        return true;
      },
    );
  });

  it("throws when minConfidence is greater than 1", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      content: "Some content.",
    });

    await assert.rejects(
      () => convertMemoriesToRecords({ memoryDir: dir, minConfidence: 1.5 }),
      (err: Error) => {
        assert.match(err.message, /minConfidence must be a finite number between 0 and 1/);
        return true;
      },
    );
  });

  it("accepts minConfidence at boundary values 0 and 1", async () => {
    const dir = await makeTmpDir();
    await writeSyntheticMemory(dir, "facts", "mem.md", {
      id: "mem",
      confidence: 0.5,
      content: "Some content.",
    });

    // minConfidence=0 should not throw and should include everything
    const recordsMin = await convertMemoriesToRecords({ memoryDir: dir, minConfidence: 0 });
    assert.equal(recordsMin.length, 1);

    // minConfidence=1 should not throw (but will filter out 0.5 confidence)
    const recordsMax = await convertMemoriesToRecords({ memoryDir: dir, minConfidence: 1 });
    assert.equal(recordsMax.length, 0);
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
