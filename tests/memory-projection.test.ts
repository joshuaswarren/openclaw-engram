import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import {
  rebuildMemoryProjection,
  repairMemoryProjection,
  verifyMemoryProjection,
} from "../src/maintenance/rebuild-memory-projection.ts";
import {
  getMemoryProjectionPath,
  initializeMemoryProjectionDb,
  readProjectedMemoryState,
  readProjectedMemoryTimeline,
} from "../src/memory-projection-store.ts";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

test("projection-store queries fail open when projection database is absent", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-missing-"));
  try {
    const current = readProjectedMemoryState(memoryDir, "missing-memory");
    const timeline = readProjectedMemoryTimeline(memoryDir, "missing-memory", 50);

    assert.equal(current, null);
    assert.equal(timeline, null);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection dry-run computes current rows and timeline rows without writing output", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-dry-"));
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
    assert.equal(result.currentRows, 1);
    assert.equal(result.timelineRows, 2);
    assert.equal(result.usedLifecycleLedger, false);
    await assert.rejects(() => stat(result.outputPath));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection writes current-state and timeline rows and backs up existing projection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-live-"));
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
entityRef: person-josh
---

alpha
`,
    );
    await writeText(
      memoryDir,
      "state/memory-lifecycle-ledger.jsonl",
      [
        JSON.stringify({
          eventId: "evt-1",
          memoryId: "fact-1",
          eventType: "created",
          timestamp: "2026-03-08T00:00:00.000Z",
          actor: "storage.writeMemory",
          ruleVersion: "memory-lifecycle-ledger.v1",
        }),
        JSON.stringify({
          eventId: "evt-2",
          memoryId: "fact-1",
          eventType: "updated",
          timestamp: "2026-03-08T01:00:00.000Z",
          actor: "storage.updateMemory",
          ruleVersion: "memory-lifecycle-ledger.v1",
        }),
      ].join("\n") + "\n",
    );
    await writeText(memoryDir, "state/memory-projection.sqlite", "legacy-db");

    const result = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });
    assert.equal(result.currentRows, 1);
    assert.equal(result.timelineRows, 2);
    assert.equal(result.usedLifecycleLedger, true);
    assert.equal(result.backupPath != null, true);
    await stat(result.outputPath);

    const backupRaw = await readFile(result.backupPath as string, "utf-8");
    assert.equal(backupRaw, "legacy-db");

    const current = readProjectedMemoryState(memoryDir, "fact-1");
    assert.ok(current);
    assert.equal(current?.entityRef, "person-josh");
    assert.equal(current?.status, "active");

    const timeline = readProjectedMemoryTimeline(memoryDir, "fact-1", 20);
    assert.ok(timeline);
    assert.deepEqual(
      timeline?.map((entry) => [entry.eventType, entry.timestamp]),
      [
        ["created", "2026-03-08T00:00:00.000Z"],
        ["updated", "2026-03-08T01:00:00.000Z"],
      ],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection preserves archived status parity for archived files without explicit status", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-archived-"));
  try {
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      `---
id: fact-archived
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
archivedAt: 2026-03-08T02:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["archived"]
---

archived without explicit status
`,
    );

    const result = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });
    assert.equal(result.currentRows, 1);

    const current = readProjectedMemoryState(memoryDir, "fact-archived");
    assert.ok(current);
    assert.equal(current?.status, "archived");
    assert.equal(current?.archivedAt, "2026-03-08T02:00:00.000Z");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection treats active-plus-archivedAt memories as archived", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-archived-override-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-archived-override.md",
      `---
id: fact-archived-override
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
status: active
archivedAt: 2026-03-08T02:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["archived"]
---

archivedAt should override active
`,
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const current = readProjectedMemoryState(memoryDir, "fact-archived-override");
    assert.ok(current);
    assert.equal(current?.status, "archived");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection can refresh only memories inside an updated-at window", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-window-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-older.md",
      `---
id: fact-older
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
entityRef: project-older
tags: ["older"]
---

older
`,
    );
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-recent.md",
      `---
id: fact-recent
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T03:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
entityRef: project-before
tags: ["recent"]
---

recent
`,
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T04:00:00.000Z"),
    });
    {
      const db = new Database(getMemoryProjectionPath(memoryDir));
      try {
        db.prepare("UPDATE memory_current SET entity_ref = ? WHERE memory_id = ?")
          .run("project-corrupt", "fact-older");
      } finally {
        db.close();
      }
    }

    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-recent.md",
      `---
id: fact-recent
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T05:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
entityRef: project-after
tags: ["recent"]
---

recent updated
`,
    );

    const scoped = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      updatedAfter: "2026-03-08T02:00:00.000Z",
      now: new Date("2026-03-08T06:00:00.000Z"),
    });

    assert.equal(scoped.currentRows, 1);
    const scopedVerify = await verifyMemoryProjection({
      memoryDir,
      updatedAfter: "2026-03-08T02:00:00.000Z",
    });
    assert.equal(scopedVerify.ok, true);
    const older = readProjectedMemoryState(memoryDir, "fact-older");
    const recent = readProjectedMemoryState(memoryDir, "fact-recent");
    assert.equal(older?.entityRef, "project-corrupt");
    assert.equal(recent?.entityRef, "project-after");

    const fullVerify = await verifyMemoryProjection({ memoryDir });
    assert.equal(fullVerify.ok, false);
    assert.deepEqual(fullVerify.mismatchedCurrentMemoryIds, ["fact-older"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("scoped rebuild removes deleted memories that still exist in the projection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-delete-window-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-recent.md",
      `---
