import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NegativeExampleStore } from "../src/negative.ts";
import { LastRecallStore } from "../src/recall-state.ts";

test("NegativeExampleStore records not-useful hits and applies bounded penalty", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-neg-"));

  const store = new NegativeExampleStore(dir);
  await store.load();

  await store.recordNotUseful(["fact-1", "fact-1", "fact-2"], "not relevant");

  // First hit: 1 * perHit
  assert.equal(store.penalty("fact-2", { perHit: 0.05, cap: 0.25 }), 0.05);
  // fact-1 has two hits; still bounded by cap.
  assert.equal(store.penalty("fact-1", { perHit: 0.05, cap: 0.25 }), 0.10);

  const raw = await readFile(path.join(dir, "state", "negative_examples.json"), "utf-8");
  const parsed = JSON.parse(raw) as Record<string, { notUseful: number }>;
  assert.equal(parsed["fact-1"]?.notUseful, 2);
  assert.equal(parsed["fact-2"]?.notUseful, 1);
});

test("LastRecallStore records snapshots without storing raw query text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-"));

  const store = new LastRecallStore(dir);
  await store.load();

  await store.record({
    sessionKey: "main",
    query: "why did you say that?",
    memoryIds: ["fact-1", "preference-2"],
  });

  const snap = store.get("main");
  assert.ok(snap);
  assert.equal(snap.sessionKey, "main");
  assert.equal(snap.memoryIds.length, 2);
  assert.equal(snap.queryHash.length, 64);
});

