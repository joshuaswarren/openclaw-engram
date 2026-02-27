import test from "node:test";
import assert from "node:assert/strict";
import { buildCompressionGuidelinesMarkdown, Orchestrator } from "../src/orchestrator.ts";
import type { CompressionGuidelineOptimizerState, MemoryActionEvent } from "../src/types.ts";

test("buildCompressionGuidelinesMarkdown emits conservative guidance with no telemetry", () => {
  const doc = buildCompressionGuidelinesMarkdown([], "2026-02-23T00:00:00.000Z");
  assert.match(doc, /Source events analyzed: 0/);
  assert.match(doc, /No telemetry events available yet/i);
});

test("buildCompressionGuidelinesMarkdown summarizes action\/outcome counts", () => {
  const events: MemoryActionEvent[] = [
    { timestamp: "2026-02-23T00:00:00.000Z", action: "summarize_node", outcome: "applied" },
    { timestamp: "2026-02-23T00:01:00.000Z", action: "summarize_node", outcome: "failed" },
    { timestamp: "2026-02-23T00:02:00.000Z", action: "store_note", outcome: "skipped" },
  ];

  const doc = buildCompressionGuidelinesMarkdown(events, "2026-02-23T00:03:00.000Z");
  assert.match(doc, /summarize_node: 2/);
  assert.match(doc, /applied: 1/);
  assert.match(doc, /failed: 1/);
  assert.match(doc, /skipped: 1/);
});

test("buildCompressionGuidelinesMarkdown includes stable guidance when outcomes are healthy", () => {
  const events: MemoryActionEvent[] = [
    { timestamp: "2026-02-23T00:00:00.000Z", action: "summarize_node", outcome: "applied" },
    { timestamp: "2026-02-23T00:01:00.000Z", action: "summarize_node", outcome: "applied" },
    { timestamp: "2026-02-23T00:02:00.000Z", action: "store_note", outcome: "skipped" },
    { timestamp: "2026-02-23T00:03:00.000Z", action: "store_note", outcome: "applied" },
    { timestamp: "2026-02-23T00:04:00.000Z", action: "store_note", outcome: "applied" },
  ];

  const doc = buildCompressionGuidelinesMarkdown(events, "2026-02-23T00:05:00.000Z");
  assert.match(doc, /Sparse sample size; holding baseline policy/i);
});

test("runCompressionGuidelineLearningPass writes guidelines and optimizer state when enabled", async () => {
  let wrote = "";
  let wroteState: CompressionGuidelineOptimizerState | null = null;
  const ctx: any = {
    config: { compressionGuidelineLearningEnabled: true },
    storage: {
      readCompressionGuidelineOptimizerState: async () => null,
      readMemoryActionEvents: async () =>
        [{ timestamp: "2026-02-23T00:00:00.000Z", action: "summarize_node", outcome: "applied" }],
      writeCompressionGuidelines: async (content: string) => {
        wrote = content;
      },
      writeCompressionGuidelineOptimizerState: async (state: CompressionGuidelineOptimizerState) => {
        wroteState = state;
      },
    },
  };

  await (Orchestrator.prototype as any).runCompressionGuidelineLearningPass.call(ctx);
  assert.match(wrote, /Compression Guidelines/);
  assert.match(wrote, /Source events analyzed: 1/);
  assert.equal(wroteState?.version, 1);
  assert.equal(wroteState?.guidelineVersion, 1);
  assert.equal(wroteState?.eventCounts.total, 1);
});

test("runCompressionGuidelineLearningPass is a no-op when disabled", async () => {
  let readCalled = 0;
  let writeCalled = 0;
  const ctx: any = {
    config: { compressionGuidelineLearningEnabled: false },
    storage: {
      readMemoryActionEvents: async () => {
        readCalled += 1;
        return [];
      },
      writeCompressionGuidelines: async () => {
        writeCalled += 1;
      },
    },
  };

  await (Orchestrator.prototype as any).runCompressionGuidelineLearningPass.call(ctx);
  assert.equal(readCalled, 0);
  assert.equal(writeCalled, 0);
});
