import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRecallExplainFormat,
  renderRecallExplain,
  toRecallExplainJson,
  toRecallExplainText,
} from "./recall-explain-renderer.js";
import type { LastRecallSnapshot } from "./recall-state.js";
import type { RecallTierExplain } from "./types.js";

function makeSnapshot(overrides: Partial<LastRecallSnapshot> = {}): LastRecallSnapshot {
  return {
    sessionKey: "session-a",
    recordedAt: "2026-04-19T17:30:00.000Z",
    queryHash: "a".repeat(64),
    queryLen: 42,
    memoryIds: ["mem-1", "mem-2"],
    namespace: "default",
    ...overrides,
  };
}

function makeTierExplain(overrides: Partial<RecallTierExplain> = {}): RecallTierExplain {
  return {
    tier: "direct-answer",
    tierReason: "trusted decisions, unambiguous, token-overlap 0.86",
    filteredBy: ["below-token-overlap-floor"],
    candidatesConsidered: 4,
    latencyMs: 12,
    sourceAnchors: [{ path: "/memory/pm.md", lineRange: [10, 14] }],
    ...overrides,
  };
}

// ── JSON renderer ───────────────────────────────────────────────────────────

test("toRecallExplainJson with null snapshot reports absence", () => {
  const payload = toRecallExplainJson(null);
  assert.equal(payload.snapshotFound, false);
  assert.equal(payload.hasExplain, false);
  assert.equal(payload.sessionKey, null);
  assert.equal(payload.tierExplain, null);
  assert.deepEqual(payload.memoryIds, []);
});

test("toRecallExplainJson reports missing tierExplain when snapshot exists without it", () => {
  const payload = toRecallExplainJson(makeSnapshot({ tierExplain: undefined }));
  assert.equal(payload.snapshotFound, true);
  assert.equal(payload.hasExplain, false);
  assert.equal(payload.tierExplain, null);
});

// Regression for cursor Bugbot finding on PR #537: LastRecallStore.load() does
// an unvalidated JSON.parse with a type assertion, so tierExplain can be null
// at runtime even though the TS type says undefined-or-present. hasExplain and
// the tierExplain field must stay in sync: both null → hasExplain=false.
test("toRecallExplainJson treats a null tierExplain the same as missing (hasExplain=false)", () => {
  const snapshot = makeSnapshot({
    // Force null past the type system to simulate a value that survived an
    // unvalidated JSON.parse.
    tierExplain: null as unknown as RecallTierExplain | undefined,
  });
  const payload = toRecallExplainJson(snapshot);
  assert.equal(payload.snapshotFound, true);
  assert.equal(payload.hasExplain, false);
  assert.equal(payload.tierExplain, null);
});

// Regression for codex-connector findings on PR #537: LastRecallStore.load()
// is unvalidated, so malformed runtime values must never crash the renderer
// or produce an internally inconsistent payload (hasExplain true while
// tierExplain null).
test("toRecallExplainJson treats falsy-but-defined tierExplain as absent (hasExplain false)", () => {
  for (const bad of ["", 0, false]) {
    const snapshot = makeSnapshot({
      tierExplain: bad as unknown as RecallTierExplain | undefined,
    });
    const payload = toRecallExplainJson(snapshot);
    assert.equal(payload.snapshotFound, true, `input=${JSON.stringify(bad)}`);
    assert.equal(payload.hasExplain, false, `input=${JSON.stringify(bad)}`);
    assert.equal(payload.tierExplain, null, `input=${JSON.stringify(bad)}`);
  }
});

test("toRecallExplainJson defaults malformed array fields instead of throwing", () => {
  const malformed = {
    tier: "direct-answer",
    tierReason: "stale-snapshot",
    // Bad shape: should be string[]
    filteredBy: null as unknown as string[],
    candidatesConsidered: 3,
    latencyMs: 5,
  } as unknown as RecallTierExplain;
  const payload = toRecallExplainJson(makeSnapshot({ tierExplain: malformed }));
  assert.equal(payload.hasExplain, true);
  assert.ok(payload.tierExplain);
  // Normalized to empty array, not a crash
  assert.deepEqual(payload.tierExplain.filteredBy, []);
});

