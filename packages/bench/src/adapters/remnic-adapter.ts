/**
 * Package-owned Remnic adapters used by the phase-1 benchmark CLI surface.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Orchestrator, parseConfig } from "@remnic/core";
import type { BenchMemoryAdapter, MemoryStats, Message, SearchResult } from "./types.js";

export interface RemnicAdapterOptions {
  configOverrides?: Record<string, unknown>;
}

async function createBenchOrchestrator(
  mode: "lightweight" | "direct",
  overrides?: Record<string, unknown>,
): Promise<{ tempDir: string; orchestrator: Orchestrator }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), `remnic-bench-${mode}-`));
  await mkdir(path.join(tempDir, "state"), { recursive: true });

  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir: tempDir,
      workspaceDir: tempDir,
      qmdEnabled: false,
      qmdColdTierEnabled: false,
      transcriptEnabled: false,
      hourlySummariesEnabled: false,
      daySummaryEnabled: false,
      identityEnabled: false,
      identityContinuityEnabled: false,
      namespacesEnabled: false,
      sharedContextEnabled: false,
      workTasksEnabled: false,
      workProjectsEnabled: false,
      commitmentLedgerEnabled: false,
      resumeBundlesEnabled: false,
      nativeKnowledge: { enabled: false },
      lcmEnabled: true,
      lcmLeafBatchSize: 4,
      lcmRollupFanIn: 3,
      lcmFreshTailTurns: 8,
      lcmMaxDepth: 4,
      lcmDeterministicMaxTokens: 512,
      lcmRecallBudgetShare: 1.0,
      extractionDedupeEnabled: mode === "direct",
      extractionMinChars: mode === "direct" ? 10 : 1000000,
      extractionMinUserTurns: mode === "direct" ? 0 : 1000000,
      recallPlannerEnabled: mode === "direct",
      queryExpansionEnabled: false,
      rerankEnabled: false,
      memoryBoxesEnabled: false,
      traceWeaverEnabled: false,
      threadingEnabled: false,
      factDeduplicationEnabled: false,
      knowledgeIndexEnabled: false,
      entityRetrievalEnabled: false,
      verifiedRecallEnabled: false,
      queryAwareIndexingEnabled: false,
      contradictionDetectionEnabled: false,
      memoryLinkingEnabled: false,
      topicExtractionEnabled: false,
      chunkingEnabled: true,
      episodeNoteModeEnabled: false,
      ...overrides,
    }),
  );

  await orchestrator.initialize();
  if (!orchestrator.lcmEngine) {
    throw new Error("Remnic benchmark adapter requires LCM to be enabled.");
  }

  return { tempDir, orchestrator };
}

function createAdapterFactory(mode: "lightweight" | "direct") {
  return async function createAdapter(
    options: RemnicAdapterOptions = {},
  ): Promise<BenchMemoryAdapter> {
    let state = await createBenchOrchestrator(mode, options.configOverrides);

    const getEngine = () => {
      const engine = state.orchestrator.lcmEngine;
      if (!engine) {
        throw new Error("LCM engine unavailable for Remnic benchmark adapter.");
      }
      return engine;
    };

    const cleanup = async (): Promise<void> => {
      state.orchestrator.lcmEngine?.close();
      await rm(state.tempDir, { recursive: true, force: true });
    };

    const rebuild = async (): Promise<void> => {
      await cleanup();
      state = await createBenchOrchestrator(mode, options.configOverrides);
    };

    return {
      async store(sessionId: string, messages: Message[]): Promise<void> {
        await getEngine().observeMessages(
          sessionId,
          messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        );
      },

      async recall(sessionId: string, query: string, budgetChars?: number): Promise<string> {
        const engine = getEngine();
        const budget = budgetChars ?? 32000;
        const sections: string[] = [];

        if (query) {
          const searchResults = await engine.searchContextFull(query, 20, sessionId);
          if (searchResults.length > 0) {
            sections.push(
              `## Search results\n${searchResults
                .map((result) => `[turn ${result.turn_index}, ${result.role}]: ${result.content}`)
                .join("\n\n")}`,
            );
          }
        }

        const recallText = await engine.assembleRecall(sessionId, budget);
        if (recallText) {
          sections.push(recallText);
        }

        if (sections.length === 0) {
          const stats = await engine.getStats(sessionId);
          if (stats.totalMessages > 0) {
            const expanded = await engine.expandContext(
              sessionId,
              0,
              stats.totalMessages - 1,
              Math.floor(budget / 4),
            );
            if (expanded.length > 0) {
              sections.push(
                `## Raw messages\n${expanded
                  .map((message) => `[${message.role}]: ${message.content}`)
                  .join("\n")}`,
              );
            }
          }
        }

        const joined = sections.join("\n\n");
        return joined.length > budget ? joined.slice(0, budget) : joined;
      },

      async search(query: string, limit: number, sessionId?: string): Promise<SearchResult[]> {
        const results = await getEngine().searchContext(query, limit, sessionId);
        return results.map((result) => ({
          turnIndex: result.turn_index,
          role: result.role,
          snippet: result.snippet,
          sessionId: result.session_id,
        }));
      },

      async reset(_sessionId?: string): Promise<void> {
        await rebuild();
      },

      async getStats(sessionId?: string): Promise<MemoryStats> {
        return getEngine().getStats(sessionId);
      },

      async destroy(): Promise<void> {
        await cleanup();
      },
    };
  };
}

export const createLightweightAdapter = createAdapterFactory("lightweight");
export const createRemnicAdapter = createAdapterFactory("direct");