id: fact-recent
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T05:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["recent"]
---

recent
`,
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T06:00:00.000Z"),
    });

    await rm(path.join(memoryDir, "facts/2026-03-08/fact-recent.md"));

    const scoped = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      updatedAfter: "2026-03-08T02:00:00.000Z",
      now: new Date("2026-03-08T07:00:00.000Z"),
    });

    assert.equal(scoped.currentRows, 0);
    assert.equal(readProjectedMemoryState(memoryDir, "fact-recent"), null);
    assert.equal(readProjectedMemoryTimeline(memoryDir, "fact-recent", 20), null);

    const verify = await verifyMemoryProjection({ memoryDir });
    assert.equal(verify.ok, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("verifyMemoryProjection reports drift when projection is missing current rows", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-verify-"));
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

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T02:00:00.000Z"),
    });

    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-2.md",
      `---
id: fact-2
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T03:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["beta"]
---

beta
`,
    );

    const verify = await verifyMemoryProjection({ memoryDir });
    assert.equal(verify.ok, false);
    assert.deepEqual(verify.missingCurrentMemoryIds, ["fact-2"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("repairMemoryProjection dry-run reports drift and write mode repairs it", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-repair-"));
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

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T02:00:00.000Z"),
    });

    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-2.md",
      `---
id: fact-2
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T03:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["beta"]
---

beta
`,
    );

    const dryRun = await repairMemoryProjection({ memoryDir });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.repaired, false);
    assert.equal(dryRun.verify.ok, false);

    const writeResult = await repairMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T04:00:00.000Z"),
    });
    assert.equal(writeResult.dryRun, false);
    assert.equal(writeResult.repaired, true);
    assert.equal(writeResult.verify.ok, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager reads archive-path files as archived even without explicit status", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-storage-archived-read-"));
  try {
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      `---
id: fact-archived
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
archivedAt: 2026-03-08T02:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["archived"]
---

archived without explicit status
`,
    );

    const storage = new StorageManager(memoryDir);
    const current = await storage.getProjectedMemoryState("fact-archived");
    assert.ok(current);
    assert.equal(current?.status, "archived");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager treats memories with archivedAt as archived in projected-state fallback", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-storage-archivedat-read-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-archivedat.md",
      `---
id: fact-archivedat
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
archivedAt: 2026-03-08T02:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["archived"]
---

archivedAt without explicit status
`,
    );

    const storage = new StorageManager(memoryDir);
    const current = await storage.getProjectedMemoryState("fact-archivedat");
    assert.ok(current);
    assert.equal(current?.status, "archived");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager does not infer archived status from archive in ancestor directories", async () => {
  const archiveParent = path.join(os.tmpdir(), "archive");
  await mkdir(archiveParent, { recursive: true });
  const memoryDir = await mkdtemp(path.join(archiveParent, "engram-storage-live-under-archive-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-active.md",
      `---
id: fact-active
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["active"]
---

active memory under archive-named parent
`,
    );

    const storage = new StorageManager(memoryDir);
    const current = await storage.getProjectedMemoryState("fact-active");
    assert.ok(current);
    assert.equal(current?.status, "active");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager projection helpers fail open to markdown and lifecycle ledger", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-storage-projection-fallback-"));
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
      timeline.map((entry) => entry.eventType),
      ["created", "updated"],
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const projectedTimeline = await storage.getMemoryTimeline(memoryId);
    assert.deepEqual(
      projectedTimeline.map((entry) => entry.eventType),
      ["created", "updated"],
    );

    const secondId = await storage.writeMemory("fact", "written after projection rebuild", {
      source: "test",
    });
    await storage.updateMemory(secondId, "written after projection rebuild updated");

    const fallbackAfterProjection = await storage.getMemoryTimeline(secondId);
    assert.deepEqual(
      fallbackAfterProjection.map((entry) => entry.eventType),
      ["created", "updated"],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager falls back when projection database exists but has no timeline row for a memory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-storage-projection-empty-row-"));
  try {
    const storage = new StorageManager(memoryDir);
    const memoryId = await storage.writeMemory("fact", "fallback memory", {
      source: "test",
      tags: ["fallback"],
    });
    await storage.updateMemory(memoryId, "fallback memory updated");

    const projectionPath = getMemoryProjectionPath(memoryDir);
    await mkdir(path.dirname(projectionPath), { recursive: true });
    const db = new Database(projectionPath);
    try {
      initializeMemoryProjectionDb(db);
    } finally {
      db.close();
    }

    const timeline = await storage.getMemoryTimeline(memoryId);
    assert.deepEqual(
      timeline.map((entry) => entry.eventType),
      ["created", "updated"],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
