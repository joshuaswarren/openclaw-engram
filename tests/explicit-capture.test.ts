import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import {
  hasInlineExplicitCaptureMarkup,
  parseInlineExplicitCaptureNotes,
  persistExplicitCapture,
  queueExplicitCaptureForReview,
  shouldProcessInlineExplicitCapture,
  shouldSkipImplicitExtraction,
  stripInlineExplicitCaptureNotes,
  validateExplicitCaptureInput,
} from "../src/explicit-capture.js";
import { ContentHashIndex } from "../src/storage.js";
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

test("inline explicit capture markup is detected even when note blocks are malformed", () => {
  const raw = [
    "Conversation text before.",
    "<memory_note>",
    "category: preference",
    "tags: malformed, ignored",
    "</memory_note>",
    "Conversation text after.",
  ].join("\n");

  const notes = parseInlineExplicitCaptureNotes(raw);
  assert.equal(notes.length, 0);
  assert.equal(hasInlineExplicitCaptureMarkup(raw), true);
  assert.equal(hasInlineExplicitCaptureMarkup(raw), true);
  assert.equal(stripInlineExplicitCaptureNotes(raw), "Conversation text before.\n\nConversation text after.");
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

test("explicit capture validation rejects invalid ttl values before persistence", () => {
  assert.throws(
    () =>
      validateExplicitCaptureInput({
        content: "This memory should fail validation before any write attempt.",
        ttl: "garbage",
      }),
    /ttl must be an ISO-8601 timestamp or relative duration/,
  );
});

test("memory_store can preserve legacy short-content writes while strict explicit capture still rejects them", () => {
  assert.doesNotThrow(() =>
    validateExplicitCaptureInput(
      {
        content: "uses vim",
      },
      "legacy_tool",
    ));

  assert.throws(
    () =>
      validateExplicitCaptureInput({
        content: "uses vim",
      }),
    /at least 10 characters/,
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
    "memory_capture",
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
    "memory_capture",
  );
  assert.equal(second.duplicateOf, first.id);
  assert.equal(memories.length, 1);
  assert.equal(lifecycleEvents.length, 1);
});

test("persistExplicitCapture rejects namespaces outside the configured policy", async () => {
  const storage = {
    hasFactContentHash: async () => false,
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => [],
    writeMemory: async () => "fact-1",
    appendMemoryLifecycleEvents: async () => 1,
  };

  await assert.rejects(
    () =>
      persistExplicitCapture(
        {
          config: {
            defaultNamespace: "default",
            sharedNamespace: "shared",
            namespacesEnabled: false,
            namespacePolicies: [],
          },
          getStorage: async () => storage,
        } as never,
        validateExplicitCaptureInput({
          content: "Store this in a namespace that is not configured.",
          namespace: "team",
        }),
        "memory_capture",
      ),
    /unsupported namespace: team/,
  );
});

test("queueExplicitCaptureForReview stores a pending-review memory and lifecycle event", async () => {
  const memories: Array<{
    frontmatter: { id: string; status?: string; tags?: string[]; category?: string };
    content: string;
    path: string;
  }> = [];
  const lifecycleEvents: Array<{ eventType: string; reasonCode?: string; memoryId: string }> = [];
  let nextId = 1;
  const storage = {
    readAllMemories: async () => memories,
    writeMemory: async (category: string, content: string, options: { tags?: string[] }) => {
      const id = `fact-${nextId++}`;
      memories.push({
        frontmatter: { id, category, tags: options.tags, status: "active" },
        content,
        path: `/tmp/${id}.md`,
      });
      return id;
    },
    getMemoryById: async (id: string) => memories.find((memory) => memory.frontmatter.id === id) ?? null,
    writeMemoryFrontmatter: async (
      memory: { frontmatter: { status?: string } },
      patch: { status: string },
    ) => {
      memory.frontmatter.status = patch.status;
      return memory;
    },
    appendMemoryLifecycleEvents: async (events: Array<{ eventType: string; reasonCode?: string; memoryId: string }>) => {
      lifecycleEvents.push(...events);
      return events.length;
    },
  };

  const queued = await queueExplicitCaptureForReview(
    {
      config: {
        defaultNamespace: "default",
        sharedNamespace: "shared",
        namespacesEnabled: false,
        namespacePolicies: [],
      },
      getStorage: async () => storage,
    } as never,
    {
      content: "api_key=supersecretvalue123 should be reviewed, not dropped",
      category: "fact",
      tags: ["operator-review"],
    },
    "inline",
    new Error("content appears to contain a secret or credential"),
  );

  assert.equal(queued.duplicateOf, undefined);
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.frontmatter.status, "pending_review");
  assert.deepEqual(
    memories[0]?.frontmatter.tags,
    ["explicit-capture", "queued-review", "operator-review"],
  );
  assert.match(memories[0]?.content ?? "", /Explicit capture queued for review/);
  assert.doesNotMatch(memories[0]?.content ?? "", /supersecretvalue123/);
  assert.match(memories[0]?.content ?? "", /\[redacted credential\]/);
  assert.equal(lifecycleEvents.some((event) => event.eventType === "explicit_capture_queued"), true);
});

test("queueExplicitCaptureForReview preserves requested namespace isolation when namespaces are enabled", async () => {
  const requestedNamespaces: string[] = [];
  const storage = {
    readAllMemories: async () => [],
    writeMemory: async () => "fact-1",
    getMemoryById: async () => ({
      frontmatter: { id: "fact-1", status: "active" },
      content: "queued review item",
      path: "/tmp/fact-1.md",
    }),
    writeMemoryFrontmatter: async () => undefined,
    appendMemoryLifecycleEvents: async () => 1,
  };

  await queueExplicitCaptureForReview(
    {
      config: {
        defaultNamespace: "default",
        sharedNamespace: "shared",
        namespacesEnabled: true,
        namespacePolicies: [],
      },
      getStorage: async (namespace?: string) => {
        requestedNamespaces.push(namespace ?? "default");
        return storage;
      },
    } as never,
    {
      content: "This explicit note targeted a private namespace and should stay isolated while queued.",
      category: "fact",
      namespace: "team",
    },
    "inline",
    new Error("unsupported namespace: team"),
  );

  assert.deepEqual(requestedNamespaces, ["team", "team"]);
});

test("persistExplicitCapture attributes lifecycle actors to the correct tool source", async () => {
  const lifecycleEvents: Array<{ actor: string; memoryId: string }> = [];
  const sources: string[] = [];
  let nextId = 1;
  const storage = {
    hasFactContentHash: async () => false,
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => [],
    writeMemory: async (_category: string, _content: string, options: { source?: string }) => {
      sources.push(options.source ?? "");
      return `fact-${nextId++}`;
    },
    appendMemoryLifecycleEvents: async (events: Array<{ actor: string; memoryId: string }>) => {
      lifecycleEvents.push(...events);
      return events.length;
    },
  };
  const orchestrator = { getStorage: async () => storage };

  await persistExplicitCapture(
    orchestrator as never,
    validateExplicitCaptureInput({ content: "Store this using the memory_store tool path." }),
    "memory_store",
  );
  await persistExplicitCapture(
    orchestrator as never,
    validateExplicitCaptureInput({ content: "Store this using the memory_capture tool path." }),
    "memory_capture",
  );

  assert.deepEqual(
    lifecycleEvents.map((event) => event.actor),
    ["tool.memory_store", "tool.memory_capture"],
  );
  assert.deepEqual(sources, ["explicit", "explicit"]);
});

test("fact duplicate checks short-circuit without a full corpus scan when authoritative hash index misses", async () => {
  const storage = {
    hasFactContentHash: async () => false,
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => [],
    writeMemory: async () => "fact-1",
    appendMemoryLifecycleEvents: async () => 1,
  };

  const duplicate = await persistExplicitCapture(
    { getStorage: async () => storage } as never,
    validateExplicitCaptureInput({
      content: "This fact should miss the hash gate and skip the full scan.",
      category: "fact",
    }),
    "memory_capture",
  );

  assert.equal(duplicate.duplicateOf, undefined);
  assert.equal(duplicate.id, "fact-1");
});

test("fact duplicate checks fall back to the full corpus scan when hash index coverage is not authoritative", async () => {
  let readAllMemoriesCalls = 0;
  const storage = {
    hasFactContentHash: async () => false,
    isFactContentHashAuthoritative: async () => false,
    readAllMemories: async () => {
      readAllMemoriesCalls += 1;
      return [
        {
          frontmatter: { id: "fact-legacy", category: "fact", status: "active" },
          content: "Legacy fact content that predates the hash index.",
        },
      ];
    },
    writeMemory: async () => "fact-should-not-write",
    appendMemoryLifecycleEvents: async () => 1,
  };

  const duplicate = await persistExplicitCapture(
    { getStorage: async () => storage } as never,
    validateExplicitCaptureInput({
      content: "Legacy fact content that predates the hash index.",
      category: "fact",
    }),
    "memory_capture",
  );

  assert.equal(duplicate.duplicateOf, "fact-legacy");
  assert.equal(readAllMemoriesCalls, 1);
});

test("fact duplicate checks fail open to the full corpus scan when hash index access throws", async () => {
  let readAllMemoriesCalls = 0;
  const storage = {
    hasFactContentHash: async () => {
      throw new Error("transient hash index failure");
    },
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => {
      readAllMemoriesCalls += 1;
      return [
        {
          frontmatter: { id: "fact-legacy", category: "fact", status: "active" },
          content: "Legacy fact content that predates the hash index.",
        },
      ];
    },
    writeMemory: async () => "fact-should-not-write",
    appendMemoryLifecycleEvents: async () => 1,
  };

  const duplicate = await persistExplicitCapture(
    { getStorage: async () => storage } as never,
    validateExplicitCaptureInput({
      content: "Legacy fact content that predates the hash index.",
      category: "fact",
    }),
    "memory_capture",
  );

  assert.equal(duplicate.duplicateOf, "fact-legacy");
  assert.equal(readAllMemoriesCalls, 1);
});

test("explicit capture duplicate normalization stays aligned with fact hash normalization", () => {
  const a = "User prefers: pourover coffee.";
  const b = "user prefers pourover coffee";
  assert.equal(
    ContentHashIndex.normalizeContent(a),
    ContentHashIndex.normalizeContent(b),
  );
});

test("explicit capture duplicate checks preserve punctuation that changes technical meaning", async () => {
  const storage = {
    hasFactContentHash: async () => true,
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => [
      {
        frontmatter: { id: "fact-cpp", category: "fact", status: "active" },
        content: "User prefers C++",
      },
    ],
    writeMemory: async () => "fact-c",
    appendMemoryLifecycleEvents: async () => 1,
  };

  const result = await persistExplicitCapture(
    { getStorage: async () => storage } as never,
    validateExplicitCaptureInput({
      content: "User prefers C",
      category: "fact",
    }),
    "memory_capture",
  );

  assert.equal(result.duplicateOf, undefined);
  assert.equal(result.id, "fact-c");
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
  const maintenanceReasons: string[] = [];
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
      writeMemoryFrontmatter: async (
        memory: { frontmatter: { status?: string } },
        patch: { status: string },
      ) => {
        memory.frontmatter.status = patch.status;
        return memory;
      },
      appendMemoryLifecycleEvents: async (events: unknown[]) => {
        appendedEvents += events.length;
        return events.length;
      },
    }),
    requestQmdMaintenanceForTool: (reason: string) => {
      maintenanceReasons.push(reason);
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
  assert.deepEqual(maintenanceReasons, ["memory_store", "memory_capture"]);

  const queued = await memoryCapture!.execute("tc-3", {
    content: "sk-1234567890abcdef1234567890abcdef should never be stored",
  });
  assert.match(queued.content[0]?.text ?? "", /Memory queued for review: fact-2/);
  assert.equal(memories.length, 2);
  assert.equal(memories[1]?.frontmatter.status, "pending_review");
  assert.equal(appendedEvents, 2);
  assert.deepEqual(maintenanceReasons, ["memory_store", "memory_capture", "memory_capture.review"]);
});
