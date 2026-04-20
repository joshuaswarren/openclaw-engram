/**
 * Storage round-trip tests for the consolidation provenance frontmatter
 * fields introduced in issue #561 PR 1:
 *
 *   - `derived_from?: string[]`  — `"<path>:<version>"` references into the
 *     page-versioning snapshots.
 *   - `derived_via?: "split" | "merge" | "update"` — which consolidation
 *     operator produced this memory.
 *
 * PR 1 only wires the frontmatter round-trip (preservation on read/write)
 * and the write-path validator.  No code emits these fields yet — that
 * lands in PR 2.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("StorageManager round-trips derived_from and derived_via frontmatter", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const day = "2026-04-19";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-derived-roundtrip";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-19T01:00:00.000Z",
      "updated: 2026-04-19T01:00:00.000Z",
      "source: test",
      "confidence: 0.9",
      "confidenceTier: implied",
      'tags: ["consolidation"]',
      'derived_from: ["facts/a.md:2", "facts/b.md:5"]',
      "derived_via: merge",
      "---",
      "",
      "merged payload",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory, "memory should be readable");
    assert.deepEqual(memory.frontmatter.derived_from, [
      "facts/a.md:2",
      "facts/b.md:5",
    ]);
    assert.equal(memory.frontmatter.derived_via, "merge");

    // Rewrite via archive — the serializer must emit the same fields.
    const archivedPath = await storage.archiveMemory(memory);
    assert.ok(archivedPath, "memory should archive");

    const archivedRaw = await readFile(archivedPath, "utf-8");
    assert.ok(
      archivedRaw.includes('derived_from: ["facts/a.md:2", "facts/b.md:5"]'),
      `archived file should contain derived_from line; got:\n${archivedRaw}`,
    );
    assert.ok(
      archivedRaw.includes("derived_via: merge"),
      `archived file should contain derived_via line; got:\n${archivedRaw}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager reads legacy memories without derived_from or derived_via", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-legacy-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const id = await storage.writeMemory("fact", "legacy payload", {
      source: "test",
    });
    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory, "legacy memory should load");
    assert.equal(memory.frontmatter.derived_from, undefined);
    assert.equal(memory.frontmatter.derived_via, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager supports all three ConsolidationOperator values on derived_via", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-ops-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const day = "2026-04-19";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const operators: Array<"split" | "merge" | "update"> = ["split", "merge", "update"];
    for (const op of operators) {
      const id = `fact-derived-${op}`;
      const filePath = path.join(factDir, `${id}.md`);
      const raw = [
        "---",
        `id: ${id}`,
        "category: fact",
        "created: 2026-04-19T01:00:00.000Z",
        "updated: 2026-04-19T01:00:00.000Z",
        "source: test",
        "confidence: 0.8",
        "confidenceTier: implied",
        'tags: ["consolidation"]',
        'derived_from: ["facts/source.md:1"]',
        `derived_via: ${op}`,
        "---",
        "",
        `${op} payload`,
        "",
      ].join("\n");
      await writeFile(filePath, raw, "utf-8");
    }

    const all = await storage.readAllMemories();
    for (const op of operators) {
      const memory = all.find((m) => m.frontmatter.id === `fact-derived-${op}`);
      assert.ok(memory, `memory for operator ${op} should load`);
      assert.equal(memory.frontmatter.derived_via, op);
      assert.deepEqual(memory.frontmatter.derived_from, ["facts/source.md:1"]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager rejects malformed derived_from on write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-malformed-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const id = await storage.writeMemory("fact", "seed payload", { source: "test" });
    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory);

    const targetPath = path.join(dir, "facts", "2026-04-19", `${id}.md`);

    // Each case is a distinct malformed `derived_from` value that the
    // serializer must reject.  Tests cover: missing version, non-numeric
    // version, empty string, and non-array shape.
    const badEntries: Array<unknown[]> = [
      ["facts/a.md"], // missing version
      ["facts/a.md:abc"], // non-numeric version
      [""], // empty entry
      ["facts/a.md:-1"], // negative version
    ];
    for (const bad of badEntries) {
      const mutated = {
        ...memory,
        frontmatter: { ...memory.frontmatter, derived_from: bad as string[] },
      };
      await assert.rejects(
        () => storage.moveMemoryToPath(mutated, targetPath),
        /invalid derived_from entry/,
        `should reject malformed derived_from ${JSON.stringify(bad)}`,
      );
    }

    // Non-array shape is rejected with a different error message.
    const nonArray = {
      ...memory,
      frontmatter: {
        ...memory.frontmatter,
        derived_from: "facts/a.md:2" as unknown as string[],
      },
    };
    await assert.rejects(
      () => storage.moveMemoryToPath(nonArray, targetPath),
      /derived_from must be an array/,
      "should reject non-array derived_from",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager rejects unknown derived_via on write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-via-unknown-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const id = await storage.writeMemory("fact", "seed payload", { source: "test" });
    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory);

    const targetPath = path.join(dir, "facts", "2026-04-19", `${id}.md`);
    const mutated = {
      ...memory,
      frontmatter: {
        ...memory.frontmatter,
        derived_via: "annihilate" as unknown as "split" | "merge" | "update",
      },
    };

    await assert.rejects(
      () => storage.moveMemoryToPath(mutated, targetPath),
      /invalid derived_via/,
      "should reject unknown derived_via",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager tolerates unknown derived_via on read (drops to undefined)", async () => {
  // Read-path is intentionally permissive so future operator additions
  // don't brick a rollback to an older build.  Write-path rejects unknown
  // operators (covered in semantic-consolidation.test below).
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-derived-unknown-op-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const day = "2026-04-19";
    const factDir = path.join(dir, "facts", day);
    await mkdir(factDir, { recursive: true });

    const id = "fact-derived-unknown";
    const filePath = path.join(factDir, `${id}.md`);
    const raw = [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-04-19T01:00:00.000Z",
      "updated: 2026-04-19T01:00:00.000Z",
      "source: test",
      "confidence: 0.8",
      "confidenceTier: implied",
      'tags: ["consolidation"]',
      "derived_via: annihilate",
      "---",
      "",
      "payload",
      "",
    ].join("\n");
    await writeFile(filePath, raw, "utf-8");

    const all = await storage.readAllMemories();
    const memory = all.find((m) => m.frontmatter.id === id);
    assert.ok(memory);
    assert.equal(memory.frontmatter.derived_via, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
