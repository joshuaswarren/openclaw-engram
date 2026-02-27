import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.ts";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
};

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

function buildHarness(resultOverride?: {
  enabled?: boolean;
  dryRun?: boolean;
  eventCount?: number;
  previousGuidelineVersion?: number | null;
  nextGuidelineVersion?: number;
  changedRules?: number;
  semanticRefinementApplied?: boolean;
  persisted?: boolean;
}) {
  const tools = new Map<string, RegisteredTool>();
  const capturedCalls: Array<Record<string, unknown>> = [];
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };

  const orchestrator = {
    config: {
      defaultNamespace: "default",
      contextCompressionActionsEnabled: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
    },
    optimizeCompressionGuidelines: async (params?: Record<string, unknown>) => {
      capturedCalls.push(params ?? {});
      return {
        enabled: resultOverride?.enabled ?? true,
        dryRun: resultOverride?.dryRun ?? false,
        eventCount: resultOverride?.eventCount ?? 22,
        previousGuidelineVersion: resultOverride?.previousGuidelineVersion ?? 3,
        nextGuidelineVersion: resultOverride?.nextGuidelineVersion ?? 4,
        changedRules: resultOverride?.changedRules ?? 2,
        semanticRefinementApplied: resultOverride?.semanticRefinementApplied ?? false,
        persisted: resultOverride?.persisted ?? true,
      };
    },
    qmd: {
      search: async () => [],
      searchGlobal: async () => [],
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    storage: {
      readIdentity: async () => null,
      readProfile: async () => null,
      readAllEntities: async () => [],
    },
    summarizer: {
      runHourly: async () => {},
    },
    transcript: {
      listSessionKeys: async () => [],
    },
    sharedContext: null,
    compounding: null,
    appendMemoryActionEvent: async () => true,
    recordMemoryFeedback: async () => {},
    recordNotUsefulMemories: async () => {},
    requestQmdMaintenanceForTool: () => {},
  };

  registerTools(api as any, orchestrator as any);
  return { tools, capturedCalls };
}

test("compression_guidelines_optimize reports disabled learning gate", async () => {
  const { tools } = buildHarness({ enabled: false });
  const tool = tools.get("compression_guidelines_optimize");
  assert.ok(tool);

  const result = await tool.execute("tc-opt-1", { dryRun: true });
  assert.match(toolText(result), /disabled/i);
});

test("compression_guidelines_optimize passes dryRun/eventLimit and returns summary", async () => {
  const { tools, capturedCalls } = buildHarness({
    enabled: true,
    dryRun: true,
    eventCount: 10,
    previousGuidelineVersion: 5,
    nextGuidelineVersion: 6,
    changedRules: 1,
    semanticRefinementApplied: true,
    persisted: false,
  });
  const tool = tools.get("compression_guidelines_optimize");
  assert.ok(tool);

  const result = await tool.execute("tc-opt-2", { dryRun: true, eventLimit: 120 });
  assert.equal(capturedCalls.length, 1);
  assert.deepEqual(capturedCalls[0], { dryRun: true, eventLimit: 120 });

  const text = toolText(result);
  assert.match(text, /optimization complete/i);
  assert.match(text, /dryRun=true/);
  assert.match(text, /persisted=false/);
  assert.match(text, /guidelineVersion: 5 -> 6/);
  assert.match(text, /changedRules=1/);
  assert.match(text, /semanticRefinementApplied=true/);
});
