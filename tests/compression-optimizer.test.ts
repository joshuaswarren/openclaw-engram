import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompressionGuidelinesMarkdown,
  computeCompressionGuidelineCandidate,
} from "../src/compression-optimizer.ts";
import type { MemoryActionEvent } from "../src/types.ts";

test("computeCompressionGuidelineCandidate is deterministic for fixed telemetry", () => {
  const events: MemoryActionEvent[] = [
    { timestamp: "2026-02-27T00:00:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
    { timestamp: "2026-02-27T00:01:00.000Z", action: "summarize_node", outcome: "applied", reason: "quality=good" },
    { timestamp: "2026-02-27T00:02:00.000Z", action: "summarize_node", outcome: "applied", reason: "resolved quickly" },
    { timestamp: "2026-02-27T00:03:00.000Z", action: "summarize_node", outcome: "skipped" },
    { timestamp: "2026-02-27T00:04:00.000Z", action: "summarize_node", outcome: "failed", reason: "recall_poor" },
    { timestamp: "2026-02-27T00:05:00.000Z", action: "store_note", outcome: "failed", reason: "quality=poor" },
  ];

  const left = computeCompressionGuidelineCandidate(events, {
    generatedAtIso: "2026-02-27T01:00:00.000Z",
    previousState: null,
  });
  const right = computeCompressionGuidelineCandidate(events, {
    generatedAtIso: "2026-02-27T01:00:00.000Z",
    previousState: null,
  });

  assert.deepEqual(left, right);
  assert.equal(left.guidelineVersion, 1);
  assert.equal(left.optimizerVersion, 1);
  assert.equal(left.eventCounts.total, 6);
  assert.equal(left.sourceWindow.from, "2026-02-27T00:00:00.000Z");
  assert.equal(left.sourceWindow.to, "2026-02-27T00:05:00.000Z");
});

test("computeCompressionGuidelineCandidate holds on sparse samples", () => {
  const events: MemoryActionEvent[] = [
    { timestamp: "2026-02-27T00:00:00.000Z", action: "discard", outcome: "failed", reason: "quality=poor" },
    { timestamp: "2026-02-27T00:01:00.000Z", action: "discard", outcome: "applied", reason: "quality=good" },
  ];

  const candidate = computeCompressionGuidelineCandidate(events, {
    generatedAtIso: "2026-02-27T01:00:00.000Z",
    previousState: {
      version: 3,
      updatedAt: "2026-02-26T00:00:00.000Z",
      sourceWindow: { from: "2026-02-26T00:00:00.000Z", to: "2026-02-26T23:59:59.000Z" },
      eventCounts: { total: 10, applied: 7, skipped: 2, failed: 1 },
      guidelineVersion: 8,
    },
  });

  assert.equal(candidate.optimizerVersion, 4);
  assert.equal(candidate.guidelineVersion, 9);
  assert.equal(candidate.ruleUpdates.length, 1);
  assert.equal(candidate.ruleUpdates[0]?.direction, "hold");
  assert.equal(candidate.ruleUpdates[0]?.delta, 0);
});

test("computeCompressionGuidelineCandidate emits bounded deltas", () => {
  const events: MemoryActionEvent[] = [];
  for (let i = 0; i < 12; i += 1) {
    events.push({
      timestamp: `2026-02-27T00:${String(i).padStart(2, "0")}:00.000Z`,
      action: "summarize_node",
      outcome: "applied",
      reason: "recall_good",
    });
  }
  for (let i = 12; i < 20; i += 1) {
    events.push({
      timestamp: `2026-02-27T00:${String(i).padStart(2, "0")}:00.000Z`,
      action: "store_note",
      outcome: "failed",
      reason: "recall_poor",
    });
  }

  const candidate = computeCompressionGuidelineCandidate(events, {
    generatedAtIso: "2026-02-27T01:00:00.000Z",
  });

  for (const rule of candidate.ruleUpdates) {
    assert.equal(Math.abs(rule.delta) <= 0.15, true);
  }

  const summarizeRule = candidate.ruleUpdates.find((item) => item.action === "summarize_node");
  const storeRule = candidate.ruleUpdates.find((item) => item.action === "store_note");
  assert.equal(summarizeRule?.direction, "increase");
  assert.equal(storeRule?.direction, "decrease");
});

test("computeCompressionGuidelineCandidate notes never contradict direction", () => {
  const events: MemoryActionEvent[] = [
    { timestamp: "2026-02-27T00:00:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
    { timestamp: "2026-02-27T00:01:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
    { timestamp: "2026-02-27T00:02:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
    { timestamp: "2026-02-27T00:03:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
    { timestamp: "2026-02-27T00:04:00.000Z", action: "summarize_node", outcome: "failed", reason: "recall_good" },
    { timestamp: "2026-02-27T00:05:00.000Z", action: "summarize_node", outcome: "failed", reason: "recall_good" },
    { timestamp: "2026-02-27T00:06:00.000Z", action: "summarize_node", outcome: "failed", reason: "recall_good" },
    { timestamp: "2026-02-27T00:07:00.000Z", action: "summarize_node", outcome: "failed", reason: "recall_good" },
    { timestamp: "2026-02-27T00:08:00.000Z", action: "summarize_node", outcome: "failed", reason: "recall_good" },
  ];

  const candidate = computeCompressionGuidelineCandidate(events, {
    generatedAtIso: "2026-02-27T01:00:00.000Z",
  });

  const summarizeRule = candidate.ruleUpdates.find((item) => item.action === "summarize_node");
  assert.equal(summarizeRule?.direction, "increase");
  assert.equal(
    (summarizeRule?.notes ?? []).some((note) => note.toLowerCase().includes("down-adjustment")),
    false,
  );
});

test("buildCompressionGuidelinesMarkdown includes optimizer metadata", () => {
  const events: MemoryActionEvent[] = [
    { timestamp: "2026-02-27T00:00:00.000Z", action: "summarize_node", outcome: "applied", reason: "recall_good" },
  ];

  const doc = buildCompressionGuidelinesMarkdown(events, "2026-02-27T01:00:00.000Z", {
    version: 2,
    updatedAt: "2026-02-26T00:00:00.000Z",
    sourceWindow: { from: "2026-02-26T00:00:00.000Z", to: "2026-02-26T23:59:59.000Z" },
    eventCounts: { total: 10, applied: 8, skipped: 1, failed: 1 },
    guidelineVersion: 4,
  });

  assert.match(doc, /Source events analyzed: 1/);
  assert.match(doc, /Guideline version: 5/);
  assert.match(doc, /Source window:/);
});
