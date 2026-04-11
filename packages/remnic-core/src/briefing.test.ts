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
  parseIcsEvents,
  parseBriefingWindow,
  validateBriefingFormat,
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

// ──────────────────────────────────────────────────────────────────────────
// Finding 2 (#396): ICS floating-time events must not be shifted by server TZ
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: floating time 01:00 (early morning) matches its calendar day", () => {
  // "20260411T010000" → normalizeIcsDate → "2026-04-11T01:00:00" (no Z).
  // On a server at UTC-8 this would incorrectly become 2026-04-10 if
  // round-tripped through new Date().toISOString().
  const event = makeCalendarEvent("2026-04-11T01:00:00");
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "01:00 floating time must match its own calendar day",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-10"),
    false,
    "01:00 floating time must NOT match the previous calendar day",
  );
});

test("eventFallsOnDate: floating time 23:00 (late night) matches its calendar day", () => {
  const event = makeCalendarEvent("2026-04-11T23:00:00");
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "23:00 floating time must match its own calendar day",
  );
  assert.equal(
    eventFallsOnDate(event, "2026-04-12"),
    false,
    "23:00 floating time must NOT match the following calendar day",
  );
});

test("eventFallsOnDate: Z-suffixed UTC time compares against UTC date", () => {
  // 2026-04-11T01:30:00Z — UTC date is 2026-04-11
  const event = makeCalendarEvent("2026-04-11T01:30:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false);
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 4 (#396): superseded/archived memories must not appear in briefing
// ──────────────────────────────────────────────────────────────────────────

function makeMemoryWithStatus(
  updated: string,
  status?:
    | "active"
    | "superseded"
    | "archived"
    | "pending_review"
    | "rejected"
    | "quarantined",
): MemoryFile {
  return {
    path: "/synthetic/mem.md",
    frontmatter: {
      id: "test-mem-status",
      category: "commitment",
      created: updated,
      updated,
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: ["pending"],
      status,
    },
    content: "Follow up on this commitment.",
  };
}

test("filterMemoriesByWindow: superseded commitment within window is excluded", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const superseded = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "superseded");
  const active = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", "active");
  const noStatus = makeMemoryWithStatus("2026-04-10T12:00:00.000Z", undefined);

  const result = filterMemoriesByWindow([superseded, active, noStatus], window);
  assert.equal(result.length, 2, "superseded memory must be excluded");
  assert.ok(!result.some((m) => m.frontmatter.status === "superseded"), "no superseded in result");
});

test("filterMemoriesByWindow: archived memory within window is excluded", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const archived = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "archived");
  const result = filterMemoriesByWindow([archived], window);
  assert.equal(result.length, 0, "archived memory must be excluded from briefing");
});

test("filterMemoriesByWindow: rejected memory within window is excluded from briefing", () => {
  // Governance/disposition workflows mark unsafe or invalid memories as
  // `rejected`. filterMemoriesByWindow must NOT leak them into briefings or
  // downstream follow-up generation, since they represent content explicitly
  // flagged as not-actionable.
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const rejected = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "rejected");
  const active = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", "active");
  const result = filterMemoriesByWindow([rejected, active], window);
  assert.equal(result.length, 1, "rejected memory must be excluded from briefing");
  assert.equal(result[0]!.frontmatter.status, "active");
});

test("filterMemoriesByWindow: quarantined memory within window is excluded from briefing", () => {
  // Quarantined memories have been flagged as unsafe by governance review.
  // They must not surface in the briefing, even within the time window.
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const quarantined = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "quarantined");
  const active = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", "active");
  const result = filterMemoriesByWindow([quarantined, active], window);
  assert.equal(result.length, 1, "quarantined memory must be excluded from briefing");
  assert.equal(result[0]!.frontmatter.status, "active");
});

test("filterMemoriesByWindow: active and undefined-status memories within window are included", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const active = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "active");
  const noStatus = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", undefined);
  const result = filterMemoriesByWindow([active, noStatus], window);
  assert.equal(result.length, 2, "active and status-less memories must be included");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding A (#396): pending_review memories must be included in briefings
// ──────────────────────────────────────────────────────────────────────────

test("filterMemoriesByWindow: pending_review memory within window is included", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const pendingReview = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "pending_review");
  const result = filterMemoriesByWindow([pendingReview], window);
  assert.equal(result.length, 1, "pending_review memory must be included in briefing");
  assert.equal(result[0]!.frontmatter.status, "pending_review");
});

