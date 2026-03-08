import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import { rebuildMemoryLifecycleLedger } from "../src/maintenance/rebuild-memory-lifecycle-ledger.ts";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

test("StorageManager appends and reads memory lifecycle events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-events-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const wrote = await storage.appendMemoryLifecycleEvents([
      {
        eventId: "evt-1",
        memoryId: "fact-1",
        eventType: "created",
        timestamp: "2026-03-08T00:00:00.000Z",
        actor: "storage.writeMemory",
        ruleVersion: "memory-lifecycle-ledger.v1",
      },
      {
        eventId: "evt-2",
        memoryId: "fact-1",
        eventType: "updated",
        timestamp: "2026-03-08T00:01:00.000Z",
        actor: "storage.updateMemory",
        ruleVersion: "memory-lifecycle-ledger.v1",
      },
    ]);

    assert.equal(wrote, 2);
    const loaded = await storage.readMemoryLifecycleEvents(10);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]?.eventType, "created");
    assert.equal(loaded[1]?.eventType, "updated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager readMemoryLifecycleEvents ignores malformed rows fail-open", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-malformed-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await storage.appendMemoryLifecycleEvents([
      {
        eventId: "evt-1",
        memoryId: "fact-1",
        eventType: "created",
        timestamp: "2026-03-08T00:00:00.000Z",
        actor: "storage.writeMemory",
        ruleVersion: "memory-lifecycle-ledger.v1",
      },
    ]);
    await appendFile(path.join(dir, "state", "memory-lifecycle-ledger.jsonl"), "{bad-json}\n", "utf-8");

    const loaded = await storage.readMemoryLifecycleEvents(10);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.memoryId, "fact-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager emits created updated and archived lifecycle events for memory mutations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-memory-lifecycle-mutations-"));
  try {
    const storage = new StorageManager(dir);
    const id = await storage.writeMemory("fact", "Initial memory content", {
      source: "test",
      tags: ["lifecycle"],
    });
    const memories = await storage.readAllMemories();
    const memory = memories.find((entry) => entry.frontmatter.id === id);
    assert.ok(memory);

    const updated = await storage.updateMemory(id, "Updated memory content");
    assert.equal(updated, true);

    const archivedPath = await storage.archiveMemory(memory!);
    assert.equal(typeof archivedPath, "string");

    const events = await storage.readMemoryLifecycleEvents(10);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.eventType), ["created", "updated", "archived"]);
    assert.equal(events.every((event) => event.memoryId === id), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rebuildMemoryLifecycleLedger dry-run computes inferred events without writing output", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-dry-"));
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
  await writeText(
    memoryDir,
    "archive/2026-03-08/fact-2.md",
    `---
id: fact-2
category: fact
created: 2026-03-07T00:00:00.000Z
updated: 2026-03-08T02:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["beta"]
status: archived
archivedAt: 2026-03-08T02:00:00.000Z
---

beta
`,
  );

  const result = await rebuildMemoryLifecycleLedger({ memoryDir });
  assert.equal(result.dryRun, true);
  assert.equal(result.scannedMemories, 2);
  assert.equal(result.rebuiltRows, 4);
  await assert.rejects(() => stat(result.outputPath));
});

test("rebuildMemoryLifecycleLedger writes deterministic ledger and backs up existing file", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-rebuild-memory-lifecycle-live-"));
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
  await writeText(
    memoryDir,
    "state/memory-lifecycle-ledger.jsonl",
    "{\"legacy\":true}\n",
  );

  const result = await rebuildMemoryLifecycleLedger({
    memoryDir,
    dryRun: false,
    now: new Date("2026-03-08T12:00:00.000Z"),
  });

  assert.equal(result.rebuiltRows, 2);
  assert.equal(result.backupPath != null, true);

  const backupRaw = await readFile(result.backupPath as string, "utf-8");
  assert.equal(backupRaw, "{\"legacy\":true}\n");

  const rebuiltRaw = await readFile(result.outputPath, "utf-8");
  const rows = rebuiltRaw.trim().split("\n").map((line) => JSON.parse(line) as any);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.eventType), ["created", "updated"]);
  assert.equal(rows[0]?.memoryId, "fact-1");
} );
