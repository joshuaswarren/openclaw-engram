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
  appendMemoryActionEvent?: (event: any) => Promise<boolean> | boolean;
  previewMemoryActionEvent?: (event: any) => any;
  writeMemory?: (category: string, content: string, options?: Record<string, unknown>) => Promise<string> | string;
  createCheckpoint?: (sessionKey: string, turns: any[], ttlHours?: number) => any;
  saveCheckpoint?: (checkpoint: any) => Promise<void> | void;
}) {
  const tools = new Map<string, RegisteredTool>();
  const capturedEvents: any[] = [];
  const capturedWrites: Array<{ category: string; content: string; options?: Record<string, unknown> }> = [];
  const createdCheckpoints: Array<{ sessionKey: string; turns: any[]; ttlHours?: number }> = [];
  const savedCheckpoints: any[] = [];
  const api = {
    registerTool(spec: RegisteredTool) {
      tools.set(spec.name, spec);
    },
  };

  const storage = {
    readIdentity: async () => null,
    readProfile: async () => null,
    readAllEntities: async () => [],
    writeMemory: async (category: string, content: string, writeOptions?: Record<string, unknown>) => {
      capturedWrites.push({ category, content, options: writeOptions });
      if (options?.writeMemory) {
        return await options.writeMemory(category, content, writeOptions);
      }
      return "fact-stored";
    },
  };

  const transcript = {
    listSessionKeys: async () => [],
    createCheckpoint: (sessionKey: string, turns: any[], ttlHours?: number) => {
      createdCheckpoints.push({ sessionKey, turns, ttlHours });
      if (options?.createCheckpoint) {
        return options.createCheckpoint(sessionKey, turns, ttlHours);
      }
      return {
        sessionKey,
        capturedAt: "2026-03-11T00:00:00.000Z",
        ttl: "2026-03-12T00:00:00.000Z",
        turns,
      };
    },
    saveCheckpoint: async (checkpoint: any) => {
      savedCheckpoints.push(checkpoint);
      await options?.saveCheckpoint?.(checkpoint);
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
    previewMemoryActionEvent:
      options?.previewMemoryActionEvent ??
      ((event: any) => ({
        ...event,
        namespace: event.namespace ?? "default",
        outcome: event.outcome ?? "applied",
        policyDecision: "allow",
      })),
    appendMemoryActionEvent: async (event: unknown) => {
      capturedEvents.push(event);
      if (options?.appendMemoryActionEvent) {
        return await options.appendMemoryActionEvent(event);
      }
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
    getStorage: async () => storage,
    storage,
    summarizer: {
      runHourly: async () => {},
    },
    transcript,
    sharedContext: null,
    compounding: null,
    recordMemoryFeedback: async () => {},
    recordNotUsefulMemories: async () => {},
    requestQmdMaintenanceForTool: () => {},
  };

  registerTools(api as any, orchestrator as any);
  return { tools, capturedEvents, capturedWrites, createdCheckpoints, savedCheckpoints };
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

test("memory_action_apply dryRun reports without writing telemetry", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc4", {
    action: "link_graph",
    dryRun: true,
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /Dry run:/i);
  assert.match(toolText(result), /policy=allow/i);
  assert.equal(capturedEvents.length, 0);
});

test("memory_action_apply fails open when telemetry write fails", async () => {
  const { tools } = buildHarness({
    contextCompressionActionsEnabled: true,
    appendMemoryActionEventResult: false,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc5", {
    action: "discard",
    outcome: "failed",
  });

  assert.match(toolText(result), /fail-open/i);
});

test("memory_action_apply reports normalized outcome for persisted telemetry", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
    previewMemoryActionEvent: (event) => ({
      ...event,
      namespace: event.namespace ?? "default",
      outcome: "skipped",
      policyDecision: "deny",
    }),
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc6", {
    action: "discard",
    outcome: "applied",
  });

  assert.match(toolText(result), /outcome=skipped/i);
  assert.equal(capturedEvents.length, 1);
});

