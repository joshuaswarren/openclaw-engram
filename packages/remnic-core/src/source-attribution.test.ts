import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  DEFAULT_CITATION_FORMAT,
  attachCitation,
  deriveSessionId,
  formatCitation,
  hasCitation,
  parseAllCitations,
  parseCitation,
  stripCitation,
} from "./source-attribution.js";

test("formatCitation emits the default template with provided fields", () => {
  const out = formatCitation({
    agent: "planner",
    session: "agent:planner:main",
    ts: "2026-04-10T14:25:07Z",
  });
  assert.equal(
    out,
    "[Source: agent=planner, session=main, ts=2026-04-10T14:25:07Z]",
  );
});

test("formatCitation falls back to 'unknown' for missing fields", () => {
  const out = formatCitation({});
  assert.equal(out, "[Source: agent=unknown, session=unknown, ts=unknown]");
});

test("formatCitation supports custom templates with all placeholders", () => {
  const template = "[src:{agent}/{session}@{date}]";
  const out = formatCitation(
    {
      agent: "scout",
      session: "agent:scout:alpha",
      ts: "2026-04-10T14:25:07Z",
    },
    template,
  );
  // session placeholder uses the full colon-delimited session key.
  assert.equal(out, "[src:scout/agent:scout:alpha@2026-04-10]");
});

test("deriveSessionId returns the trailing component of a colon-delimited key", () => {
  assert.equal(deriveSessionId("agent:planner:main"), "main");
  assert.equal(deriveSessionId("single"), "single");
  assert.equal(deriveSessionId(undefined), undefined);
  assert.equal(deriveSessionId(""), undefined);
});

test("attachCitation appends a marker when none is present", () => {
  const text = "The foo service uses Redis for rate limiting.";
  const out = attachCitation(text, {
    agent: "planner",
    session: "agent:planner:main",
    ts: "2026-04-10T14:25:07Z",
  });
  assert.ok(out.startsWith(text));
  assert.ok(
    out.includes("[Source: agent=planner, session=main, ts=2026-04-10T14:25:07Z]"),
  );
});

test("attachCitation is a no-op when the text already carries a citation", () => {
  const text =
    "Already tagged. [Source: agent=foo, session=bar, ts=2026-01-01T00:00:00Z]";
  const out = attachCitation(text, {
    agent: "other",
    session: "other:session",
    ts: "2026-04-10T14:25:07Z",
  });
  assert.equal(out, text);
});

test("attachCitation preserves trailing newlines for markdown rendering", () => {
  const text = "Fact body.\n";
  const out = attachCitation(text, {
    agent: "a",
    session: "s:1",
    ts: "2026-04-10T00:00:00Z",
  });
  assert.ok(out.endsWith("\n"));
  assert.ok(out.includes("[Source: agent=a"));
});

test("parseCitation extracts agent, session, and timestamp", () => {
  const text =
    "Body of the fact. [Source: agent=planner, session=abc123, ts=2026-04-10T14:25:07Z]";
  const parsed = parseCitation(text);
  assert.ok(parsed);
  assert.equal(parsed!.agent, "planner");
  assert.equal(parsed!.session, "abc123");
  assert.equal(parsed!.ts, "2026-04-10T14:25:07Z");
  assert.ok(parsed!.raw.startsWith("[Source:"));
});

test("parseCitation returns null when no citation is present", () => {
  assert.equal(parseCitation("no citation here"), null);
  assert.equal(parseCitation(""), null);
});

test("parseCitation tolerates malformed fields without throwing", () => {
  const parsed = parseCitation("[Source: agent=bob, broken-field, ts=]");
  assert.ok(parsed);
  assert.equal(parsed!.agent, "bob");
  assert.equal(parsed!.session, undefined);
  assert.equal(parsed!.ts, undefined);
});

test("parseAllCitations returns every citation in order", () => {
  const text =
    "First [Source: agent=a, session=s1, ts=2026-04-10T00:00:00Z] and " +
    "second [Source: agent=b, session=s2, ts=2026-04-11T00:00:00Z]";
  const all = parseAllCitations(text);
  assert.equal(all.length, 2);
  assert.equal(all[0]!.agent, "a");
  assert.equal(all[1]!.agent, "b");
});

test("hasCitation returns true only when a marker is present", () => {
  assert.equal(hasCitation("nothing tagged"), false);
  assert.equal(hasCitation(""), false);
  assert.equal(
    hasCitation("Tagged. [Source: agent=x, session=y, ts=z]"),
    true,
  );
});

test("stripCitation removes inline markers cleanly", () => {
  const text =
    "Body of the fact. [Source: agent=planner, session=abc123, ts=2026-04-10T14:25:07Z]";
  assert.equal(stripCitation(text), "Body of the fact.");
});

test("attach → strip is idempotent for well-formed fact text", () => {
  const original = "The foo service uses Redis for rate limiting.";
  const attached = attachCitation(original, {
    agent: "planner",
    session: "agent:planner:main",
    ts: "2026-04-10T14:25:07Z",
  });
  assert.ok(hasCitation(attached));
  assert.equal(stripCitation(attached), original);
});

test("stripCitation leaves plain text untouched", () => {
  assert.equal(stripCitation("no markers"), "no markers");
  assert.equal(stripCitation(""), "");
});

test("DEFAULT_CITATION_FORMAT matches issue #369 proposal", () => {
  assert.equal(
    DEFAULT_CITATION_FORMAT,
    "[Source: agent={agent}, session={sessionId}, ts={ts}]",
  );
});

test("parseConfig disables inline source attribution by default", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.inlineSourceAttributionEnabled, false);
  assert.equal(
    cfg.inlineSourceAttributionFormat,
    "[Source: agent={agent}, session={sessionId}, ts={ts}]",
  );
});

test("parseConfig honors explicit inline source attribution overrides", () => {
  const cfg = parseConfig({
    inlineSourceAttributionEnabled: true,
    inlineSourceAttributionFormat: "[src:{agent}/{sessionId}@{date}]",
  });
  assert.equal(cfg.inlineSourceAttributionEnabled, true);
  assert.equal(
    cfg.inlineSourceAttributionFormat,
    "[src:{agent}/{sessionId}@{date}]",
  );
});

test("parseConfig falls back to default format when override is empty", () => {
  const cfg = parseConfig({
    inlineSourceAttributionEnabled: true,
    inlineSourceAttributionFormat: "   ",
  });
  assert.equal(
    cfg.inlineSourceAttributionFormat,
    "[Source: agent={agent}, session={sessionId}, ts={ts}]",
  );
});
