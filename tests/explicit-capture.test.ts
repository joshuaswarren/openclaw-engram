import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import {
  findDuplicateExplicitCapture,
  parseInlineExplicitCaptureNotes,
  persistExplicitCapture,
  shouldProcessInlineExplicitCapture,
  shouldSkipImplicitExtraction,
  stripInlineExplicitCaptureNotes,
  validateExplicitCaptureInput,
} from "../src/explicit-capture.js";
import { Orchestrator } from "../src/orchestrator.js";
import { registerTools } from "../src/tools.js";

test("parseConfig defaults captureMode to implicit and accepts explicit modes", () => {
  assert.equal(parseConfig({ openaiApiKey: "sk-test" }).captureMode, "implicit");
  assert.equal(parseConfig({ openaiApiKey: "sk-test", captureMode: "explicit" }).captureMode, "explicit");
  assert.equal(parseConfig({ openaiApiKey: "sk-test", captureMode: "hybrid" }).captureMode, "hybrid");
});

test("processTurn skips buffering when captureMode=explicit", async () => {
  let addTurnCalls = 0;
  const fake = {
    config: { captureMode: "explicit" },
    buffer: {
      addTurn: async () => {
        addTurnCalls += 1;
        return "keep_buffering";
      },
      getTurns: () => [],
    },
    queueBufferedExtraction: async () => undefined,
  };

  await Orchestrator.prototype.processTurn.call(fake, "user", "remember this later", "session-1");

  assert.equal(addTurnCalls, 0);
});

test("capture mode helpers distinguish implicit, explicit, and hybrid behavior", () => {
  assert.equal(shouldProcessInlineExplicitCapture({ captureMode: "implicit" }), false);
  assert.equal(shouldProcessInlineExplicitCapture({ captureMode: "explicit" }), true);
  assert.equal(shouldProcessInlineExplicitCapture({ captureMode: "hybrid" }), true);
  assert.equal(shouldSkipImplicitExtraction({ captureMode: "implicit" }), false);
  assert.equal(shouldSkipImplicitExtraction({ captureMode: "hybrid" }), false);
  assert.equal(shouldSkipImplicitExtraction({ captureMode: "explicit" }), true);
});

test("inline explicit capture notes parse and strip cleanly", () => {
  const raw = [
    "Normal text before.",
    "<memory_note>",
    "category: preference",
    "tags: coffee, morning",
    "content: User prefers pourover coffee in the morning.",
    "</memory_note>",
    "Normal text after.",
  ].join("\n");

  const notes = parseInlineExplicitCaptureNotes(raw);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.category, "preference");
  assert.deepEqual(notes[0]?.tags, ["coffee", "morning"]);
  assert.equal(notes[0]?.content, "User prefers pourover coffee in the morning.");
  assert.equal(stripInlineExplicitCaptureNotes(raw), "Normal text before.\n\nNormal text after.");
});

test("explicit capture validation rejects likely secrets", () => {
  assert.throws(
    () =>
      validateExplicitCaptureInput({
        content: "api_key=supersecretvalue123 remember this forever",
      }),
    /secret or credential/,
  );
});

test("persistExplicitCapture writes lifecycle events and dedupes active duplicates", async () => {
  const memories: Array<{
    frontmatter: { id: string; category: string; status?: string };
    content: string;
  }> = [];
  const lifecycleEvents: Array<{ eventType: string; actor: string; memoryId: string }> = [];
  const writeOptions: Array<{ expiresAt?: string }> = [];
  let nextId = 1;

  const storage = {
    hasFactContentHash: async () => memories.length > 0,
    readAllMemories: async () => memories,
    writeMemory: async (category: string, content: string, options: { expiresAt?: string }) => {
      const id = `fact-${nextId++}`;
      writeOptions.push(options);
      memories.push({
        frontmatter: { id, category, status: "active" },
        content,
      });
      return id;
    },
    appendMemoryLifecycleEvents: async (events: Array<{ eventType: string; actor: string; memoryId: string }>) => {
      lifecycleEvents.push(...events);
      return events.length;
    },
  };

  const orchestrator = {
    getStorage: async () => storage,
  };

  const first = await persistExplicitCapture(
    orchestrator as never,
    validateExplicitCaptureInput({
      content: "The user prefers concise responses in technical reviews.",
      category: "preference",
      sourceReason: "user-request",
      ttl: "2d",
    }),
    "tool",
  );
  assert.equal(first.duplicateOf, undefined);
  assert.equal(lifecycleEvents.length, 1);
  assert.equal(lifecycleEvents[0]?.eventType, "explicit_capture_accepted");
  assert.equal(lifecycleEvents[0]?.actor, "tool.memory_capture");
  assert.equal(typeof writeOptions[0]?.expiresAt, "string");
  assert.ok(Date.parse(writeOptions[0]?.expiresAt ?? "") > Date.now());

  const second = await persistExplicitCapture(
    orchestrator as never,
    validateExplicitCaptureInput({
      content: "The user prefers concise responses in technical reviews.",
      category: "preference",
    }),
    "tool",
  );
  assert.equal(second.duplicateOf, first.id);
  assert.equal(memories.length, 1);
  assert.equal(lifecycleEvents.length, 1);
});

