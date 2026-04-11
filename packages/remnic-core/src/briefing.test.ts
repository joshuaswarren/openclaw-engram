/**
 * Regression tests for 5 reviewer findings on the daily briefing module.
 * All fixtures are synthetic — no real user data.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  filterMemoriesByWindow,
  buildRecentEntities,
  eventFallsOnDate,
  parseBriefingWindow,
} from "./briefing.js";
import type { MemoryFile, EntityFile, CalendarEvent } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// Helpers — synthetic fixtures
// ──────────────────────────────────────────────────────────────────────────

function makeMemory(updated: string): MemoryFile {
  return {
    path: "/synthetic/mem.md",
    frontmatter: {
      id: "test-mem",
      category: "fact",
      created: updated,
      updated,
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
    },
    content: "synthetic memory",
  };
}

function makeEntity(updated: string): EntityFile {
  return {
    name: "SyntheticEntity",
    type: "project",
    updated,
    facts: ["synthetic fact"],
    relationships: [],
    activity: [],
    aliases: [],
  };
}

function makeWindow(fromIso: string, toIso: string) {
  return {
    from: new Date(fromIso),
    to: new Date(toIso),
    label: "test-window",
  };
}

function makeCalendarEvent(start: string): CalendarEvent {
  return { id: "evt-synthetic-1", title: "Test Event", start };
}

// ──────────────────────────────────────────────────────────────────────────
// Finding 1 — window upper bound uses exclusive check (ts < toMs)
// ──────────────────────────────────────────────────────────────────────────

test("filterMemoriesByWindow: memory at exact window.to is excluded (exclusive upper bound)", () => {
  // Window: [2026-04-10T00:00:00Z, 2026-04-11T00:00:00Z)
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");

  // A memory timestamped exactly at midnight — must NOT appear in yesterday's window,
  // or it would double-count against today's window.
  const atMidnight = makeMemory("2026-04-11T00:00:00.000Z");
  const insideWindow = makeMemory("2026-04-10T12:00:00.000Z");

  const result = filterMemoriesByWindow([atMidnight, insideWindow], window);
  assert.equal(result.length, 1, "only the memory inside the window should be included");
  assert.equal(result[0], insideWindow);
});

test("filterMemoriesByWindow: memory at window.from (inclusive) is included", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const atFrom = makeMemory("2026-04-10T00:00:00.000Z");
  const result = filterMemoriesByWindow([atFrom], window);
  assert.equal(result.length, 1);
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 2 — runBriefingTool removed (verify no public export)
// ──────────────────────────────────────────────────────────────────────────

test("runBriefingTool is not exported from briefing module", async () => {
  const mod = await import("./briefing.js");
  assert.equal(
    (mod as Record<string, unknown>)["runBriefingTool"],
    undefined,
    "runBriefingTool should not be exported",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 4 — buildRecentEntities respects upper bound (window.to exclusive)
// ──────────────────────────────────────────────────────────────────────────

test("buildRecentEntities: entity updated after window.to is excluded", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");

  // Entity updated today (after window end) — should be excluded from yesterday's briefing.
  const futureEntity = makeEntity("2026-04-11T08:00:00.000Z");
  const inWindowEntity = makeEntity("2026-04-10T15:00:00.000Z");

  const result = buildRecentEntities([futureEntity, inWindowEntity], window, null);
  assert.equal(result.length, 1, "entity updated after window.to should be excluded");
  assert.equal(result[0]!.name, "SyntheticEntity");
  assert.equal(result[0]!.updatedAt, "2026-04-10T15:00:00.000Z");
});

test("buildRecentEntities: entity updated exactly at window.to is excluded (exclusive)", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const atTo = makeEntity("2026-04-11T00:00:00.000Z");
  const result = buildRecentEntities([atTo], window, null);
  assert.equal(result.length, 0, "entity at exact window.to must be excluded");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 5 — eventFallsOnDate uses UTC date, not raw slice
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: ISO timestamp with negative UTC offset is normalised to UTC date", () => {
  // 2026-04-10T23:30:00-02:00 is 2026-04-11T01:30:00Z — should match 2026-04-11, not 2026-04-10
  const event = makeCalendarEvent("2026-04-10T23:30:00-02:00");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "UTC date should be 2026-04-11");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false, "local date slice would give wrong result");
});

test("eventFallsOnDate: plain UTC ISO timestamp matches target date", () => {
  const event = makeCalendarEvent("2026-04-11T01:30:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false);
});

// ──────────────────────────────────────────────────────────────────────────
// Regression — Bug 3 (#396): invalid event.start must not throw RangeError
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: invalid start string returns false and does not throw", () => {
  const event = makeCalendarEvent("not-a-date");
  assert.doesNotThrow(() => {
    const result = eventFallsOnDate(event, "2026-04-11");
    assert.equal(result, false, "invalid start should be treated as non-matching");
  });
});

test("eventFallsOnDate: empty start string returns false and does not throw", () => {
  const event = makeCalendarEvent("");
  assert.doesNotThrow(() => {
    const result = eventFallsOnDate(event, "2026-04-11");
    assert.equal(result, false);
  });
});
