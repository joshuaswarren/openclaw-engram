import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";

test("boostSearchResults applies bounded utility runtime multipliers to heuristic deltas", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-runtime-rank-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-runtime-rank-workspace-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      recencyWeight: 0,
      boostAccessCount: true,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      intentRoutingEnabled: false,
      queryAwareIndexingEnabled: false,
      lifecyclePolicyEnabled: false,
      lifecycleFilterStaleEnabled: false,
      memoryUtilityLearningEnabled: true,
      promotionByOutcomeEnabled: true,
    });
    const orchestrator = new Orchestrator(config) as any;
    orchestrator.utilityRuntimeValues = {
      rankingBoostMultiplier: 1.12,
      rankingSuppressMultiplier: 0.88,
      promoteThresholdDelta: 0,
      demoteThresholdDelta: 0,
      snapshotUpdatedAt: "2026-03-08T12:00:00.000Z",
    };
    orchestrator.storage = {
      readMemoryByPath: async () => ({
        path: "/tmp/memory/facts/a.md",
        content: "a",
        frontmatter: {
          id: "a",
          category: "fact",
          created: "2026-02-01T00:00:00.000Z",
          updated: "2026-02-01T00:00:00.000Z",
          source: "test",
          confidence: 0.9,
          confidenceTier: "explicit",
          tags: [],
          status: "active",
          accessCount: 9,
          importance: { score: 1 },
        },
      }),
    };

    const [result] = await orchestrator.boostSearchResults([
      { path: "/tmp/memory/facts/a.md", score: 0.5, docid: "a", snippet: "a" },
    ], [], undefined);

    assert.ok(result.score > 0.69);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("boostSearchResults excludes dream and procedural memories from generic recall scoring", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-dedicated-surface-filter-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-dedicated-surface-filter-workspace-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      recencyWeight: 0,
      boostAccessCount: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      intentRoutingEnabled: false,
      queryAwareIndexingEnabled: false,
      lifecyclePolicyEnabled: false,
      lifecycleFilterStaleEnabled: false,
    });
    const orchestrator = new Orchestrator(config) as any;
    const memories = new Map<string, any>([
      [
        "/tmp/memory/facts/dream.md",
        {
          path: "/tmp/memory/facts/dream.md",
          content: "Dream narrative",
          frontmatter: {
            id: "dream",
            category: "moment",
            created: "2026-02-01T00:00:00.000Z",
            updated: "2026-02-01T00:00:00.000Z",
            source: "dreams.md",
            confidence: 0.9,
            confidenceTier: "explicit",
            tags: ["dream"],
            status: "active",
            memoryKind: "dream",
          },
        },
      ],
      [
        "/tmp/memory/facts/procedural.md",
        {
          path: "/tmp/memory/facts/procedural.md",
          content: "Heartbeat task",
          frontmatter: {
            id: "procedural",
            category: "principle",
            created: "2026-02-01T00:00:00.000Z",
            updated: "2026-02-01T00:00:00.000Z",
            source: "heartbeat.md",
            confidence: 0.9,
            confidenceTier: "explicit",
            tags: ["heartbeat"],
            status: "active",
            memoryKind: "procedural",
          },
        },
      ],
      [
        "/tmp/memory/facts/normal.md",
        {
          path: "/tmp/memory/facts/normal.md",
          content: "Ordinary memory",
          frontmatter: {
            id: "normal",
            category: "fact",
            created: "2026-02-01T00:00:00.000Z",
            updated: "2026-02-01T00:00:00.000Z",
            source: "test",
            confidence: 0.9,
            confidenceTier: "explicit",
            tags: [],
            status: "active",
          },
        },
      ],
    ]);
    orchestrator.storage = {
      readMemoryByPath: async (path: string) => memories.get(path) ?? null,
    };

    const output = await orchestrator.boostSearchResults([
      { path: "/tmp/memory/facts/dream.md", score: 0.8, docid: "dream", snippet: "dream" },
      { path: "/tmp/memory/facts/procedural.md", score: 0.7, docid: "procedural", snippet: "procedural" },
      { path: "/tmp/memory/facts/normal.md", score: 0.6, docid: "normal", snippet: "normal" },
    ], [], undefined);

    assert.deepEqual(output.map((entry: { docid: string }) => entry.docid), ["normal"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("boostSearchResults can opt dedicated surfaces back into explicit recall flows", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-dedicated-surface-opt-in-memory-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-dedicated-surface-opt-in-workspace-"));
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      recencyWeight: 0,
      boostAccessCount: false,
      feedbackEnabled: false,
      negativeExamplesEnabled: false,
      intentRoutingEnabled: false,
      queryAwareIndexingEnabled: false,
      lifecyclePolicyEnabled: false,
      lifecycleFilterStaleEnabled: false,
    });
    const orchestrator = new Orchestrator(config) as any;
    const memories = new Map<string, any>([
      [
        "/tmp/memory/facts/dream.md",
        {
          path: "/tmp/memory/facts/dream.md",
          content: "Dream narrative",
          frontmatter: {
            id: "dream",
            category: "moment",
            created: "2026-02-01T00:00:00.000Z",
            updated: "2026-02-01T00:00:00.000Z",
            source: "dreams.md",
            confidence: 0.9,
            confidenceTier: "explicit",
            tags: ["dream"],
            status: "active",
            memoryKind: "dream",
          },
        },
      ],
      [
        "/tmp/memory/facts/procedural.md",
        {
          path: "/tmp/memory/facts/procedural.md",
          content: "Heartbeat task",
          frontmatter: {
            id: "procedural",
            category: "principle",
            created: "2026-02-01T00:00:00.000Z",
            updated: "2026-02-01T00:00:00.000Z",
            source: "heartbeat.md",
            confidence: 0.9,
            confidenceTier: "explicit",
            tags: ["heartbeat"],
            status: "active",
            memoryKind: "procedural",
          },
        },
      ],
      [
        "/tmp/memory/facts/normal.md",
        {
          path: "/tmp/memory/facts/normal.md",
          content: "Ordinary memory",
          frontmatter: {
            id: "normal",
            category: "fact",
            created: "2026-02-01T00:00:00.000Z",
            updated: "2026-02-01T00:00:00.000Z",
            source: "test",
            confidence: 0.9,
            confidenceTier: "explicit",
            tags: [],
            status: "active",
          },
        },
      ],
    ]);
    orchestrator.storage = {
      readMemoryByPath: async (path: string) => memories.get(path) ?? null,
    };

    const output = await orchestrator.boostSearchResults(
      [
        { path: "/tmp/memory/facts/dream.md", score: 0.8, docid: "dream", snippet: "dream" },
        { path: "/tmp/memory/facts/procedural.md", score: 0.7, docid: "procedural", snippet: "procedural" },
        { path: "/tmp/memory/facts/normal.md", score: 0.6, docid: "normal", snippet: "normal" },
      ],
      [],
      undefined,
      undefined,
      { allowDedicatedSurface: true },
    );

    assert.deepEqual(
      output.map((entry: { docid: string }) => entry.docid),
      ["dream", "procedural", "normal"],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
