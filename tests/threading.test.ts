import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadingManager } from "../src/threading.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "engram-threading-"));
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

test("appendEpisodeIds appends IDs to existing thread", async () => {
  const dir = await makeTmp();
  try {
    const tm = new ThreadingManager(path.join(dir, "threads"), 30);
    const turn = {
      role: "user" as const,
      content: "hello",
      timestamp: "2026-02-22T15:00:00.000Z",
      sessionKey: "s1",
    };

    const threadId = await tm.processTurn(turn, []);
    await tm.appendEpisodeIds(threadId, ["fact-1", "fact-2"]);

    const thread = await tm.loadThread(threadId);
    assert.ok(thread);
    assert.deepEqual(thread!.episodeIds, ["fact-1", "fact-2"]);
  } finally {
    await cleanup(dir);
  }
});

test("appendEpisodeIds de-duplicates existing IDs", async () => {
  const dir = await makeTmp();
  try {
    const tm = new ThreadingManager(path.join(dir, "threads"), 30);
    const turn = {
      role: "user" as const,
      content: "hello",
      timestamp: "2026-02-22T15:00:00.000Z",
      sessionKey: "s1",
    };

    const threadId = await tm.processTurn(turn, ["fact-1"]);
    await tm.appendEpisodeIds(threadId, ["fact-1", "fact-2"]);

    const thread = await tm.loadThread(threadId);
    assert.ok(thread);
    assert.deepEqual(thread!.episodeIds, ["fact-1", "fact-2"]);
  } finally {
    await cleanup(dir);
  }
});
