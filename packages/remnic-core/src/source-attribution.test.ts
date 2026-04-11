import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  DEFAULT_CITATION_FORMAT,
  attachCitation,
  deriveSessionId,
  formatCitation,
  hasCitation,
  hasCitationForTemplate,
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

// ── Finding 1 regression: custom citation template dedup detection ────────────

test("hasCitationForTemplate detects default [Source:...] marker regardless of template", () => {
  const text = "Fact body. [Source: agent=planner, session=main, ts=2026-04-10T00:00:00Z]";
  // Default template
  assert.equal(hasCitationForTemplate(text, DEFAULT_CITATION_FORMAT), true);
  // Custom template — should still detect the default marker as a fallback
  assert.equal(hasCitationForTemplate(text, "[src:{agent}/{sessionId}@{date}]"), true);
});

test("hasCitationForTemplate detects a custom-format citation", () => {
  const customTemplate = "[src:{agent}/{sessionId}@{date}]";
  const text = "Fact body. [src:planner/main@2026-04-10]";
  assert.equal(hasCitationForTemplate(text, customTemplate), true);
  // Should not falsely match plain text
  assert.equal(hasCitationForTemplate("Fact body.", customTemplate), false);
});

test("hasCitationForTemplate returns false for empty / non-string inputs", () => {
  assert.equal(hasCitationForTemplate("", DEFAULT_CITATION_FORMAT), false);
  assert.equal(hasCitationForTemplate("no citation here", DEFAULT_CITATION_FORMAT), false);
});

test("attachCitation with custom template is a no-op when text already carries that custom marker (Finding 1)", () => {
  const customTemplate = "[src:{agent}/{sessionId}@{date}]";
  const ctx = { agent: "planner", session: "agent:planner:main", ts: "2026-04-10T14:25:07Z" };
  // Pre-tag the fact with a custom citation
  const priorCitation = "[src:other/alpha@2026-01-01]";
  const text = `Existing fact. ${priorCitation}`;
  const result = attachCitation(text, ctx, customTemplate);
  // Must be unchanged — no second citation appended
  assert.equal(result, text);
  // Confirm only one citation marker is present
  const markerCount = (result.match(/\[src:/g) ?? []).length;
  assert.equal(markerCount, 1);
});

test("attachCitation with custom template tags untagged text exactly once (Finding 1 positive path)", () => {
  const customTemplate = "[src:{agent}/{sessionId}@{date}]";
  const ctx = { agent: "scout", session: "agent:scout:beta", ts: "2026-04-11T00:00:00Z" };
  const text = "The service uses Redis for caching.";
  const result = attachCitation(text, ctx, customTemplate);
  // Should end with one custom citation
  assert.ok(result.includes("[src:scout/beta@2026-04-11]"), `expected custom citation in: ${result}`);
  // Applying again must be idempotent
  const again = attachCitation(result, ctx, customTemplate);
  assert.equal(again, result);
});

// ── Finding 2 regression: placeholder-bounded template matcher ─────────────────

test("hasCitationForTemplate with placeholder-bounded template does not match arbitrary text", () => {
  // Template starts AND ends with a placeholder — prefix and suffix are both "".
  // The middle literal is ": " which must be the anchor.
  const template = "{source}: {content}";
  // Text that contains ": " should match (it contains the middle literal).
  assert.equal(hasCitationForTemplate("planner: The service uses Redis", template), true);
  // Random text without the middle literal must NOT match.
  assert.equal(hasCitationForTemplate("random text without separator", template), false);
  assert.equal(hasCitationForTemplate("no separator here at all", template), false);
});

test("hasCitationForTemplate with fully placeholder-only template returns false (null matcher fallback)", () => {
  // Template has no literal segments at all — templateMatcher returns null.
  // The null-matcher path falls back to text.includes(template) which will be
  // false for any real text (the template contains raw placeholder syntax).
  const template = "{source}{content}";
  assert.equal(hasCitationForTemplate("anything goes here", template), false);
  assert.equal(hasCitationForTemplate("{source}{content}", template), true);
});

test("hasCitationForTemplate preserves normal behaviour for well-formed templates (Finding 2 non-regression)", () => {
  // Well-formed template with non-empty prefix and suffix — existing behaviour.
  const template = "Source: {source} — Content: {content}";
  assert.equal(hasCitationForTemplate("Source: planner — Content: some fact", template), true);
  assert.equal(hasCitationForTemplate("random unrelated text", template), false);
});

test("hasCitationForTemplate: placeholder-bounded template does not falsely tag plain text (Finding 2 negative)", () => {
  const template = "{source}: {content}";
  // Plain text with no colon-space separator must return false.
  assert.equal(hasCitationForTemplate("just a plain statement", template), false);
});

// ── Finding 1 dedup regression: same raw content, different timestamps ─────────

test("attachCitation is idempotent across different timestamps for the same raw content (Finding 1 dedup)", () => {
  // Simulates the dedup scenario: the same raw fact content is presented twice
  // to applyInlineCitation with different "now" values (different timestamps).
  // The CITED content varies each call, but the RAW content is the same.
  // This test verifies that hasCitationForTemplate correctly sees already-cited
  // text as tagged regardless of the exact timestamp in the marker.
  const rawContent = "The database uses PostgreSQL for persistent storage.";
  const template = DEFAULT_CITATION_FORMAT;

  const ctx1 = { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T10:00:00Z" };
  const ctx2 = { agent: "planner", session: "agent:planner:main", ts: "2026-04-11T10:05:00Z" };

  const cited1 = attachCitation(rawContent, ctx1, template);
  // cited1 includes ts=2026-04-11T10:00:00Z
  assert.ok(cited1.includes("2026-04-11T10:00:00Z"), "first citation should include first timestamp");

  // A second attachCitation call on already-cited text (different ts) must be a no-op.
  const cited2 = attachCitation(cited1, ctx2, template);
  assert.equal(cited2, cited1, "second attachCitation must not append a second marker");

  // hasCitationForTemplate must return true for cited1 regardless of template/ts.
  assert.equal(hasCitationForTemplate(cited1, template), true);

  // The raw content itself should NOT be seen as already-cited.
  assert.equal(hasCitationForTemplate(rawContent, template), false);
});
