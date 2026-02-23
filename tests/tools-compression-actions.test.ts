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

function buildHarness(options?: {
  contextCompressionActionsEnabled?: boolean;
  appendMemoryActionEventResult?: boolean;
}) {
  const tools = new Map<string, RegisteredTool>();
  const capturedEvents: any[] = [];
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };

  const orchestrator = {
    config: {
      defaultNamespace: "default",
      contextCompressionActionsEnabled: options?.contextCompressionActionsEnabled === true,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      conversationIndexEnabled: false,
      sharedContextEnabled: false,
      compoundingEnabled: false,
    },
    appendMemoryActionEvent: async (event: unknown) => {
      capturedEvents.push(event);
      return options?.appendMemoryActionEventResult ?? true;
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
    recordMemoryFeedback: async () => {},
    recordNotUsefulMemories: async () => {},
    requestQmdMaintenanceForTool: () => {},
  };

  registerTools(api as any, orchestrator as any);
  return { tools, capturedEvents };
}

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

test("context_checkpoint is gated off when context compression actions are disabled", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: false,
  });
  const tool = tools.get("context_checkpoint");
  assert.ok(tool);

  const result = await tool.execute("tc1", { summary: "checkpoint summary" });
  assert.match(toolText(result), /disabled/i);
  assert.equal(capturedEvents.length, 0);
});

test("memory_action_apply records telemetry event when enabled", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc2", {
    action: "store_note",
    sourcePrompt: "trim this context",
  });

  assert.match(toolText(result), /Recorded memory action telemetry/i);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0].action, "store_note");
  assert.equal(capturedEvents[0].outcome, "applied");
  assert.equal(capturedEvents[0].namespace, "default");
  assert.equal(typeof capturedEvents[0].promptHash, "string");
  assert.equal(capturedEvents[0].promptHash.length, 16);
});

test("context_checkpoint logs summarize_node telemetry in requested namespace", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("context_checkpoint");
  assert.ok(tool);

  const result = await tool.execute("tc3", {
    summary: "trimmed low-signal context",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /Recorded context checkpoint telemetry/i);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0].action, "summarize_node");
  assert.equal(capturedEvents[0].namespace, "team-alpha");
  assert.match(capturedEvents[0].reason, /^context_checkpoint:/);
});

test("memory_action_apply fails open when telemetry write fails", async () => {
  const { tools } = buildHarness({
    contextCompressionActionsEnabled: true,
    appendMemoryActionEventResult: false,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc4", {
    action: "discard",
    outcome: "failed",
  });

  assert.match(toolText(result), /fail-open/i);
});
