/**
 * Package-owned Remnic adapters used by the phase-1 benchmark CLI surface.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildEvidencePack, Orchestrator, parseConfig } from "@remnic/core";
import type {
  BenchJudge,
  BenchMemoryAdapter,
  BenchResponder,
  MemoryStats,
  Message,
  SearchResult,
} from "./types.js";
import { DEFAULT_BENCH_RECALL_BUDGET_CHARS } from "../recall-budget.js";

export interface RemnicAdapterOptions {
  configOverrides?: Record<string, unknown>;
  preserveRuntimeDefaults?: boolean;
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

type OrchestratorTeardownView = {
  abortDeferredInit(): void;
  deferredReady: Promise<void>;
  lcmEngine: { close(): void } | null;
  qmd: { dispose?(): void | Promise<void> };
  qmdMaintenanceTimer?: NodeJS.Timeout | null;
  qmdMaintenancePending?: boolean;
  qmdMaintenanceInFlight?: boolean;
};

const BENCH_TEARDOWN_DEFERRED_READY_WAIT_MS = 500;
const EXACT_REFERENCE_MAX_CHARS = 18_000;
const EXACT_REFERENCE_MAX_ITEM_CHARS = 2_400;
const EXACT_REFERENCE_MAX_NUMBERS = 24;
const EXACT_REFERENCE_SCAN_TOKEN_LIMIT = EXACT_REFERENCE_MAX_NUMBERS * 3;
const EXACT_REFERENCE_WINDOW_RADIUS = 0;

type BenchLcmExpansionEngine = {
  getStats(sessionId?: string): Promise<{ totalMessages: number }>;
  expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>>;
};

type ExplicitSessionReference = {
  number: number;
  includeDirectTurn: boolean;
};

function cloneBenchConfig(config: Record<string, unknown>): Record<string, unknown> {
  return cloneBenchConfigValue(config) as Record<string, unknown>;
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
  options: { preserveRuntimeDefaults?: boolean } = {},
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

  if (options.preserveRuntimeDefaults === true) {
    return cloneBenchConfig({
      ...baseConfig,
      ...overrides,
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
  preserveRuntimeDefaults = false,
): Promise<{ tempDir: string; orchestrator: Orchestrator }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), `remnic-bench-${mode}-`));
  await mkdir(path.join(tempDir, "state"), { recursive: true });

  const commonConfig: BenchAdapterBaseConfig = {
    memoryDir: tempDir,
    workspaceDir: tempDir,
    lcmEnabled: true,
  };

  const orchestrator = new Orchestrator(
    parseConfig(
      buildBenchAdapterConfig(mode, commonConfig, overrides, {
        preserveRuntimeDefaults,
      }),
    ),
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
    const useCoreMemoryPipeline = shouldUseCoreMemoryPipeline(mode, options);
    let state = await createBenchOrchestrator(
      mode,
      options.configOverrides,
      options.preserveRuntimeDefaults === true,
    );
    const sessionTurnCounters = new Map<string, number>();

    const getEngine = () => {
      const engine = state.orchestrator.lcmEngine;
      if (!engine) {
        throw new Error("LCM engine unavailable for Remnic benchmark adapter.");
      }
      return engine;
    };

    const cleanup = async (): Promise<void> => {
      const orchestrator = state.orchestrator as unknown as OrchestratorTeardownView;

      orchestrator.abortDeferredInit();
      if (orchestrator.qmdMaintenanceTimer) {
        clearTimeout(orchestrator.qmdMaintenanceTimer);
      }
      orchestrator.qmdMaintenanceTimer = null;
      orchestrator.qmdMaintenancePending = false;
      orchestrator.qmdMaintenanceInFlight = false;
      await Promise.race([
        orchestrator.deferredReady.catch(() => undefined),
        new Promise((resolve) =>
          setTimeout(resolve, BENCH_TEARDOWN_DEFERRED_READY_WAIT_MS),
        ),
      ]);
      await orchestrator.qmd.dispose?.();
      orchestrator.lcmEngine?.close();
      await rm(state.tempDir, { recursive: true, force: true });
    };

    const rebuild = async (): Promise<void> => {
      await cleanup();
      state = await createBenchOrchestrator(
        mode,
        options.configOverrides,
        options.preserveRuntimeDefaults === true,
      );
      sessionTurnCounters.clear();
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

        if (!useCoreMemoryPipeline || messages.length === 0) {
          return;
        }

        const batchStartMs = Date.now();
        const conversationalMessages = messages.filter(
          (message): message is Message & { role: "user" | "assistant" } =>
            message.role === "user" || message.role === "assistant",
        );
        const replayTurns = conversationalMessages.map((message, index) => ({
          source: "openclaw" as const,
          role: message.role,
          content: message.content,
          timestamp: new Date(batchStartMs + index).toISOString(),
          sessionKey: sessionId,
        }));

        for (const turn of replayTurns) {
          const turnId = nextBenchTranscriptTurnId(
            sessionTurnCounters,
            sessionId,
            turn,
          );
          await state.orchestrator.transcript.append({
            timestamp: turn.timestamp,
            role: turn.role,
            content: turn.content,
            sessionKey: sessionId,
            turnId,
          });
        }

        await state.orchestrator.ingestReplayBatch(replayTurns);
      },

      async recall(sessionId: string, query: string, budgetChars?: number): Promise<string> {
        const engine = getEngine();
        const budget = budgetChars ?? DEFAULT_BENCH_RECALL_BUDGET_CHARS;
        if (budget <= 0) {
          return "";
        }

        const sections: string[] = [];
        let usedChars = 0;

        const exactReferenceEvidence = await buildExactSessionReferenceEvidence(
          engine,
          sessionId,
          query,
          Math.min(EXACT_REFERENCE_MAX_CHARS, Math.floor(budget * 0.4)),
        );
        if (exactReferenceEvidence) {
          sections.push(exactReferenceEvidence);
          usedChars += exactReferenceEvidence.length;
        }

        if (useCoreMemoryPipeline) {
          const coreBudget = Math.max(
            0,
            Math.min(
              Math.floor(budget * 0.55),
              Math.floor((budget - usedChars) * 0.7),
            ),
          );
          const coreRecall = await state.orchestrator.recall(query, sessionId, {
            budgetCharsOverride: coreBudget,
            mode: "full",
          });
          if (coreRecall.trim().length > 0) {
            const section = `## Remnic recall pipeline\n${coreRecall.trim()}`;
            sections.push(section);
            usedChars += section.length;
          }
        }

        if (query) {
          const remainingAfterCore = Math.max(0, budget - usedChars);
          const searchBudget = useCoreMemoryPipeline
            ? Math.max(0, Math.floor(remainingAfterCore * 0.75))
            : Math.max(0, Math.floor(remainingAfterCore * 0.7));
          const searchLimit = Math.max(6, Math.min(18, Math.floor(budget / 2_000)));
          const searchResults = await engine.searchContextFull(
            query,
            searchLimit,
            sessionId,
          );
          if (searchResults.length > 0) {
            const evidenceItems: Array<{
              id: string;
              sessionId: string;
              turnIndex: number;
              role: string;
              content: string;
              score?: number;
            }> = [];
            const seenTurns = new Set<string>();

            for (const result of searchResults) {
              const windowRadius = useCoreMemoryPipeline ? 3 : 1;
              const fromTurn = Math.max(0, result.turn_index - windowRadius);
              const toTurn = result.turn_index + windowRadius;
              const expanded = await engine.expandContext(
                result.session_id,
                fromTurn,
                toTurn,
                useCoreMemoryPipeline ? 1_600 : 600,
              );

              if (expanded.length === 0) {
                const id = `${result.session_id}:${result.turn_index}`;
                if (!seenTurns.has(id)) {
                  seenTurns.add(id);
                  evidenceItems.push({
                    id,
                    sessionId: result.session_id,
                    turnIndex: result.turn_index,
                    role: result.role,
                    content: result.content,
                    ...(typeof result.score === "number"
                      ? { score: result.score }
                      : {}),
                  });
                }
                continue;
              }

              for (const message of expanded) {
                const id = `${result.session_id}:${message.turn_index}`;
                if (seenTurns.has(id)) continue;
                seenTurns.add(id);
                evidenceItems.push({
                  id,
                  sessionId: result.session_id,
                  turnIndex: message.turn_index,
                  role: message.role,
                  content: message.content,
                  ...(message.turn_index === result.turn_index &&
                  typeof result.score === "number"
                    ? { score: result.score }
                    : {}),
                });
              }
            }

            const searchEvidence = buildEvidencePack(evidenceItems, {
              title: "Search evidence",
              maxChars: searchBudget,
              maxItemChars: 900,
            });
            if (searchEvidence) {
              sections.push(searchEvidence);
              usedChars += searchEvidence.length;
            }
          }
        }

        const summaryBudget = Math.max(0, budget - usedChars - 4);
        const recallText = await engine.assembleRecall(sessionId, summaryBudget);
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

      async drain(): Promise<void> {
        const DRAIN_TIMEOUT_MS = 5 * 60_000;
        const engine = getEngine();
        const abortController = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((_, reject) => {
          timer = setTimeout(() => {
            abortController.abort();
            reject(new Error("drain() timed out after 5 minutes"));
          }, DRAIN_TIMEOUT_MS);
        });
        try {
          await Promise.race([
            (async () => {
              const [, extractionIdle, consolidationIdle] = await Promise.all([
                engine.waitForObserveQueueIdle(),
                state.orchestrator.waitForExtractionIdle(DRAIN_TIMEOUT_MS),
                state.orchestrator.waitForConsolidationIdle(DRAIN_TIMEOUT_MS),
              ]);
              if (!extractionIdle) {
                throw new Error("drain() timed out waiting for extraction idle");
              }
              if (!consolidationIdle) {
                throw new Error("drain() timed out waiting for consolidation idle");
              }
            })().catch((err: unknown) => {
              if (abortController.signal.aborted) return;
              throw err;
            }),
            timeout,
          ]);
        } finally {
          clearTimeout(timer);
        }
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

function shouldUseCoreMemoryPipeline(
  mode: BenchAdapterMode,
  options: RemnicAdapterOptions,
): boolean {
  if (mode === "lightweight") {
    return false;
  }

  if (options.preserveRuntimeDefaults === true) {
    return true;
  }

  const overrides = options.configOverrides ?? {};
  return [
    "qmdEnabled",
    "qmdColdTierEnabled",
    "transcriptEnabled",
    "hourlySummariesEnabled",
    "daySummaryEnabled",
    "identityEnabled",
    "entityRetrievalEnabled",
    "knowledgeIndexEnabled",
    "verifiedRecallEnabled",
    "memoryBoxesEnabled",
    "traceWeaverEnabled",
    "episodeNoteModeEnabled",
    "queryAwareIndexingEnabled",
    "nativeKnowledge",
  ].some((key) => {
    const value = overrides[key];
    if (key === "nativeKnowledge") {
      return !!value
        && typeof value === "object"
        && !Array.isArray(value)
        && (value as { enabled?: unknown }).enabled === true;
    }
    return value === true;
  });
}

function nextBenchTranscriptTurnId(
  counters: Map<string, number>,
  sessionId: string,
  message: Message,
): string {
  const index = counters.get(sessionId) ?? 0;
  counters.set(sessionId, index + 1);
  const digest = createHash("sha256")
    .update(`${sessionId}\n${index}\n${message.role}\n${message.content}`)
    .digest("hex")
    .slice(0, 16);
  return `bench-${index}-${digest}`;
}

async function buildExactSessionReferenceEvidence(
  engine: BenchLcmExpansionEngine,
  sessionId: string,
  query: string,
  maxChars: number,
): Promise<string> {
  if (maxChars <= 0 || !query.trim()) {
    return "";
  }

  const references = collectExplicitSessionReferences(query);
  if (references.length === 0) {
    return "";
  }

  const stats = await engine.getStats(sessionId);
  if (stats.totalMessages <= 0) {
    return "";
  }

  const windows = new Map<string, { fromTurn: number; toTurn: number }>();
  for (const reference of references.slice(0, EXACT_REFERENCE_MAX_NUMBERS)) {
    for (const center of candidateTurnIndexesForReference(reference)) {
      if (center < 0 || center >= stats.totalMessages) {
        continue;
      }

      const fromTurn = Math.max(0, center - EXACT_REFERENCE_WINDOW_RADIUS);
      const toTurn = Math.min(
        stats.totalMessages - 1,
        center + EXACT_REFERENCE_WINDOW_RADIUS,
      );
      windows.set(`${fromTurn}:${toTurn}`, { fromTurn, toTurn });
    }
  }

  const evidenceItems: Array<{
    id: string;
    sessionId: string;
    turnIndex: number;
    role: string;
    content: string;
  }> = [];
  const seenTurns = new Set<string>();

  for (const window of [...windows.values()].sort(
    (left, right) => left.fromTurn - right.fromTurn || left.toTurn - right.toTurn,
  )) {
    const expanded = await engine.expandContext(
      sessionId,
      window.fromTurn,
      window.toTurn,
      2_000,
    );

    for (const message of expanded) {
      const id = `${sessionId}:${message.turn_index}`;
      if (seenTurns.has(id)) {
        continue;
      }
      seenTurns.add(id);
      evidenceItems.push({
        id,
        sessionId,
        turnIndex: message.turn_index,
        role: message.role,
        content: message.content,
      });
    }
  }

  return buildEvidencePack(evidenceItems, {
    title: "Exact session reference evidence",
    maxChars,
    maxItemChars: EXACT_REFERENCE_MAX_ITEM_CHARS,
  });
}

function collectExplicitSessionReferences(query: string): ExplicitSessionReference[] {
  const references = new Map<string, ExplicitSessionReference>();
  const addReference = (value: string | undefined, label: string) => {
    if (value === undefined) return;
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      const existing = references.get(String(parsed));
      references.set(String(parsed), {
        number: parsed,
        includeDirectTurn:
          (existing?.includeDirectTurn ?? false) || label === "turn",
      });
    }
  };

  const tokens = tokenizeReferenceQuery(query);
  for (let index = 0; index < tokens.length; index += 1) {
    const label = normalizeReferenceLabel(tokens[index]);
    if (!label) {
      continue;
    }

    const parsed = parseReferenceNumbers(tokens, index + 1);
    for (const number of parsed.numbers) {
      addReference(String(number), label);
    }
    index = Math.max(index, parsed.nextIndex - 1);
  }

  return [...references.values()].sort((left, right) => left.number - right.number);
}

function tokenizeReferenceQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";

  const flushCurrent = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };

  for (const char of query) {
    if (isAsciiLetterOrDigit(char)) {
      current += char;
    } else {
      flushCurrent();
      if (char === "#" || char === ",") {
        tokens.push(char);
      } else if (isReferenceDash(char)) {
        tokens.push("-");
      }
    }
  }
  flushCurrent();

  return tokens;
}

function parseReferenceNumbers(
  tokens: readonly string[],
  startIndex: number,
): { numbers: number[]; nextIndex: number } {
  const numbers: number[] = [];
  let lastNumber: number | undefined;
  let pendingRangeStart: number | undefined;
  let index = startIndex;
  const scanEnd = Math.min(
    tokens.length,
    startIndex + EXACT_REFERENCE_SCAN_TOKEN_LIMIT,
  );

  for (; index < scanEnd; index += 1) {
    const token = tokens[index]!;
    const normalized = token.toLowerCase();
    const value = parseNonNegativeIntegerToken(token);
    if (value !== undefined) {
      if (pendingRangeStart !== undefined) {
        numbers.push(...expandReferenceRange(pendingRangeStart, value));
        pendingRangeStart = undefined;
      } else {
        numbers.push(value);
      }
      lastNumber = value;
      continue;
    }

    if (normalized === "#" || normalized === "number" || normalized === ",") {
      continue;
    }

    if (
      normalized === "-" ||
      normalized === "to" ||
      normalized === "through" ||
      normalized === "thru"
    ) {
      if (lastNumber !== undefined) {
        if (numbers[numbers.length - 1] === lastNumber) {
          numbers.pop();
        }
        pendingRangeStart = lastNumber;
      }
      continue;
    }

    if (normalized === "and" && numbers.length > 0) {
      continue;
    }

    if (normalizeReferenceLabel(token)) {
      break;
    }

    break;
  }

  if (pendingRangeStart !== undefined) {
    numbers.push(pendingRangeStart);
  }

  return {
    numbers: dedupeReferenceNumbers(numbers),
    nextIndex: index,
  };
}

function dedupeReferenceNumbers(numbers: readonly number[]): number[] {
  return [...new Set(numbers)];
}

function expandReferenceRange(start: number, end: number): number[] {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  if (high - low + 1 > EXACT_REFERENCE_MAX_NUMBERS) {
    return [start, end];
  }

  const values: number[] = [];
  for (let value = low; value <= high; value += 1) {
    values.push(value);
  }
  return values;
}

function normalizeReferenceLabel(token: string | undefined): string | undefined {
  const normalized = token?.toLowerCase();
  switch (normalized) {
    case "step":
    case "steps":
      return "step";
    case "turn":
    case "turns":
      return "turn";
    case "action":
    case "actions":
      return "action";
    case "observation":
    case "observations":
      return "observation";
    default:
      return undefined;
  }
}

function parseNonNegativeIntegerToken(token: string): number | undefined {
  if (token.length === 0) {
    return undefined;
  }

  let value = 0;
  for (const char of token) {
    const code = char.charCodeAt(0);
    if (code < 48 || code > 57) {
      return undefined;
    }
    value = value * 10 + (code - 48);
  }
  return value;
}

function isAsciiLetterOrDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

function isReferenceDash(char: string): boolean {
  return char === "-"
    || char === "\u2010"
    || char === "\u2011"
    || char === "\u2012"
    || char === "\u2013"
    || char === "\u2014"
    || char === "\u2015";
}

function candidateTurnIndexesForReference(
  reference: ExplicitSessionReference,
): number[] {
  const candidates = new Set<number>();
  if (reference.includeDirectTurn) {
    for (let offset = -1; offset <= 1; offset += 1) {
      candidates.add(reference.number + offset);
    }
  }

  const pairedBase = reference.number * 2;
  for (let offset = -2; offset <= 3; offset += 1) {
    candidates.add(pairedBase + offset);
  }

  return [...candidates].sort((left, right) => left - right);
}
