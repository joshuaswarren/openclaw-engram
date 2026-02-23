import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("StorageManager appends and reads memory action events from state store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-actions-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const wrote = await storage.appendMemoryActionEvents([
      {
        timestamp: "2026-02-23T00:00:00.000Z",
        action: "store_note",
        outcome: "applied",
        reason: "seed",
      },
      {
        timestamp: "2026-02-23T00:00:01.000Z",
        action: "summarize_node",
        outcome: "skipped",
      },
      {
        timestamp: "2026-02-23T00:00:02.000Z",
        action: "discard",
        outcome: "failed",
      },
    ]);

    assert.equal(wrote, 3);

    const events = await storage.readMemoryActionEvents(2);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.action, "summarize_node");
    assert.equal(events[1]?.action, "discard");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager readMemoryActionEvents ignores malformed rows (fail-open)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-malformed-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await storage.appendMemoryActionEvents([
      {
        timestamp: "2026-02-23T00:00:00.000Z",
        action: "store_episode",
        outcome: "applied",
      },
    ]);

    const malformedPath = path.join(dir, "state", "memory-actions.jsonl");
    await appendFile(malformedPath, "{not-json}\n", "utf-8");

    const events = await storage.readMemoryActionEvents(10);
    assert.equal(events.length, 1);
    assert.equal(events.every((e) => typeof e.timestamp === "string" && e.timestamp.length > 0), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager writes and reads compression guidelines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-guidelines-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    assert.equal(await storage.readCompressionGuidelines(), null);

    const content = "# Compression Guidelines\n\n- Prefer concise summary bullets.\n";
    await storage.writeCompressionGuidelines(content);

    const loaded = await storage.readCompressionGuidelines();
    assert.equal(loaded, content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
