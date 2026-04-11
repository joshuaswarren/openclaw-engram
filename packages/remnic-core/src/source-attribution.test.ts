import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";
import { ContentHashIndex, StorageManager } from "./storage.js";
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

test("hasCitationForTemplate: {agent}:{sessionId} template rejects embedded URL colons", () => {
  // Regression for Cursor High: the previous implementation anchored on the
  // first non-empty middle literal alone — for this template that's just ":",
  // which false-positives on any text containing a colon (URLs, paths, any
  // other prose). The stricter reconstruction requires identifier-shaped
  // tokens on both sides of the literal, bounded by clean delimiters, which
  // in particular rejects the `http://host:80` shape.
  const template = "{agent}:{sessionId}";
  assert.equal(
    hasCitationForTemplate("URL uses http://host:80", template),
    false,
    "a colon inside a URL must not be classified as a citation",
  );
  assert.equal(
    hasCitationForTemplate("plain statement without a colon", template),
    false,
  );
});

test("hasCitationForTemplate: {agent}:{sessionId} template accepts a real citation-shaped token", () => {
  // Positive case — a bracket-wrapped agent:sessionId token looks like an
  // inline citation and should be detected so attachCitation stays idempotent.
  const template = "{agent}:{sessionId}";
  assert.equal(
    hasCitationForTemplate("[backend-agent:abc123] some text", template),
    true,
  );
});

// ── Finding 1 dedup regression: same raw content, different timestamps ─────────

// ── Finding A regression: $ special patterns in replacement strings ───────────

test("formatCitation: agent value containing $& is not expanded by replace", () => {
  // $& is the JS replacement special pattern that inserts the matched substring.
  // With the replacer-function form it must be treated as a literal string.
  const out = formatCitation(
    { agent: "agent-with-$&-literal", session: "sess:abc", ts: "2026-04-11T00:00:00Z" },
  );
  assert.ok(
    out.includes("agent-with-$&-literal"),
    `expected literal $& in output, got: ${out}`,
  );
  // Verify the placeholder was not expanded to the matched regex text either.
  assert.ok(!out.includes("{agent}"), "placeholder must be replaced");
});

test("formatCitation: session value containing $` (backtick) is not corrupted", () => {
  // $` inserts the string before the match. Must be literal here.
  const session = "sess:$`backtick";
  const out = formatCitation(
    { agent: "planner", session, ts: "2026-04-11T00:00:00Z" },
  );
  // The full session key doesn't appear in the default template (sessionId is used),
  // so test via a custom template that includes {session}.
  const tmpl = "[S: agent={agent}, session={session}, ts={ts}]";
  const out2 = formatCitation({ agent: "planner", session, ts: "2026-04-11T00:00:00Z" }, tmpl);
  assert.ok(
    out2.includes("sess:$`backtick"),
    `expected literal session with $\` in output, got: ${out2}`,
  );
});

test("formatCitation: agent value $1$2 stays literal (not resolved to empty groups)", () => {
  // $1 / $2 are capturing-group back-references in replace(). They must not be
  // resolved when the replacer-function form is used (the regex has no groups anyway,
  // but with a string replacement they still produce empty strings on some engines).
  const out = formatCitation(
    { agent: "$1$2", session: "sess:main", ts: "2026-04-11T00:00:00Z" },
  );
  assert.ok(
    out.includes("$1$2"),
    `expected literal $1$2 in output, got: ${out}`,
  );
});

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

// ── Finding B regression: shared-store dedup indexes raw content hash ─────────

