import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.js";

/**
 * Regression test for: memory_store not triggering QMD sync after write.
 *
 * The bug: QmdClient.update() and embed() did not pass `-c <collection>`,
 * and memory_store never called update()/embed() after writing a file,
 * so new memories were never indexed and never searchable.
 */

test("QmdClient.update() passes collection flag to qmd subprocess", async () => {
  // We can't easily run the real qmd binary in tests, so we verify the
  // source code contains the collection-scoped flags.
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const qmdSource = readFileSync(
    resolve(import.meta.dirname, "..", "src", "qmd.ts"),
    "utf-8",
  );

  // update() must pass -c collection
  assert.match(
    qmdSource,
    /runQmd\(\["update",\s*"-c",\s*this\.collection\]/,
    "update() should pass -c this.collection to scope updates to the engram collection",
  );

  // embed() must pass -c collection
  assert.match(
    qmdSource,
    /runQmd\(\["embed",\s*"-c",\s*this\.collection\]/,
    "embed() should pass -c this.collection to scope embedding to the engram collection",
  );
});

test("memory_store queues orchestrator-maintained QMD sync after write", async () => {
  type RegisteredTool = {
    name: string;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
  };
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(
      spec: {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        execute: (
          toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
        ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
      },
      _options: { name: string },
    ) {
      tools.set(spec.name, { name: spec.name, execute: spec.execute });
    },
  };

  const writeCalls: Array<{ category: string; content: string }> = [];
  let maintenanceRequests = 0;
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      feedbackEnabled: false,
      namespacesEnabled: false,
    },
    getStorage: async () => ({
      writeMemory: async (category: string, content: string) => {
        writeCalls.push({ category, content });
        return "fact-test-1";
      },
    }),
    requestQmdMaintenanceForTool: (reason: string) => {
      assert.equal(reason, "memory_store");
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

  registerTools(api as any, orchestrator as any);

  const memoryStore = tools.get("memory_store");
  assert.ok(memoryStore, "memory_store tool should be registered");

  const out = await memoryStore!.execute("tc-1", {
    content: "Store this durable memory",
  });

  assert.equal(writeCalls.length, 1);
  assert.deepEqual(writeCalls[0], {
    category: "fact",
    content: "Store this durable memory",
  });
  assert.equal(maintenanceRequests, 1);
  assert.match(out.content[0].text, /Memory stored: fact-test-1/);
});
