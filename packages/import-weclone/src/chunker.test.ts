// ---------------------------------------------------------------------------
// Tests — thread chunker
// ---------------------------------------------------------------------------

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ImportTurn } from "@remnic/core";
import type { ThreadGroup } from "./threader.js";
import { chunkThreads } from "./chunker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(index: number): ImportTurn {
  return {
    role: "user",
    content: `message-${index}`,
    timestamp: `2025-01-10T${String(index).padStart(2, "0")}:00:00.000Z`,
    participantId: "Alice",
  };
}

function makeThread(turnCount: number, startIndex = 0): ThreadGroup {
  const turns: ImportTurn[] = [];
  for (let i = 0; i < turnCount; i += 1) {
    turns.push(makeTurn(startIndex + i));
  }
  return {
    turns,
    threadId: `thread-${startIndex}`,
    startTime: turns[0].timestamp,
    endTime: turns[turns.length - 1].timestamp,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chunkThreads", () => {
  it("keeps short threads as a single chunk", () => {
    const threads = [makeThread(5)];
    const chunks = chunkThreads(threads, { maxTurnsPerChunk: 20 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 5);
  });

  it("splits long threads at maxTurnsPerChunk with overlap", () => {
    const threads = [makeThread(10)];
    const chunks = chunkThreads(threads, {
      maxTurnsPerChunk: 4,
      overlapTurns: 1,
    });
    // Step = 4 - 1 = 3. Chunks start at 0, 3, 6, 9
    // Chunk 0: [0,1,2,3], Chunk 1: [3,4,5,6], Chunk 2: [6,7,8,9], Chunk 3: [9]
    // But chunk 3 starts at 9 and takes turns 9 (just 1 turn)
    assert.ok(chunks.length >= 3);
    // First chunk should have maxTurnsPerChunk turns
    assert.equal(chunks[0].length, 4);
    // Check overlap: last turn of chunk 0 should equal first turn of chunk 1
    assert.equal(chunks[0][3].content, chunks[1][0].content);
  });

  it("preserves overlap turns between consecutive chunks", () => {
    const threads = [makeThread(8)];
    const chunks = chunkThreads(threads, {
      maxTurnsPerChunk: 5,
      overlapTurns: 2,
    });
    // Step = 5 - 2 = 3. Chunks start at 0, 3
    // Chunk 0: [0..4] (5 turns), Chunk 1: [3..7] (5 turns, reaches end)
    assert.equal(chunks.length, 2);
    // Overlap: last 2 of chunk 0 match first 2 of chunk 1
    assert.equal(chunks[0][3].content, chunks[1][0].content);
    assert.equal(chunks[0][4].content, chunks[1][1].content);
  });

  it("handles empty threads array", () => {
    assert.deepEqual(chunkThreads([]), []);
  });

  it("handles null/undefined threads", () => {
    assert.deepEqual(chunkThreads(null as unknown as ThreadGroup[]), []);
  });

  it("uses default options (maxTurnsPerChunk=20, overlap=2)", () => {
    const threads = [makeThread(15)];
    const chunks = chunkThreads(threads);
    // 15 turns with max 20 — fits in a single chunk
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 15);
  });

  it("handles multiple threads", () => {
    const threads = [
      makeThread(3, 0),
      makeThread(3, 10),
    ];
    const chunks = chunkThreads(threads, { maxTurnsPerChunk: 20 });
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 3);
    assert.equal(chunks[1].length, 3);
  });

  it("handles threads with exactly maxTurnsPerChunk turns", () => {
    const threads = [makeThread(5)];
    const chunks = chunkThreads(threads, { maxTurnsPerChunk: 5 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 5);
  });

  it("custom chunk options override defaults", () => {
    const threads = [makeThread(6)];
    const chunks = chunkThreads(threads, {
      maxTurnsPerChunk: 3,
      overlapTurns: 0,
    });
    // Step = max(1, 3-0) = 3. Chunks: [0,1,2], [3,4,5]
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 3);
    assert.equal(chunks[1].length, 3);
  });
});
