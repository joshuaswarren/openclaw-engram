import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
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

test("optimizeCompressionGuidelines does not publish new state for dry-run-only evidence", async () => {
  let wroteGuidelines = 0;
  let wroteState = 0;
  const ctx: any = {
    config: {
      compressionGuidelineLearningEnabled: true,
      compressionGuidelineSemanticRefinementEnabled: false,
      compressionGuidelineSemanticTimeoutMs: 1000,
    },
    storage: {
      readCompressionGuidelineOptimizerState: async () => ({
        version: 5,
        updatedAt: "2026-02-26T00:00:00.000Z",
        sourceWindow: { from: "2026-02-25T00:00:00.000Z", to: "2026-02-25T23:59:59.000Z" },
        eventCounts: { total: 12, applied: 8, skipped: 2, failed: 2 },
        guidelineVersion: 9,
      }),
      readMemoryActionEvents: async () => [
        { timestamp: "2026-02-27T00:00:00.000Z", action: "store_note", outcome: "applied", dryRun: true },
        { timestamp: "2026-02-27T00:01:00.000Z", action: "discard", outcome: "skipped", dryRun: true },
      ],
      writeCompressionGuidelines: async () => {
        wroteGuidelines += 1;
      },
      writeCompressionGuidelineOptimizerState: async () => {
        wroteState += 1;
      },
    },
  };

  const result = await (Orchestrator.prototype as any).optimizeCompressionGuidelines.call(ctx, {
    dryRun: false,
    eventLimit: 500,
  });

  assert.equal(result.enabled, true);
  assert.equal(result.eventCount, 0);
  assert.equal(result.previousGuidelineVersion, 9);
  assert.equal(result.nextGuidelineVersion, 9);
  assert.equal(result.changedRules, 0);
  assert.equal(result.semanticRefinementApplied, false);
  assert.equal(result.persisted, false);
  assert.equal(wroteGuidelines, 0);
  assert.equal(wroteState, 0);
});

test("optimizeCompressionGuidelines over-fetches until it collects enough non-dry-run events", async () => {
  const readLimits: number[] = [];
  const ledger: MemoryActionEvent[] = [
    { timestamp: "2026-02-27T00:00:00.000Z", action: "store_note", outcome: "applied" },
    { timestamp: "2026-02-27T00:01:00.000Z", action: "store_note", outcome: "failed" },
    { timestamp: "2026-02-27T00:02:00.000Z", action: "store_note", outcome: "applied", dryRun: true },
    { timestamp: "2026-02-27T00:03:00.000Z", action: "store_note", outcome: "skipped", dryRun: true },
    { timestamp: "2026-02-27T00:04:00.000Z", action: "store_note", outcome: "applied", dryRun: true },
  ];
  let wroteGuidelines = 0;
  let wroteState = 0;
  const ctx: any = {
    config: {
      compressionGuidelineLearningEnabled: true,
      compressionGuidelineSemanticRefinementEnabled: false,
      compressionGuidelineSemanticTimeoutMs: 1000,
    },
    storage: {
      readCompressionGuidelineOptimizerState: async () => null,
      readMemoryActionEvents: async (limit: number) => {
        readLimits.push(limit);
        return ledger.slice(-limit);
      },
      writeCompressionGuidelines: async () => {
        wroteGuidelines += 1;
      },
      writeCompressionGuidelineOptimizerState: async () => {
        wroteState += 1;
      },
    },
  };

  const result = await (Orchestrator.prototype as any).optimizeCompressionGuidelines.call(ctx, {
    dryRun: false,
    eventLimit: 2,
  });

  assert.deepEqual(readLimits, [2, 4, 8]);
  assert.equal(result.enabled, true);
  assert.equal(result.eventCount, 2);
  assert.equal(result.nextGuidelineVersion, 1);
  assert.equal(wroteGuidelines, 1);
  assert.equal(wroteState, 1);
});

test("optimizeCompressionGuidelines stages a draft revision without overwriting the active guideline", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-guideline-stage-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: memoryDir,
      compressionGuidelineLearningEnabled: true,
      compressionGuidelineSemanticRefinementEnabled: false,
    });
    const orchestrator = new Orchestrator(cfg);

    await orchestrator.storage.writeCompressionGuidelines("# Compression Guidelines\n\n## Suggested Guidelines\n- store_note: hold\n");
    await orchestrator.storage.writeCompressionGuidelineOptimizerState({
      version: 1,
      updatedAt: "2026-03-10T00:00:00.000Z",
      sourceWindow: {
        from: "2026-03-09T00:00:00.000Z",
        to: "2026-03-10T00:00:00.000Z",
      },
      eventCounts: {
        total: 3,
        applied: 2,
        skipped: 1,
        failed: 0,
      },
      guidelineVersion: 2,
      activationState: "active",
    });
    await orchestrator.storage.appendMemoryActionEvents([
      {
        timestamp: "2026-03-11T00:00:00.000Z",
        action: "summarize_node",
        outcome: "failed",
        reason: "quality=poor",
      },
      {
        timestamp: "2026-03-11T00:05:00.000Z",
        action: "summarize_node",
        outcome: "applied",
        reason: "quality=good",
      },
    ]);

    const result = await orchestrator.optimizeCompressionGuidelines({ dryRun: false, eventLimit: 50 });
    assert.equal(result.persisted, true);

    const activeGuidelines = await orchestrator.storage.readCompressionGuidelines();
    const draftGuidelines = await orchestrator.storage.readCompressionGuidelineDraft();
    const activeState = await orchestrator.storage.readCompressionGuidelineOptimizerState();
    const draftState = await orchestrator.storage.readCompressionGuidelineDraftState();

    assert.match(activeGuidelines ?? "", /store_note: hold/);
    assert.ok(draftGuidelines);
    assert.equal(activeState?.activationState, "active");
    assert.equal(draftState?.activationState, "draft");
    assert.equal((draftState?.guidelineVersion ?? 0) > (activeState?.guidelineVersion ?? 0), true);
    assert.equal(Array.isArray(draftState?.ruleUpdates), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
