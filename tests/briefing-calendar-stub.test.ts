import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { FileCalendarSource } from "../src/briefing.js";

async function makeTempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-briefing-cal-"));
  const filePath = path.join(dir, name);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

test("FileCalendarSource reads a JSON array of events and filters by date", async () => {
  const filePath = await makeTempFile(
    "events.json",
    JSON.stringify([
      {
        id: "evt-1",
        title: "Design review",
        start: "2026-04-11T14:00:00.000Z",
        end: "2026-04-11T15:00:00.000Z",
        location: "Room 3",
      },
      {
        id: "evt-2",
        title: "Old sync",
        start: "2026-04-10T10:00:00.000Z",
      },
    ]),
  );
  try {
    const source = new FileCalendarSource(filePath);
    const today = await source.eventsForDate("2026-04-11");
    assert.equal(today.length, 1);
    assert.equal(today[0].id, "evt-1");
    assert.equal(today[0].title, "Design review");
    assert.equal(today[0].location, "Room 3");

    const yesterday = await source.eventsForDate("2026-04-10");
    assert.equal(yesterday.length, 1);
    assert.equal(yesterday[0].id, "evt-2");

    const empty = await source.eventsForDate("2026-04-12");
    assert.deepEqual(empty, []);
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("FileCalendarSource accepts the { events: [...] } wrapper form", async () => {
  const filePath = await makeTempFile(
    "events-wrapped.json",
    JSON.stringify({
      events: [
        {
          id: "evt-w",
          title: "Wrapped event",
          start: "2026-04-11T09:00:00.000Z",
        },
      ],
    }),
  );
  try {
    const source = new FileCalendarSource(filePath);
    const today = await source.eventsForDate("2026-04-11");
    assert.equal(today.length, 1);
    assert.equal(today[0].id, "evt-w");
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("FileCalendarSource parses a minimal ICS file", async () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:synthetic-ics-1",
    "SUMMARY:Team standup",
    "DTSTART:20260411T143000Z",
    "DTEND:20260411T150000Z",
    "LOCATION:Virtual",
    "DESCRIPTION:Synthetic fixture",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:synthetic-ics-2",
    "SUMMARY:Yesterday sync",
    "DTSTART:20260410T100000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const filePath = await makeTempFile("synthetic.ics", ics);
  try {
    const source = new FileCalendarSource(filePath);
    const today = await source.eventsForDate("2026-04-11");
    assert.equal(today.length, 1);
    assert.equal(today[0].title, "Team standup");
    assert.equal(today[0].start, "2026-04-11T14:30:00Z");
    assert.equal(today[0].end, "2026-04-11T15:00:00Z");
    assert.equal(today[0].location, "Virtual");
    assert.equal(today[0].id, "synthetic-ics-1");
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("FileCalendarSource returns [] when the file is unreadable", async () => {
  const source = new FileCalendarSource(
    path.join(os.tmpdir(), "does-not-exist-" + Math.random().toString(36).slice(2)),
  );
  const events = await source.eventsForDate("2026-04-11");
  assert.deepEqual(events, []);
});

test("FileCalendarSource returns [] when JSON is malformed", async () => {
  const filePath = await makeTempFile("broken.json", "{not valid json");
  try {
    const source = new FileCalendarSource(filePath);
    const events = await source.eventsForDate("2026-04-11");
    assert.deepEqual(events, []);
  } finally {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});
