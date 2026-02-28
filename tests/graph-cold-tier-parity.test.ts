import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { StorageManager } from "../src/storage.js";
import type { QmdSearchResult } from "../src/types.js";

test("cold fallback applies graph expansion parity when enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cold-graph-parity-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-cold-graph-parity-workspace-"));

  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: true,
      qmdMaxResults: 3,
      qmdCollection: "engram-hot",
      qmdColdTierEnabled: true,
      qmdColdCollection: "engram-cold",
      qmdTierParityGraphEnabled: true,
      embeddingFallbackEnabled: false,
      recallPlannerEnabled: true,
      graphRecallEnabled: true,
      multiGraphMemoryEnabled: true,
      graphAssistInFullModeEnabled: true,
      graphAssistMinSeedResults: 1,
      verbatimArtifactsEnabled: false,
    });
    const orchestrator = new Orchestrator(config) as any;

    const coldStorage = new StorageManager(path.join(memoryDir, "cold"));
    const seedId = await coldStorage.writeMemory("fact", "cold graph seed memory", { source: "test" });
    const expandedId = await coldStorage.writeMemory("fact", "cold graph expanded memory", { source: "test" });
    const seed = await coldStorage.getMemoryById(seedId);
    const expanded = await coldStorage.getMemoryById(expandedId);
    assert.ok(seed);
    assert.ok(expanded);

    orchestrator.qmd = {
      isAvailable: () => true,
      search: async () => [],
      hybridSearch: async () => [],
    };

    orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async (
      _prompt: string,
      _qmdFetchLimit: number,
      _qmdHybridFetchLimit: number,
      opts: { collection?: string },
    ): Promise<QmdSearchResult[]> => {
      if (opts.collection === "engram-cold") {
        return [
          {
            docid: seed!.frontmatter.id,
            path: seed!.path,
            score: 0.9,
            snippet: seed!.content,
          },
        ];
      }
      return [];
    };

    orchestrator.expandResultsViaGraph = async ({ memoryResults }: { memoryResults: QmdSearchResult[] }) => ({
      merged: [
        {
          docid: expanded!.frontmatter.id,
          path: expanded!.path,
          score: 0.99,
          snippet: expanded!.content,
        },
        ...memoryResults,
      ],
      seedPaths: [seed!.path],
      expandedPaths: [
        {
          path: expanded!.path,
          score: 0.99,
          namespace: "default",
          seed: seed!.path,
          hopDepth: 1,
          decayedWeight: 0.8,
          graphType: "entity",
        },
      ],
    });

    const output = await orchestrator.recallInternal(
      "Summarize long-term state",
      "session-cold-graph-parity",
    );

    assert.match(output, /Long-Term Memories \(Fallback\)/);
    assert.match(output, /cold graph seed memory/);
    assert.match(output, /cold graph expanded memory/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