test("filterMemoriesByWindow: archived memory is excluded but pending_review is included together", () => {
  const window = makeWindow("2026-04-10T00:00:00.000Z", "2026-04-11T00:00:00.000Z");
  const archived = makeMemoryWithStatus("2026-04-10T09:00:00.000Z", "archived");
  const superseded = makeMemoryWithStatus("2026-04-10T10:00:00.000Z", "superseded");
  const pendingReview = makeMemoryWithStatus("2026-04-10T11:00:00.000Z", "pending_review");
  const active = makeMemoryWithStatus("2026-04-10T12:00:00.000Z", "active");

  const result = filterMemoriesByWindow([archived, superseded, pendingReview, active], window);
  assert.equal(result.length, 2, "only archived and superseded should be excluded");
  assert.ok(result.some((m) => m.frontmatter.status === "pending_review"), "pending_review must be present");
  assert.ok(result.some((m) => m.frontmatter.status === "active"), "active must be present");
  assert.ok(!result.some((m) => m.frontmatter.status === "archived"), "archived must not be present");
  assert.ok(!result.some((m) => m.frontmatter.status === "superseded"), "superseded must not be present");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 7 (#396): --format flag must reject invalid values
// ──────────────────────────────────────────────────────────────────────────

test("validateBriefingFormat: returns null for valid format values", () => {
  assert.equal(validateBriefingFormat("markdown"), null);
  assert.equal(validateBriefingFormat("json"), null);
});

test("validateBriefingFormat: rejects 'text' (not a supported output format)", () => {
  const err = validateBriefingFormat("text");
  assert.ok(typeof err === "string" && err.length > 0, "'text' is not a supported format and must be rejected");
  assert.match(err, /text/, "error message should include the rejected value");
});

test("validateBriefingFormat: returns null when value is undefined (flag not supplied)", () => {
  assert.equal(validateBriefingFormat(undefined), null, "absent flag must not produce an error");
});

test("validateBriefingFormat: returns error string for invalid values like 'jsno'", () => {
  const err = validateBriefingFormat("jsno");
  assert.ok(typeof err === "string" && err.length > 0, "typo should produce an error message");
  assert.match(err, /jsno/, "error should include the invalid value");
});

// ──────────────────────────────────────────────────────────────────────────
// Finding C (#396): compact timezone offsets (±HHMM) must be treated as
// offset-aware (not floating) so events land on the correct UTC date.
// ──────────────────────────────────────────────────────────────────────────

test("eventFallsOnDate: compact negative offset (-0200) is treated as offset-aware", () => {
  // 2026-04-10T23:30:00-0200 = 2026-04-11T01:30:00Z — must match 2026-04-11, not 2026-04-10
  const event = makeCalendarEvent("2026-04-10T23:30:00-0200");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "compact -0200 should land on 2026-04-11 UTC");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false, "must not match the local date slice");
});

test("eventFallsOnDate: compact positive offset (+0530) is treated as offset-aware", () => {
  // 2026-04-11T04:00:00+0530 = 2026-04-10T22:30:00Z — must match 2026-04-10, not 2026-04-11
  const event = makeCalendarEvent("2026-04-11T04:00:00+0530");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "compact +0530 should land on 2026-04-10 UTC");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), false, "must not match the local date slice");
});

test("eventFallsOnDate: compact +0000 is treated as offset-aware (same as Z)", () => {
  // 2026-04-11T12:00:00+0000 = 2026-04-11T12:00:00Z
  const event = makeCalendarEvent("2026-04-11T12:00:00+0000");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "compact +0000 must match 2026-04-11");
});

test("eventFallsOnDate: floating string without any offset suffix is still treated as floating", () => {
  // 2026-04-10T23:30:00 has no offset — floating, compares date portion directly
  const event = makeCalendarEvent("2026-04-10T23:30:00");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "floating time must match its calendar day");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), false, "floating time must not shift to next day");
});

test("validateBriefingFormat: rejects empty string as invalid", () => {
  const err = validateBriefingFormat("");
  assert.ok(typeof err === "string" && err.length > 0, "empty string is not a valid format");
});

