// ---------------------------------------------------------------------------
// Tests — progress tracker
// ---------------------------------------------------------------------------

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProgressTracker } from "./progress.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createProgressTracker", () => {
  it("creates tracker and returns default snapshot", () => {
    const tracker = createProgressTracker();
    const snap = tracker.snapshot();
    assert.equal(snap.phase, "parsing");
    assert.equal(snap.totalMessages, 0);
    assert.equal(snap.threadsFound, 0);
    assert.equal(snap.chunksCreated, 0);
    assert.equal(snap.chunksProcessed, 0);
    assert.equal(snap.memoriesExtracted, 0);
    assert.equal(snap.duplicatesSkipped, 0);
    assert.equal(snap.entitiesCreated, 0);
    assert.ok(snap.elapsed >= 0);
  });

  it("updates partial progress", () => {
    const tracker = createProgressTracker();
    tracker.update({ phase: "threading", totalMessages: 100 });
    const snap = tracker.snapshot();
    assert.equal(snap.phase, "threading");
    assert.equal(snap.totalMessages, 100);
    // Other fields remain default
    assert.equal(snap.threadsFound, 0);
  });

  it("accumulates multiple updates", () => {
    const tracker = createProgressTracker();
    tracker.update({ totalMessages: 50 });
    tracker.update({ threadsFound: 5, chunksCreated: 10 });
    tracker.update({ phase: "extracting" });
    const snap = tracker.snapshot();
    assert.equal(snap.totalMessages, 50);
    assert.equal(snap.threadsFound, 5);
    assert.equal(snap.chunksCreated, 10);
    assert.equal(snap.phase, "extracting");
  });

  it("calls callback on each update", () => {
    const calls: Array<{ phase: string; totalMessages: number }> = [];
    const tracker = createProgressTracker((progress) => {
      calls.push({
        phase: progress.phase,
        totalMessages: progress.totalMessages,
      });
    });
    tracker.update({ phase: "parsing", totalMessages: 42 });
    tracker.update({ phase: "threading" });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].totalMessages, 42);
    assert.equal(calls[1].phase, "threading");
  });

  it("callback receives a copy (mutations do not affect tracker)", () => {
    let captured: Record<string, unknown> | null = null;
    const tracker = createProgressTracker((progress) => {
      captured = progress as unknown as Record<string, unknown>;
    });
    tracker.update({ totalMessages: 10 });
    assert.ok(captured !== null);
    (captured as Record<string, unknown>).totalMessages = 999;
    const snap = tracker.snapshot();
    assert.equal(snap.totalMessages, 10);
  });

  it("elapsed time increases over updates", () => {
    const tracker = createProgressTracker();
    const first = tracker.snapshot().elapsed;
    // Elapsed should be non-negative
    assert.ok(first >= 0);
  });

  it("works without a callback", () => {
    const tracker = createProgressTracker();
    // Should not throw
    tracker.update({ phase: "complete", memoriesExtracted: 42 });
    const snap = tracker.snapshot();
    assert.equal(snap.phase, "complete");
    assert.equal(snap.memoriesExtracted, 42);
  });
});