test("fact duplicate checks short-circuit without a full corpus scan when hash index misses", async () => {
  let readAllMemoriesCalls = 0;
  const storage = {
    hasFactContentHash: async () => false,
    readAllMemories: async () => {
      readAllMemoriesCalls += 1;
      return [];
    },
  };

  const duplicate = await findDuplicateExplicitCapture(
    { getStorage: async () => storage } as never,
    validateExplicitCaptureInput({
      content: "This fact should miss the hash gate and skip the full scan.",
      category: "fact",
    }),
  );

  assert.equal(duplicate, null);
  assert.equal(readAllMemoriesCalls, 0);
});

test("memory_store and memory_capture share explicit validation and duplicate handling", async () => {
  type RegisteredTool = {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
  };
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(
      spec: {
        name: string;
        execute: (
          toolCallId: string,
          params: Record<string, unknown>,
        ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
      },
    ) {
      tools.set(spec.name, { execute: spec.execute });
    },
  };

  const memories: Array<{
    path: string;
    content: string;
    frontmatter: { id: string; created: string; tags: string[]; category: string; status?: string };
  }> = [];
  let maintenanceRequests = 0;
  let appendedEvents = 0;
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      feedbackEnabled: false,
      namespacesEnabled: false,
      queryAwareIndexingEnabled: false,
      memoryDir: "/tmp/engram-explicit-tools",
    },
    getStorage: async () => ({
      readAllMemories: async () => memories,
      writeMemory: async (category: string, content: string, options: { tags?: string[] }) => {
        const id = `fact-${memories.length + 1}`;
        memories.push({
          path: `/tmp/${id}.md`,
          content,
          frontmatter: {
            id,
            created: "2026-03-08T00:00:00.000Z",
            tags: options.tags ?? [],
            category,
            status: "active",
          },
        });
        return id;
      },
      getMemoryById: async (id: string) => memories.find((memory) => memory.frontmatter.id === id) ?? null,
      appendMemoryLifecycleEvents: async (events: unknown[]) => {
        appendedEvents += events.length;
        return events.length;
      },
    }),
    requestQmdMaintenanceForTool: (_reason: string) => {
      maintenanceRequests += 1;
    },
    qmd: {
      search: async () => [],
      searchGlobal: async () => [],
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    recordMemoryFeedback: async () => {},
    storage: {
      readProfile: async () => "",
      readIdentity: async () => "",
      resolveQuestion: async () => false,
      listQuestions: async () => [],
      getMemoryById: async () => null,
    },
    summarizeNow: async () => undefined,
    runConversationIndexUpdate: async () => ({ indexedSessions: 0, indexedChunks: 0, embeddedRuns: 0 }),
    sharedContext: null,
    compoundingEngine: null,
  };

  registerTools(api as never, orchestrator as never);

  const memoryStore = tools.get("memory_store");
  const memoryCapture = tools.get("memory_capture");
  assert.ok(memoryStore);
  assert.ok(memoryCapture);

  const stored = await memoryStore!.execute("tc-1", {
    content: "Store this durable explicit memory for the plugin.",
    category: "fact",
  });
  assert.match(stored.content[0]?.text ?? "", /Memory stored: fact-1/);
  assert.equal(memories.length, 1);
  assert.equal(appendedEvents, 1);

  const duplicate = await memoryCapture!.execute("tc-2", {
    content: "Store this durable explicit memory for the plugin.",
    category: "fact",
  });
  assert.match(duplicate.content[0]?.text ?? "", /Memory already exists: fact-1/);
  assert.equal(memories.length, 1);
  assert.equal(appendedEvents, 1);
  assert.equal(maintenanceRequests, 2);

  await assert.rejects(
    () =>
      memoryCapture!.execute("tc-3", {
        content: "sk-1234567890abcdef1234567890abcdef should never be stored",
      }),
    /secret or credential/,
  );
});