test("validateBriefingFormat: rejects arbitrary strings", () => {
  for (const bad of ["xml", "html", "plain", "MARKDOWN"]) {
    const err = validateBriefingFormat(bad);
    assert.ok(typeof err === "string", `"${bad}" should be rejected`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Finding 1 (#396 new): parseBriefingWindow must reject overflow/huge values
// ──────────────────────────────────────────────────────────────────────────

test("parseBriefingWindow: rejects hugely large week value that would overflow Date", () => {
  // 99999999w far exceeds 100 years — must return null, not Invalid Date.
  const result = parseBriefingWindow("99999999w");
  assert.equal(result, null, "99999999w should be rejected as out-of-bounds");
});

test("parseBriefingWindow: rejects hugely large day value that would overflow Date", () => {
  const result = parseBriefingWindow("99999999d");
  assert.equal(result, null, "99999999d should be rejected as out-of-bounds");
});

test("parseBriefingWindow: rejects hugely large hour value that would overflow Date", () => {
  const result = parseBriefingWindow("99999999h");
  assert.equal(result, null, "99999999h should be rejected as out-of-bounds");
});

test("parseBriefingWindow: rejects a window exactly above the 100-year cap", () => {
  // 36501 days = ~100.003 years — just above the 100-year limit.
  const result = parseBriefingWindow("36501d");
  assert.equal(result, null, "36501d exceeds 100-year cap and must be rejected");
});

test("parseBriefingWindow: accepts a reasonable 10-year (3650d) window", () => {
  // 3650d ≈ 10 years — well within the 100-year cap.
  const result = parseBriefingWindow("3650d");
  assert.ok(result !== null, "3650d (≈10 years) should be accepted");
  assert.equal(result.label, "last 3650d");
  assert.ok(Number.isFinite(result.from.getTime()), "from must be a valid Date");
});

test("parseBriefingWindow: from date is always a valid finite Date for normal inputs", () => {
  for (const token of ["1h", "7d", "2w", "365d", "52w"]) {
    const result = parseBriefingWindow(token);
    assert.ok(result !== null, `"${token}" should parse successfully`);
    assert.ok(Number.isFinite(result.from.getTime()), `"${token}" from must be a valid Date`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// PR #396 Finding 1: eventFallsOnDate — overlapping / multi-day events
// ──────────────────────────────────────────────────────────────────────────

function makeCalendarEventWithEnd(start: string, end: string): CalendarEvent {
  return { id: "evt-synthetic-span", title: "Span Event", start, end };
}

test("eventFallsOnDate: midnight-crossing event appears on both dates (UTC)", () => {
  // Event 2026-04-10T23:30:00Z → 2026-04-11T01:00:00Z spans midnight UTC.
  // It should be visible on both 2026-04-10 and 2026-04-11.
  const event = makeCalendarEventWithEnd("2026-04-10T23:30:00Z", "2026-04-11T01:00:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "spans midnight — must appear on start date");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "spans midnight — must appear on end date");
  assert.equal(eventFallsOnDate(event, "2026-04-09"), false, "must not appear before start date");
  assert.equal(eventFallsOnDate(event, "2026-04-12"), false, "must not appear after end date");
});

test("eventFallsOnDate: multi-day event appears on every day it spans", () => {
  // Event from 2026-04-09T00:00:00Z to 2026-04-12T00:00:00Z spans 3 full days.
  const event = makeCalendarEventWithEnd("2026-04-09T00:00:00Z", "2026-04-12T00:00:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-09"), true, "must appear on day 1");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "must appear on day 2");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true, "must appear on day 3");
  // end is exactly midnight of 2026-04-12 — half-open [start, end) means it
  // does NOT count as active on 2026-04-12.
  assert.equal(eventFallsOnDate(event, "2026-04-12"), false, "event ending at midnight must not appear on that day");
  assert.equal(eventFallsOnDate(event, "2026-04-08"), false, "must not appear before start");
});

test("eventFallsOnDate: event ending exactly at day boundary (midnight) excluded from next day", () => {
  // An event ending at exactly 2026-04-11T00:00:00Z ends at the first instant
  // of 2026-04-11 — half-open semantics means it is NOT active on 2026-04-11.
  const event = makeCalendarEventWithEnd("2026-04-10T22:00:00Z", "2026-04-11T00:00:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true, "must appear on start date");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), false, "end-at-midnight must NOT appear on next day");
});

test("eventFallsOnDate: point event (no end) still works correctly after refactor", () => {
  const event = makeCalendarEvent("2026-04-11T10:00:00Z");
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false);
});

// PR #396 round 5 — PRRT_kwDORJXyws56UJ14: same-day floating spans were dropped
// because the original fix used pure `target < endDate` lexicographic compare
// on date prefixes. A DTSTART:20260411T143000 / DTEND:20260411T150000 event
// has startDate == endDate == "2026-04-11", so `target < endDate` was false
// and the event vanished from its own calendar day.
test("eventFallsOnDate: same-day floating span (no TZID) appears on its calendar day", () => {
  const event = makeCalendarEventWithEnd("2026-04-11T14:30:00", "2026-04-11T15:00:00");
  assert.equal(
    eventFallsOnDate(event, "2026-04-11"),
    true,
    "same-day floating span must match its own calendar day",
  );
  assert.equal(eventFallsOnDate(event, "2026-04-10"), false);
  assert.equal(eventFallsOnDate(event, "2026-04-12"), false);
});

test("eventFallsOnDate: floating span ending exactly at midnight excludes next day", () => {
  // Floating 2026-04-10T22:00:00 → 2026-04-11T00:00:00 — half-open semantics
  // means the end-day (2026-04-11) must NOT be included.
  const event = makeCalendarEventWithEnd("2026-04-10T22:00:00", "2026-04-11T00:00:00");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-11"), false);
});

test("eventFallsOnDate: floating span crossing midnight appears on both dates", () => {
  // Floating 2026-04-10T23:30:00 → 2026-04-11T01:00:00 crosses the day
  // boundary with a non-zero end time, so the end day is still active.
  const event = makeCalendarEventWithEnd("2026-04-10T23:30:00", "2026-04-11T01:00:00");
  assert.equal(eventFallsOnDate(event, "2026-04-10"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-11"), true);
  assert.equal(eventFallsOnDate(event, "2026-04-12"), false);
});

// ──────────────────────────────────────────────────────────────────────────
// PR #396 Finding 2: parseIcsEvents — RFC 5545 line unfolding
// ──────────────────────────────────────────────────────────────────────────

test("parseIcsEvents: folded SUMMARY line (space continuation) is unfolded correctly", () => {
  // RFC 5545 §3.1 line folding: CRLF followed by a single whitespace character
  // is a fold — the CRLF + that one whitespace byte are removed entirely when
  // unfolding.  Real ICS encoders place the fold at a convenient byte boundary;
  // any space that is part of the content appears at the END of the first
  // physical line (before the CRLF), NOT at the start of the continuation.
  // The leading space on the continuation line is purely the fold indicator
  // and is discarded.  The fixture below reflects that: the first physical line
  // ends with " physical" (space is part of the value) and the continuation
  // starts with " lines" (leading space is the fold marker, discarded).
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:test-fold-1@synthetic",
    "DTSTART:20260411T100000Z",
    "DTEND:20260411T110000Z",
    // Content space is at end of first line; continuation space is fold marker.
    "SUMMARY:This is a long summary folded across two physical ",
    " lines by the ICS encoder",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = parseIcsEvents(ics);
  assert.equal(events.length, 1, "should parse exactly one event");
  assert.equal(
    events[0]!.title,
    "This is a long summary folded across two physical lines by the ICS encoder",
    "folded SUMMARY must be unfolded into a single string (fold marker space discarded)",
  );
});

test("parseIcsEvents: folded SUMMARY line (tab continuation) is unfolded correctly", () => {
  // RFC 5545 allows either a space or tab as the fold whitespace character.
  // The leading tab on the continuation line is the fold marker and is discarded.
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:test-fold-tab@synthetic",
    "DTSTART:20260412T090000Z",
    "DTEND:20260412T100000Z",
    "SUMMARY:Tab-folded summary part one ",
    "\tcontinued after a tab",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = parseIcsEvents(ics);
  assert.equal(events.length, 1);
  assert.equal(
    events[0]!.title,
    "Tab-folded summary part one continued after a tab",
    "tab-folded SUMMARY must be joined without the fold-marker tab",
  );
});

test("parseIcsEvents: unfolded ICS (no folds) is parsed unchanged", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:test-no-fold@synthetic",
    "DTSTART:20260413T080000Z",
    "DTEND:20260413T090000Z",
    "SUMMARY:Simple one-line title",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const events = parseIcsEvents(ics);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.title, "Simple one-line title");
});