test("toRecallExplainJson drops malformed sourceAnchors entries and lineRange", () => {
  const malformed = {
    tier: "direct-answer",
    tierReason: "",
    filteredBy: [],
    candidatesConsidered: 0,
    latencyMs: 0,
    sourceAnchors: [
      { path: "/ok.md", lineRange: [1, 2] },
      { path: "/bad-range.md", lineRange: ["nope", 2] },
      { noPath: true },
      "not-an-object",
    ],
  } as unknown as RecallTierExplain;
  const payload = toRecallExplainJson(makeSnapshot({ tierExplain: malformed }));
  assert.ok(payload.tierExplain?.sourceAnchors);
  assert.equal(payload.tierExplain.sourceAnchors.length, 2);
  assert.deepEqual(payload.tierExplain.sourceAnchors[0], {
    path: "/ok.md",
    lineRange: [1, 2],
  });
  // Bad range dropped, path preserved
  assert.deepEqual(payload.tierExplain.sourceAnchors[1], {
    path: "/bad-range.md",
  });
});

test("toRecallExplainJson coerces an unknown tier string to a safe fallback instead of crashing", () => {
  const malformed = {
    tier: "telepathic-hybrid",
    tierReason: "",
    filteredBy: [],
    candidatesConsidered: 0,
    latencyMs: 0,
  } as unknown as RecallTierExplain;
  const payload = toRecallExplainJson(makeSnapshot({ tierExplain: malformed }));
  assert.ok(payload.tierExplain);
  assert.equal(payload.tierExplain.tier, "hybrid");
});

// Regression for codex-connector P2 on PR #537: top-level snapshot fields
// (sessionKey, recordedAt, namespace, source) come from an unvalidated
// JSON.parse and can be objects/numbers at runtime. The advertised
// `string | null` schema must hold; malformed values coerce to null.
test("toRecallExplainJson sanitizes non-string top-level fields to null", () => {
  const malformed = {
    sessionKey: 123,
    recordedAt: { nested: true },
    namespace: 7,
    source: [],
    memoryIds: ["ok", 42, null, "also-ok"],
    sourcesUsed: [1, "qmd", false, "rerank"],
    latencyMs: "not-a-number",
  } as unknown as LastRecallSnapshot;
  const payload = toRecallExplainJson(malformed);
  assert.equal(payload.snapshotFound, true);
  assert.equal(payload.sessionKey, null);
  assert.equal(payload.recordedAt, null);
  assert.equal(payload.namespace, null);
  assert.equal(payload.source, null);
  assert.equal(payload.latencyMs, null);
  assert.deepEqual(payload.memoryIds, ["ok", "also-ok"]);
  assert.deepEqual(payload.sourcesUsed, ["qmd", "rerank"]);
});

test("toRecallExplainText prints (unknown) for malformed sessionKey / recordedAt instead of [object Object]", () => {
  const malformed = {
    sessionKey: { weird: true },
    recordedAt: 42,
    memoryIds: [],
  } as unknown as LastRecallSnapshot;
  const out = toRecallExplainText(malformed);
  assert.ok(out.includes("session: (unknown)"));
  assert.ok(out.includes("recorded: (unknown)"));
  assert.ok(!out.includes("[object Object]"));
});

test("toRecallExplainText renders a malformed tierExplain with empty filtered-by instead of throwing", () => {
  const malformed = {
    tier: "direct-answer",
    tierReason: "stale",
    filteredBy: null as unknown as string[],
    candidatesConsidered: 1,
    latencyMs: 2,
  } as unknown as RecallTierExplain;
  const out = toRecallExplainText(makeSnapshot({ tierExplain: malformed }));
  assert.ok(out.includes("tier: direct-answer"));
  assert.ok(out.includes("filtered-by: (none)"));
});

test("toRecallExplainJson serializes tierExplain with all fields", () => {
  const tierExplain = makeTierExplain();
  const payload = toRecallExplainJson(makeSnapshot({ tierExplain }));
  assert.equal(payload.hasExplain, true);
  assert.deepEqual(payload.tierExplain, tierExplain);
});

