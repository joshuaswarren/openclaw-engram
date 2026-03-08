import test from "node:test";
import assert from "node:assert/strict";
import { buildCompressionGuidelinesMarkdown, Orchestrator } from "../src/orchestrator.ts";
import type { MemoryActionEvent } from "../src/types.ts";

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

test("runCompressionGuidelineLearningPass delegates to optimizeCompressionGuidelines when enabled", async () => {
  let called = 0;
  let received: { dryRun?: boolean; eventLimit?: number } | null = null;
  const ctx: any = {
    config: { compressionGuidelineLearningEnabled: true },
    optimizeCompressionGuidelines: async (options: { dryRun?: boolean; eventLimit?: number }) => {
      called += 1;
      received = options;
      return {
        enabled: true,
        dryRun: false,
        eventCount: 1,
        previousGuidelineVersion: null,
        nextGuidelineVersion: 1,
        changedRules: 0,
        semanticRefinementApplied: false,
        persisted: true,
      };
    },
  };

  await (Orchestrator.prototype as any).runCompressionGuidelineLearningPass.call(ctx);
  assert.equal(called, 1);
  assert.deepEqual(received, { dryRun: false, eventLimit: 500 });
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