test("ContentHashIndex.add indexes raw content; has() returns true for the same raw string", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-hash-idx-"));
  try {
    const idx = new ContentHashIndex(dir);
    await idx.load();
    const rawContent = "The database uses PostgreSQL for persistent storage.";
    idx.add(rawContent);
    assert.ok(idx.has(rawContent), "has() must return true for a string just added");
    // Simulate what would happen if we indexed the cited variant instead
    const citedContent = `${rawContent} [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]`;
    assert.ok(!idx.has(citedContent), "has() must return false for the cited variant when only raw was added");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager.writeMemory with contentHashSource registers raw-content hash (Finding B)", async () => {
  // This test verifies that writing with contentHashSource=rawContent persists the
  // RAW content hash to the on-disk fact-hashes.txt index. A new StorageManager
  // instance (simulating a subsequent extraction session) should find the raw fact
  // via hasFactContentHash(rawContent) because the persisted hash index carries the
  // raw hash — not the cited hash. Without the fix, only the cited hash would be
  // persisted, and cross-session dedup of the same raw fact would fail.
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-shared-dedup-"));
  try {
    const rawContent = "The service caches reads with Redis for low-latency access.";
    const citedContent = `${rawContent} [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]`;

    // Session 1: write the cited variant, register the RAW content hash for dedup.
    {
      const storage1 = new StorageManager(dir);
      await storage1.writeMemory("fact", citedContent, {
        source: "extraction",
        contentHashSource: rawContent,
      });
      // Same-session: raw content hash must be present in the in-memory index.
      const foundByRaw = await storage1.hasFactContentHash(rawContent);
      assert.ok(foundByRaw, "hasFactContentHash(rawContent) must be true in the same session");
    }

    // Session 2: new StorageManager instance simulating a subsequent extraction run.
    // The fact-hashes.txt on disk should contain the raw content hash so that
    // hasFactContentHash(rawContent) returns true without seeing the raw fact body.
    {
      const storage2 = new StorageManager(dir);
      // A different timestamp would produce a different citedContent, so the
      // cross-session dedup must rely on the persisted rawContent hash.
      const foundByRawCrossSession = await storage2.hasFactContentHash(rawContent);
      assert.ok(
        foundByRawCrossSession,
        "hasFactContentHash(rawContent) must be true in a new session via persisted hash index",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager.writeMemory contentHashSource prevents duplicate promotion cross-session (Finding B dedup regression)", async () => {
  // Simulates two extraction sessions with the same raw fact but different timestamps.
  // Session 1 promotes the fact (cited1). Session 2 (new StorageManager) checks
  // hasFactContentHash(rawFact) — it must return true so the promotion is skipped.
  //
  // Without the fix: session 1 would persist the citedContent hash. Session 2
  // backfills from disk (adds citedContent hash), but hasFactContentHash(rawFact)
  // would only match if rawFact hash was also persisted — which it was not.
  // With the fix: session 1 persists the rawFact hash via contentHashSource.
  // Session 2 loads it from fact-hashes.txt and hasFactContentHash(rawFact) is true.
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-dedup-regression-"));
  try {
    const rawFact = "PostgreSQL is used for durable persistent storage of user profiles.";
    const cited1 = `${rawFact} [Source: agent=planner, session=main, ts=2026-04-11T10:00:00Z]`;

    // Session 1: first promotion — write cited body but index raw hash.
    {
      const storage1 = new StorageManager(dir);
      await storage1.writeMemory("fact", cited1, {
        source: "extraction-shared-promotion",
        tags: ["shared-promotion"],
        contentHashSource: rawFact,
      });
      // Confirm same-session dedup gate works.
      assert.ok(
        await storage1.hasFactContentHash(rawFact),
        "Session 1: hasFactContentHash(rawFact) must be true after first promotion",
      );
    }

    // Session 2: new StorageManager (fresh process, no in-memory state).
    // The on-disk fact-hashes.txt must carry rawFact hash so dedup blocks re-promotion.
    {
      const storage2 = new StorageManager(dir);
      // Second extraction produces cited2 with a later timestamp. Before writing,
      // the caller checks hasFactContentHash(rawFact) — must return true to skip.
      const wouldDeduplicate = await storage2.hasFactContentHash(rawFact);
      assert.ok(
        wouldDeduplicate,
        "Session 2: hasFactContentHash(rawFact) must return true to prevent re-promotion",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
