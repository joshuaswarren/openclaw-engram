// ---------------------------------------------------------------------------
// Tests — conversation threader
// ---------------------------------------------------------------------------

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ImportTurn } from "@remnic/core";
import { groupIntoThreads } from "./threader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(
  overrides: Partial<ImportTurn> & { timestamp: string },
): ImportTurn {
  return {
    role: "user",
    content: "test message",
    participantId: "Alice",
    participantName: "Alice",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("groupIntoThreads", () => {
  it("groups messages into threads by time gap", () => {
    const turns: ImportTurn[] = [
      makeTurn({ timestamp: "2025-01-10T08:00:00.000Z", content: "a" }),
      makeTurn({ timestamp: "2025-01-10T08:05:00.000Z", content: "b" }),
      // 2 hour gap
      makeTurn({ timestamp: "2025-01-10T10:05:00.000Z", content: "c" }),
      makeTurn({ timestamp: "2025-01-10T10:10:00.000Z", content: "d" }),
    ];
    const threads = groupIntoThreads(turns);
    assert.equal(threads.length, 2);
    assert.equal(threads[0].turns.length, 2);
    assert.equal(threads[1].turns.length, 2);
    assert.equal(threads[0].threadId, "thread-0001");
    assert.equal(threads[1].threadId, "thread-0002");
  });

  it("sorts turns by timestamp before grouping", () => {
    const turns: ImportTurn[] = [
      makeTurn({ timestamp: "2025-01-10T10:00:00.000Z", content: "later1" }),
      makeTurn({ timestamp: "2025-01-10T08:00:00.000Z", content: "earlier" }),
      makeTurn({ timestamp: "2025-01-10T08:05:00.000Z", content: "middle" }),
      makeTurn({ timestamp: "2025-01-10T10:05:00.000Z", content: "later2" }),
    ];
    const threads = groupIntoThreads(turns);
    assert.equal(threads.length, 2);
    // First thread should have the two earlier messages sorted correctly
    assert.equal(threads[0].turns[0].content, "earlier");
    assert.equal(threads[0].turns[1].content, "middle");
    // Second thread should have the two later messages
    assert.equal(threads[1].turns[0].content, "later1");
    assert.equal(threads[1].turns[1].content, "later2");
  });

  it("keeps replies in the same thread via replyToId", () => {
    const turns: ImportTurn[] = [
      makeTurn({
        timestamp: "2025-01-10T08:00:00.000Z",
        content: "original",
        participantId: "msg-1",
      }),
      makeTurn({
        timestamp: "2025-01-10T08:05:00.000Z",
        content: "unrelated",
        participantId: "msg-2",
      }),
      // Reply arrives 2 hours later but references msg-1
      makeTurn({
        timestamp: "2025-01-10T10:00:00.000Z",
        content: "reply to original",
        replyToId: "msg-1",
        participantId: "msg-3",
      }),
    ];
    const threads = groupIntoThreads(turns);
    // The reply should be grouped with the original message's thread
    const threadWithOriginal = threads.find((t) =>
      t.turns.some((turn) => turn.content === "original"),
    );
    assert.ok(threadWithOriginal, "should find thread with original message");
    assert.ok(
      threadWithOriginal.turns.some((turn) => turn.content === "reply to original"),
      "reply should be in the same thread as original",
    );
  });

  it("filters out single-message threads by default (minThreadSize=2)", () => {
    const turns: ImportTurn[] = [
      makeTurn({ timestamp: "2025-01-10T08:00:00.000Z", content: "lonely" }),
      // Big gap
      makeTurn({ timestamp: "2025-01-10T12:00:00.000Z", content: "pair1" }),
      makeTurn({ timestamp: "2025-01-10T12:05:00.000Z", content: "pair2" }),
    ];
    const threads = groupIntoThreads(turns);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].turns.length, 2);
    assert.equal(threads[0].turns[0].content, "pair1");
  });

  it("respects custom gap threshold", () => {
    const turns: ImportTurn[] = [
      makeTurn({ timestamp: "2025-01-10T08:00:00.000Z", content: "a" }),
      // 10 minute gap
      makeTurn({ timestamp: "2025-01-10T08:10:00.000Z", content: "b" }),
      makeTurn({ timestamp: "2025-01-10T08:15:00.000Z", content: "c" }),
    ];
    // With 5-minute gap threshold, the 10-min gap should split
    const threads = groupIntoThreads(turns, {
      gapThresholdMs: 5 * 60 * 1000,
    });
    // First thread has 1 message (filtered out), second has 2
    assert.equal(threads.length, 1);
    assert.equal(threads[0].turns[0].content, "b");
  });

  it("returns empty array for empty turns", () => {
    assert.deepEqual(groupIntoThreads([]), []);
  });

  it("returns empty array for null/undefined turns", () => {
    assert.deepEqual(groupIntoThreads(null as unknown as ImportTurn[]), []);
    assert.deepEqual(groupIntoThreads(undefined as unknown as ImportTurn[]), []);
  });

  it("respects custom minThreadSize", () => {
    const turns: ImportTurn[] = [
      makeTurn({ timestamp: "2025-01-10T08:00:00.000Z", content: "solo" }),
      // Big gap
      makeTurn({ timestamp: "2025-01-10T12:00:00.000Z", content: "pair1" }),
      makeTurn({ timestamp: "2025-01-10T12:05:00.000Z", content: "pair2" }),
    ];
    const threads = groupIntoThreads(turns, { minThreadSize: 1 });
    assert.equal(threads.length, 2);
  });

  it("assigns start and end times from thread turns", () => {
    const turns: ImportTurn[] = [
      makeTurn({ timestamp: "2025-01-10T08:00:00.000Z", content: "a" }),
      makeTurn({ timestamp: "2025-01-10T08:20:00.000Z", content: "b" }),
    ];
    const threads = groupIntoThreads(turns);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].startTime, "2025-01-10T08:00:00.000Z");
    assert.equal(threads[0].endTime, "2025-01-10T08:20:00.000Z");
  });
});
