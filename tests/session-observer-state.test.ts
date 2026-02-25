import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { SessionObserverState } from "../src/session-observer-state.ts";

test("session observer establishes baseline then triggers when threshold is crossed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-"));
  try {
    const observer = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 60_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 1_000, triggerDeltaTokens: 200 }],
    });
    await observer.load();

    const baseline = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_000,
      totalTokens: 2_500,
      observedAt: "2026-02-25T00:00:00.000Z",
    });
    assert.equal(baseline.triggered, false);
    assert.equal(baseline.reason, "baseline");

    const trigger = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 11_500,
      totalTokens: 2_900,
      observedAt: "2026-02-25T00:01:00.000Z",
    });
    assert.equal(trigger.triggered, true);
    assert.equal(trigger.reason, "threshold");
    assert.equal(trigger.deltaBytes, 1_500);
    assert.equal(trigger.deltaTokens, 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session observer applies per-session debounce after trigger", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-session-observer-debounce-"));
  try {
    const observer = new SessionObserverState({
      memoryDir: dir,
      debounceMs: 120_000,
      bands: [{ maxBytes: 100_000, triggerDeltaBytes: 500, triggerDeltaTokens: 100 }],
    });
    await observer.load();

    await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 10_000,
      totalTokens: 2_500,
      observedAt: "2026-02-25T00:00:00.000Z",
    });
    const first = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 11_000,
      totalTokens: 2_700,
      observedAt: "2026-02-25T00:01:00.000Z",
    });
    assert.equal(first.triggered, true);

    const debounced = await observer.observe({
      sessionKey: "agent:generalist:main",
      totalBytes: 12_000,
      totalTokens: 2_900,
      observedAt: "2026-02-25T00:02:00.000Z",
    });
    assert.equal(debounced.triggered, false);
    assert.equal(debounced.reason, "debounced");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
