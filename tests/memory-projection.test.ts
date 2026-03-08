import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import { rebuildMemoryProjection } from "../src/maintenance/rebuild-memory-projection.ts";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

test("rebuildMemoryProjection dry-run infers timeline rows when lifecycle ledger is absent", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-projection-dry-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
    );

    const result = await rebuildMemoryProjection({ memoryDir });
    assert.equal(result.dryRun, true);
    assert.equal(result.scannedMemories, 1);
    assert.equal(result.currentRows, 1);
    assert.equal(result.timelineRows, 2);
    assert.equal(result.usedLifecycleLedger, false);
    await assert.rejects(() => stat(result.outputPath));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection writes current-state and timeline rows and backs up existing db", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-projection-live-"));
  try {
    const storage = new StorageManager(memoryDir);
    const activeId = await storage.writeMemory("fact", "alpha", {
      source: "test",
      tags: ["alpha"],
    });
    await storage.updateMemory(activeId, "alpha updated");

    const archivedId = await storage.writeMemory("decision", "beta", {
      source: "test",
      tags: ["beta"],
    });
    const archived = await storage.getMemoryById(archivedId);
    assert.ok(archived);
    await storage.archiveMemory(archived);

    await writeText(memoryDir, "state/memory-projection.sqlite", "legacy-db");

    const result = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    assert.equal(result.currentRows, 2);
    assert.equal(result.timelineRows, 4);
    assert.equal(result.usedLifecycleLedger, true);
    assert.equal(result.backupPath != null, true);

    const backupRaw = await readFile(result.backupPath as string, "utf-8");
    assert.equal(backupRaw, "legacy-db");

    const db = new Database(result.outputPath, { readonly: true });
    try {
      const currentRows = db
        .prepare(
          "SELECT memory_id, status, path_rel FROM memory_current ORDER BY memory_id",
        )
        .all() as Array<{ memory_id: string; status: string; path_rel: string }>;
      assert.equal(currentRows.length, 2);
      assert.equal(currentRows.some((row) => row.memory_id === activeId && row.status === "active"), true);
      assert.equal(currentRows.some((row) => row.memory_id === archivedId && row.status === "archived"), true);

      const timelineRows = db
        .prepare(
          "SELECT event_type FROM memory_timeline WHERE memory_id = ? ORDER BY timestamp, event_order",
        )
        .all(activeId) as Array<{ event_type: string }>;
      assert.deepEqual(
        timelineRows.map((row) => row.event_type),
        ["created", "updated"],
      );
    } finally {
      db.close();
    }

    const current = await storage.getProjectedMemoryState(activeId);
    assert.ok(current);
    assert.equal(current?.status, "active");

    const timeline = await storage.getMemoryTimeline(archivedId);
    assert.deepEqual(
      timeline.map((event) => event.eventType),
      ["created", "archived"],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager projection queries fail open to markdown and ledger state", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-fallback-"));
  try {
    const storage = new StorageManager(memoryDir);
    const memoryId = await storage.writeMemory("fact", "fallback memory", {
      source: "test",
      tags: ["fallback"],
    });
    await storage.updateMemory(memoryId, "fallback memory updated");

    const current = await storage.getProjectedMemoryState(memoryId);
    assert.ok(current);
    assert.equal(current?.status, "active");

    const timeline = await storage.getMemoryTimeline(memoryId);
    assert.deepEqual(
      timeline.map((event) => event.eventType),
      ["created", "updated"],
    );

    const archivedId = await storage.writeMemory("fact", "archive fallback", { source: "test" });
    const archived = await storage.getMemoryById(archivedId);
    assert.ok(archived);
    await storage.archiveMemory(archived);

    const projectionPath = path.join(memoryDir, "state", "memory-projection.sqlite");
    await unlink(projectionPath).catch(() => undefined);

    const archivedCurrent = await storage.getProjectedMemoryState(archivedId);
    assert.ok(archivedCurrent);
    assert.equal(archivedCurrent?.status, "archived");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
