/**
 * Package-owned Remnic adapters used by the phase-1 benchmark CLI surface.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Orchestrator, parseConfig } from "@remnic/core";
import type {
  BenchJudge,
  BenchMemoryAdapter,
  BenchResponder,
  MemoryStats,
  Message,
  SearchResult,
} from "./types.js";

export interface RemnicAdapterOptions {
  configOverrides?: Record<string, unknown>;
  responder?: BenchResponder;
  judge?: BenchJudge;
}

type BenchAdapterMode = "lightweight" | "direct";

interface BenchAdapterBaseConfig {
  memoryDir: string;
  workspaceDir: string;
  lcmEnabled: true;
}

export const BENCH_ADAPTER_SHARED_CONFIG: Record<string, unknown> = {
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
  lcmLeafBatchSize: 4,
  lcmRollupFanIn: 3,
  lcmFreshTailTurns: 8,
  lcmMaxDepth: 4,
  lcmDeterministicMaxTokens: 512,
  lcmRecallBudgetShare: 1.0,
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
};

export const BENCH_ADAPTER_MODE_CONFIG: Record<BenchAdapterMode, Record<string, unknown>> = {
  direct: {
    extractionDedupeEnabled: true,
    extractionMinChars: 10,
    extractionMinUserTurns: 0,
    recallPlannerEnabled: true,
  },
  lightweight: {
    extractionDedupeEnabled: false,
    extractionMinChars: 1000000,
    extractionMinUserTurns: 1000000,
    recallPlannerEnabled: false,
  },
};

function cloneBenchConfig(config: Record<string, unknown>): Record<string, unknown> {
  return cloneBenchConfigValue(config);
}

function cloneBenchConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneBenchConfigValue(entry));
  }

  if (typeof value === "function") {
    return value;
  }

  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = cloneBenchConfigValue(entry);
    }
    return next;
  }

  return value;
}

export function buildBenchBaselineRemnicConfig(): Record<string, unknown> {
  return cloneBenchConfig({
    ...BENCH_ADAPTER_SHARED_CONFIG,
    ...BENCH_ADAPTER_MODE_CONFIG.direct,
    lcmEnabled: true,
  });
}

export function buildBenchAdapterConfig(
  mode: BenchAdapterMode,
  baseConfig: BenchAdapterBaseConfig,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const sandboxConfig = {
    memoryDir: baseConfig.memoryDir,
    workspaceDir: baseConfig.workspaceDir,
    lcmEnabled: baseConfig.lcmEnabled,
  };
  const modeConfig = {
    ...BENCH_ADAPTER_SHARED_CONFIG,
    ...BENCH_ADAPTER_MODE_CONFIG[mode],
  };

  if (mode === "lightweight") {
    return cloneBenchConfig({
      ...baseConfig,
      ...overrides,
      ...modeConfig,
      ...sandboxConfig,
    });
  }

  return cloneBenchConfig({
    ...baseConfig,
    ...modeConfig,
    ...overrides,
    ...sandboxConfig,
  });
}

async function createBenchOrchestrator(
  mode: BenchAdapterMode,
  overrides?: Record<string, unknown>,
): Promise<{ tempDir: string; orchestrator: Orchestrator }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), `remnic-bench-${mode}-`));
  await mkdir(path.join(tempDir, "state"), { recursive: true });

  const commonConfig: BenchAdapterBaseConfig = {
    memoryDir: tempDir,
    workspaceDir: tempDir,
    lcmEnabled: true,
  };

  const orchestrator = new Orchestrator(
    parseConfig(buildBenchAdapterConfig(mode, commonConfig, overrides)),
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

      responder: options.responder,
      judge: options.judge,
    };
  };
}

export const createLightweightAdapter = createAdapterFactory("lightweight");
export const createRemnicAdapter = createAdapterFactory("direct");
