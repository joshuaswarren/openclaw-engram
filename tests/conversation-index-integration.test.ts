import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function makeOrchestrator(overrides: Record<string, unknown>): Promise<Orchestrator> {
  const memoryDir = tmpDir("engram-conv-index-int");
  const workspaceDir = path.join(memoryDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    sharedContextEnabled: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

test("conversation recall search uses qmd backend when configured", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "qmd",
  });

  let qmdCalls = 0;
  let faissCalls = 0;

  (orchestrator as any).conversationQmd = {
    isAvailable: () => true,
    search: async () => {
      qmdCalls += 1;
      return [{ path: "qmd/chunk-1", snippet: "QMD hit", score: 0.7 }];
    },
  };
  (orchestrator as any).conversationFaiss = {
    searchChunks: async () => {
      faissCalls += 1;
      return [{ path: "faiss/chunk-1", snippet: "FAISS hit", score: 0.9 }];
    },
  };

  const results = await (orchestrator as any).searchConversationRecallResults("query", 3);
  assert.equal(qmdCalls, 1);
  assert.equal(faissCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].path, "qmd/chunk-1");
});

test("conversation recall search fail-opens for faiss backend errors", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
  });

  (orchestrator as any).conversationFaiss = {
    searchChunks: async () => {
      throw new Error("boom");
    },
  };

  const results = await (orchestrator as any).searchConversationRecallResults("query", 3);
  assert.deepEqual(results, []);
});

test("conversation recall section formatting stays backend-agnostic", async () => {
  const orchestrator = await makeOrchestrator({ conversationIndexEnabled: true });

  const rows = [
    { path: "chunk/one.md", snippet: "  first snippet  ", score: 0.81234 },
    { path: "chunk/two.md", snippet: "second snippet", score: 0.5 },
  ];

  const formatted = (orchestrator as any).formatConversationRecallSection(rows, 10_000);
  assert.ok(formatted);
  assert.match(formatted, /## Semantic Recall \(Past Conversations\)/);
  assert.match(formatted, /### chunk\/one\.md/);
  assert.match(formatted, /Score: 0\.812/);
  assert.match(formatted, /first snippet/);
  assert.match(formatted, /### chunk\/two\.md/);
  assert.match(formatted, /Score: 0\.500/);
});

test("updateConversationIndex routes writes through FAISS backend when selected", async () => {
  const orchestrator = await makeOrchestrator({
    conversationIndexEnabled: true,
    conversationIndexBackend: "faiss",
    conversationIndexEmbedOnUpdate: true,
  });

  let upsertCalls = 0;
  let qmdCalls = 0;

  (orchestrator as any).transcript = {
    readRecent: async () => [
      {
        timestamp: "2026-02-27T00:00:00.000Z",
        role: "user",
        content: "hello from transcript",
      },
    ],
  };

  (orchestrator as any).conversationFaiss = {
    upsertChunks: async (chunks: unknown[]) => {
      upsertCalls += 1;
      return chunks.length;
    },
  };

  (orchestrator as any).conversationQmd = {
    isAvailable: () => true,
    update: async () => {
      qmdCalls += 1;
    },
    embed: async () => {
      qmdCalls += 1;
    },
  };

  const result = await orchestrator.updateConversationIndex("session-a", 24, {
    enforceMinInterval: false,
  });

  assert.equal(upsertCalls, 1);
  assert.equal(qmdCalls, 0);
  assert.equal(result.skipped, false);
  assert.equal(result.embedded, false);
  assert.equal(result.chunks > 0, true);
});
