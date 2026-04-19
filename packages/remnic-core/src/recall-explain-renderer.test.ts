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