test("toRecallExplainJson deep-copies tierExplain so caller mutation does not tear payload", () => {
  const tierExplain = makeTierExplain();
  const payload = toRecallExplainJson(makeSnapshot({ tierExplain }));
  // Mutate source
  tierExplain.filteredBy.push("not-trusted-zone");
  if (tierExplain.sourceAnchors?.[0]?.lineRange) {
    tierExplain.sourceAnchors[0].lineRange[0] = 999;
  }
  assert.deepEqual(payload.tierExplain?.filteredBy, ["below-token-overlap-floor"]);
  assert.deepEqual(payload.tierExplain?.sourceAnchors?.[0]?.lineRange, [10, 14]);
});

// ── Text renderer ───────────────────────────────────────────────────────────

test("toRecallExplainText(null) explains that no snapshot exists", () => {
  const out = toRecallExplainText(null);
  assert.ok(out.includes("No recall snapshot recorded yet."));
});

test("toRecallExplainText without tierExplain surfaces the snapshot metadata and a not-populated notice", () => {
  const out = toRecallExplainText(
    makeSnapshot({
      tierExplain: undefined,
      source: "qmd-hybrid",
      sourcesUsed: ["qmd", "rerank"],
      latencyMs: 231,
    }),
  );
  assert.ok(out.includes("session: session-a"));
  assert.ok(out.includes("source: qmd-hybrid"));
  assert.ok(out.includes("sources-used: qmd, rerank"));
  assert.ok(out.includes("latency-ms: 231"));
  assert.ok(out.includes("memories: mem-1, mem-2"));
  assert.ok(out.includes("(not populated"));
});

test("toRecallExplainText with tierExplain renders tier, reason, candidates, latency, filters, and anchors", () => {
  const out = toRecallExplainText(makeSnapshot({ tierExplain: makeTierExplain() }));
  assert.ok(out.includes("tier: direct-answer"));
  assert.ok(out.includes("reason: trusted decisions, unambiguous, token-overlap 0.86"));
  assert.ok(out.includes("candidates-considered: 4"));
  assert.ok(out.includes("filtered-by: below-token-overlap-floor"));
  assert.ok(out.includes("/memory/pm.md:10-14"));
});

test("toRecallExplainText with empty filteredBy prints (none)", () => {
  const out = toRecallExplainText(
    makeSnapshot({ tierExplain: makeTierExplain({ filteredBy: [] }) }),
  );
  assert.ok(out.includes("filtered-by: (none)"));
});

test("toRecallExplainText with anchor lacking lineRange omits the range suffix", () => {
  const out = toRecallExplainText(
    makeSnapshot({
      tierExplain: makeTierExplain({
        sourceAnchors: [{ path: "/memory/pm.md" }],
      }),
    }),
  );
  assert.ok(out.includes("/memory/pm.md"));
  assert.ok(!out.includes("/memory/pm.md:"));
});

// ── Dispatcher ──────────────────────────────────────────────────────────────

test("renderRecallExplain dispatches to text by default", () => {
  const out = renderRecallExplain(makeSnapshot({ tierExplain: makeTierExplain() }), "text");
  assert.ok(out.startsWith("=== Recall Explain ==="));
});

test("renderRecallExplain produces valid JSON when format=json", () => {
  const out = renderRecallExplain(makeSnapshot({ tierExplain: makeTierExplain() }), "json");
  const parsed = JSON.parse(out);
  assert.equal(parsed.hasExplain, true);
  assert.equal(parsed.tierExplain.tier, "direct-answer");
});

// ── Format flag parsing (rule 51) ───────────────────────────────────────────

test("parseRecallExplainFormat accepts undefined and defaults to text", () => {
  assert.equal(parseRecallExplainFormat(undefined), "text");
  assert.equal(parseRecallExplainFormat(null), "text");
});

test("parseRecallExplainFormat accepts text and json (case-insensitive, trimmed)", () => {
  assert.equal(parseRecallExplainFormat("text"), "text");
  assert.equal(parseRecallExplainFormat("TEXT"), "text");
  assert.equal(parseRecallExplainFormat("  json  "), "json");
});

test("parseRecallExplainFormat rejects unknown values (rule 51)", () => {
  assert.throws(() => parseRecallExplainFormat("yaml"), /--format expects/);
  assert.throws(() => parseRecallExplainFormat(""), /--format expects/);
  assert.throws(() => parseRecallExplainFormat(42), /--format expects/);
});