test("context_checkpoint reuses the transcript checkpoint model and logs checkpoint metadata", async () => {
  const { tools, capturedEvents, createdCheckpoints, savedCheckpoints } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("context_checkpoint");
  assert.ok(tool);

  const turns = [
    {
      timestamp: "2026-03-11T10:00:00.000Z",
      role: "user",
      content: "Please compress the noisy setup discussion.",
      sessionKey: "agent:engram:main",
      turnId: "turn-1",
    },
  ];

  const result = await tool.execute("tc7", {
    summary: "checkpoint before compaction",
    sessionKey: "agent:engram:main",
    turns,
    ttlHours: 12,
    dryRun: false,
  });

  assert.match(toolText(result), /checkpoint/i);
  assert.equal(createdCheckpoints.length, 1);
  assert.deepEqual(createdCheckpoints[0], {
    sessionKey: "agent:engram:main",
    turns,
    ttlHours: 12,
  });
  assert.equal(savedCheckpoints.length, 1);
  assert.equal(savedCheckpoints[0]?.sessionKey, "agent:engram:main");
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.sourceSessionKey, "agent:engram:main");
  assert.equal(capturedEvents[0]?.inputSummary, "checkpoint before compaction");
  assert.equal(capturedEvents[0]?.dryRun, false);
});

test("memory_action_apply executes store_note through storage paths and records output ids", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc8", {
    action: "store_note",
    category: "fact",
    content: "Persist the compaction decision through the normal storage path.",
    namespace: "team-alpha",
    sessionKey: "agent:team-alpha:main",
  });

  assert.match(toolText(result), /memoryId=/i);
  assert.equal(capturedWrites.length, 1);
  assert.deepEqual(capturedWrites[0], {
    category: "fact",
    content: "Persist the compaction decision through the normal storage path.",
    options: {
      actor: "tool.memory_action_apply",
      source: "memory_action_apply",
    },
  });
  assert.equal(capturedEvents.length, 1);
  assert.deepEqual(capturedEvents[0]?.outputMemoryIds, ["fact-stored"]);
  assert.equal(capturedEvents[0]?.status, "applied");
  assert.equal(capturedEvents[0]?.actor, "tool.memory_action_apply");
});

test("memory_action_apply dryRun logs the validated action without mutating storage", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc9", {
    action: "store_note",
    category: "fact",
    content: "Validate without writing this memory.",
    dryRun: true,
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /validated/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.dryRun, true);
  assert.deepEqual(capturedEvents[0]?.outputMemoryIds, []);
});

test("memory_action_apply dryRun appends the raw structured event instead of a pre-previewed event", async () => {
  const { tools, capturedEvents } = buildHarness({
    contextCompressionActionsEnabled: true,
    previewMemoryActionEvent: (event: any) => ({
      ...event,
      reason: event.reason ? `${event.reason}|previewed` : "previewed",
      namespace: event.namespace ?? "default",
      outcome: event.outcome ?? "applied",
      status: "validated",
      policyDecision: "allow",
    }),
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  await tool.execute("tc9b", {
    action: "store_note",
    category: "fact",
    content: "Validate without writing this memory.",
    dryRun: true,
    reason: "seed",
    namespace: "team-alpha",
  });

  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.reason, "seed");
});

test("memory_action_apply logs validation rejections for missing required action inputs", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10", {
    action: "store_note",
    category: "fact",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /validation/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.status, "rejected");
  assert.equal(capturedEvents[0]?.outcome, "failed");
  assert.match(capturedEvents[0]?.reason ?? "", /validation/i);
});

test("memory_action_apply respects policy gates before mutating storage", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
    previewMemoryActionEvent: (event: any) => ({
      ...event,
      namespace: event.namespace ?? "default",
      outcome: "skipped",
      status: "rejected",
      policyDecision: "defer",
      policyRationale: "maxCompressionTokensPerHour=0",
    }),
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10b", {
    action: "summarize_node",
    category: "fact",
    content: "Summarize this node even though compression is disabled.",
    namespace: "team-alpha",
    sessionKey: "agent:team-alpha:main",
  });

  assert.match(toolText(result), /blocked by policy/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.action, "summarize_node");
  assert.equal(capturedEvents[0]?.dryRun, false);
});

test("memory_action_apply keeps legacy telemetry calls with memoryId in compatibility mode", async () => {
  const { tools, capturedEvents, capturedWrites } = buildHarness({
    contextCompressionActionsEnabled: true,
  });
  const tool = tools.get("memory_action_apply");
  assert.ok(tool);

  const result = await tool.execute("tc10c", {
    action: "discard",
    memoryId: "fact-legacy",
    namespace: "team-alpha",
  });

  assert.match(toolText(result), /Recorded memory action telemetry/i);
  assert.equal(capturedWrites.length, 0);
  assert.equal(capturedEvents.length, 1);
  assert.equal(capturedEvents[0]?.memoryId, "fact-legacy");
  assert.equal(capturedEvents[0]?.outcome, "applied");
});
