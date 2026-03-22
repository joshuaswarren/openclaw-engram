/**
 * Parallel Specialized Retrieval (v9.1 — ASMR-inspired)
 *
 * Replaces single-pass hybrid search with three parallel specialized agents:
 *
 *   1. DirectFactAgent  — entity-first lookup via entity filename index (<5ms)
 *   2. ContextualAgent  — existing hybridSearch (same cost as current single-pass)
 *   3. TemporalAgent    — temporal index prefilter + recency scoring (<10ms)
 *
 * All agents run via Promise.all(), so total latency = max(agents), not sum.
 * No new LLM inference is introduced — agents reuse existing search primitives.
 *
 * Graceful degradation: any agent error/timeout does not block the others.
 *
 * References:
 *   - Supermemory ASMR: https://blog.supermemory.ai/...
 *   - Spec: docs/ideas/parallel-specialized-retrieval.md
 */

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { log } from "./logger.js";
import type { QmdSearchResult } from "./types.js";
import type { QmdClient } from "./qmd.js";
import { recencyWindowFromPrompt } from "./temporal-index.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SearchAgentSource = "direct" | "contextual" | "temporal";

export interface ParallelSearchResult extends QmdSearchResult {
  /** Which retrieval agent produced this result. */
  agentSource: SearchAgentSource;
}

/** Source-based weights applied during merge. Higher = higher confidence/precision. */
export const PARALLEL_AGENT_WEIGHTS: Record<SearchAgentSource, number> = {
  direct: 1.0, // entity-first: high precision
  temporal: 0.85, // recency-boosted: relevant but broader
  contextual: 0.7, // semantic: broadest, lower precision
};

// ─── Query classification ────────────────────────────────────────────────────

/**
 * Decide whether a given agent should run for this query.
 * Agent 1 (direct) is the only one that may be skipped — when the query
 * contains no proper-noun-like tokens, entity lookups will return nothing.
 * Agents 2 (contextual) and 3 (temporal) always run.
 */
export function shouldRunAgent(
  agent: SearchAgentSource,
  query: string,
  knownEntityCount: number,
): boolean {
  switch (agent) {
    case "direct":
      // Skip if query has no entity-like tokens (proper nouns or count from external detection)
      return knownEntityCount > 0 || /\b[A-Z][a-zA-Z]{1,}/.test(query);
    case "temporal":
    case "contextual":
      // Temporal and contextual always run — temporal context is broadly useful and cheap (<10ms)
      return true;
    default:
      return true;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function overlapScore(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  const hits = queryTokens.filter((t) => candidateSet.has(t)).length;
  return hits / Math.max(queryTokens.length, candidateTokens.length);
}

// ─── Agent 1: Direct Facts ───────────────────────────────────────────────────

/**
 * Direct Facts Agent — entity-first retrieval.
 *
 * Reads entity filenames from the entities directory and scores them by
 * keyword overlap with the query. Returns matching entity file paths as
 * QmdSearchResult[]. Zero LLM inference; pure file I/O.
 *
 * Cost: readdir on entities/ + filename scoring. Typically <5ms.
 */
export async function runDirectAgent(
  query: string,
  memoryDir: string,
  maxResults = 10,
): Promise<ParallelSearchResult[]> {
  try {
    const entitiesDir = path.join(memoryDir, "entities");
    let entries: string[];
    try {
      entries = await readdir(entitiesDir);
    } catch {
      return []; // entities dir missing or unreadable — not an error
    }

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const results: ParallelSearchResult[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      // Filename tokens: split on hyphens (normalizeEntityName uses hyphens)
      const nameWithoutExt = entry.slice(0, -3);
      const entityTokens = nameWithoutExt.split("-").filter((t) => t.length >= 2);

      const score = overlapScore(queryTokens, entityTokens);
      if (score <= 0) continue;

      results.push({
        docid: nameWithoutExt,
        path: path.join(entitiesDir, entry),
        snippet: "", // populated by augmentWithDirectAndTemporal after merge
        score,
        transport: "scoped_prefilter",
        agentSource: "direct",
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  } catch (err) {
    log.debug(`DirectFactAgent error: ${err}`);
    return [];
  }
}

// ─── Agent 3: Temporal ───────────────────────────────────────────────────────

/**
 * Temporal Agent — recency-focused retrieval.
 *
 * Uses the temporal index (index_time.json) to find memories from the
 * recent time window derived from the query (default: last 7 days).
 * Combines recency decay with query-filename token overlap so results stay
 * relevant to the query content, not just recency. Zero LLM inference; File I/O + math.
 *
 * Cost: read index_time.json + date range scan. Typically <10ms.
 */
export async function runTemporalAgent(
  query: string,
  memoryDir: string,
  maxResults = 20,
): Promise<ParallelSearchResult[]> {
  try {
    // Read index_time.json once — used for both date-range filtering and recency scoring.
    let dateIndex: Record<string, string[]> = {};
    try {
      const indexPath = path.join(memoryDir, "state", "index_time.json");
      const raw = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as { dates?: Record<string, string[]> };
      dateIndex = parsed.dates ?? {};
    } catch {
      return []; // Index missing or unreadable — nothing to return
    }

    const fromDate = recencyWindowFromPrompt(query);
    const toDate = new Date().toISOString().slice(0, 10);
    const queryTokens = tokenize(query);

    // Build path → date map, filtering to the recency window in one pass
    const pathToDate = new Map<string, string>();
    for (const [date, datePaths] of Object.entries(dateIndex)) {
      if (date >= fromDate && date <= toDate) {
        for (const p of datePaths) {
          if (!pathToDate.has(p)) pathToDate.set(p, date);
        }
      }
    }

    if (pathToDate.size === 0) return [];

    const todayMs = Date.now();
    const results: ParallelSearchResult[] = [];

    for (const [p, dateStr] of pathToDate) {
      const ageMs = todayMs - new Date(dateStr).getTime();
      const ageDays = ageMs / 86_400_000;
      // Recency decay: score=1.0 on day 0, score=0.5 on day 7, score=0.2 floor on day 14+
      const recencyScore = Math.max(0.2, 1.0 - ageDays / 14);

      // Query relevance via filename token overlap — prevents unrelated recent memories
      // from ranking above query-relevant results when temporal weight is applied.
      const baseName = path.basename(p, ".md");
      const fileTokens = baseName.split(/[-_]/).filter((t) => t.length >= 2);
      const relevanceScore = queryTokens.length > 0 ? overlapScore(queryTokens, fileTokens) : 0;

      // Combine: 70% recency + 30% relevance (recency-primary with query grounding)
      const score = relevanceScore > 0
        ? recencyScore * 0.7 + relevanceScore * 0.3
        : recencyScore * 0.8; // penalize slightly when query has no filename overlap

      results.push({
        docid: baseName,
        path: p,
        snippet: "", // populated by augmentWithDirectAndTemporal after merge
        score,
        transport: "scoped_prefilter",
        agentSource: "temporal",
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  } catch (err) {
    log.debug(`TemporalAgent error: ${err}`);
    return [];
  }
}

// ─── Agent 2: Contextual ─────────────────────────────────────────────────────

/**
 * Contextual Agent — broad semantic/hybrid search.
 *
 * Delegates to the existing hybridSearch (BM25 + vector). Same cost as the
 * current single-pass retrieval — this agent introduces no additional LLM calls.
 */
export async function runContextualAgent(
  query: string,
  qmd: QmdClient,
  collection: string | undefined,
  maxResults: number,
  signal?: AbortSignal,
): Promise<ParallelSearchResult[]> {
  try {
    const results = await qmd.hybridSearch(
      query,
      collection,
      maxResults,
      signal ? { signal } : undefined,
    );
    return results.map((r: QmdSearchResult) => ({ ...r, agentSource: "contextual" as const }));
  } catch (err) {
    log.debug(`ContextualAgent error: ${err}`);
    return [];
  }
}

// ─── Merge helper ─────────────────────────────────────────────────────────────

/**
 * Merge results from multiple agents into a single deduplicated, weighted list.
 * Preserves snippets: if a higher-scoring result lacks a snippet, the existing
 * snippet from a lower-scoring source is retained.
 */
function mergeAgentResults(
  allResults: ParallelSearchResult[],
  weights: Record<SearchAgentSource, number>,
  maxResults: number,
): QmdSearchResult[] {
  const merged = new Map<string, QmdSearchResult>();
  for (const result of allResults) {
    const key = result.path || result.docid;
    const weightedScore = result.score * weights[result.agentSource];
    const existing = merged.get(key);
    if (!existing || weightedScore > existing.score) {
      merged.set(key, {
        docid: result.docid,
        path: result.path,
        // Preserve any snippet from the existing entry when the new one has none
        snippet: result.snippet || existing?.snippet || "",
        score: weightedScore,
        transport: "hybrid",
      });
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * For merged results that have an empty snippet, attempt to read the first
 * 200 characters of the file as a fallback preview. Bounded to MAX_SNIPPET_READS
 * to cap I/O when many specialized-agent results are present.
 */
const SNIPPET_PREVIEW_CHARS = 200;
const MAX_SNIPPET_READS = 8;

async function populateEmptySnippets(results: QmdSearchResult[]): Promise<QmdSearchResult[]> {
  const needsSnippet = results.filter((r) => !r.snippet && r.path);
  if (needsSnippet.length === 0) return results;

  const toRead = needsSnippet.slice(0, MAX_SNIPPET_READS);
  const snippetMap = new Map<string, string>();

  await Promise.all(
    toRead.map(async (r) => {
      try {
        const raw = await readFile(r.path, "utf-8");
        const preview = raw.slice(0, SNIPPET_PREVIEW_CHARS).replace(/\s+/g, " ").trim();
        if (preview) snippetMap.set(r.path, preview);
      } catch {
        // File unreadable — leave snippet empty
      }
    }),
  );

  if (snippetMap.size === 0) return results;
  return results.map((r) => (r.path && snippetMap.has(r.path) ? { ...r, snippet: snippetMap.get(r.path)! } : r));
}

// ─── Augmentation helper (used by orchestrator) ───────────────────────────────

/**
 * Augment a set of contextual (hybridSearch) results with direct and temporal
 * agent results, returning a merged, deduplicated list.
 *
 * This is the integration point for the orchestrator: the caller already ran
 * hybridSearch as the primary contextual pass. Direct and temporal agents run
 * in parallel, then all three are merged with configurable weights.
 *
 * Contextual weight is always applied to `contextualResults` so scoring is
 * consistent regardless of whether direct/temporal agents return anything.
 *
 * Snippets: snippets from contextual results are preserved during merge. For
 * results discovered only by direct/temporal agents (no contextual match),
 * the first ~200 chars of the file are read as a fallback preview so downstream
 * formatters and rerankers have content to work with, not just a path.
 *
 * v9.1 limitation: `memoryDir` is the storage root for the current namespace.
 * For multi-namespace deployments, only the active namespace's entities/ and
 * temporal index are scanned. Cross-namespace entity lookup is a future improvement.
 */
export async function augmentWithDirectAndTemporal(
  query: string,
  memoryDir: string,
  contextualResults: QmdSearchResult[],
  weights: Record<SearchAgentSource, number>,
  maxPerAgent: number,
  maxResults: number,
): Promise<QmdSearchResult[]> {
  const knownEntityCount = (query.match(/\b[A-Z][a-z]{1,}/g) ?? []).length;
  const runDirect = shouldRunAgent("direct", query, knownEntityCount);
  // Temporal always runs per spec (shouldRunAgent("temporal") always returns true)
  const runTemporal = shouldRunAgent("temporal", query, knownEntityCount);

  const startMs = Date.now();
  const [directResults, temporalResults] = await Promise.all([
    runDirect
      ? runDirectAgent(query, memoryDir, maxPerAgent).catch((err) => {
        log.debug(`augmentWithDirectAndTemporal: DirectAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
    runTemporal
      ? runTemporalAgent(query, memoryDir, maxPerAgent).catch((err) => {
        log.debug(`augmentWithDirectAndTemporal: TemporalAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
  ]);
  const durationMs = Date.now() - startMs;

  // Tag contextual results with their source so they can participate in weighted merge
  const contextualTagged: ParallelSearchResult[] = contextualResults.map((r) => ({
    ...r,
    agentSource: "contextual" as const,
  }));

  log.debug(
    `augmentWithDirectAndTemporal: direct=${directResults.length} temporal=${temporalResults.length} contextual=${contextualTagged.length} agentMs=${durationMs}ms`,
  );

  // Merge all three; contextual weight is applied consistently regardless of agent counts
  const merged = mergeAgentResults(
    [...contextualTagged, ...directResults, ...temporalResults],
    weights,
    maxResults,
  );

  // Populate snippets for results discovered only by direct/temporal (no contextual preview)
  return populateEmptySnippets(merged);
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export interface ParallelRetrievalOptions {
  collection?: string;
  maxResults?: number;
  signal?: AbortSignal;
  /** If true, skip the contextual agent (hybridSearch is already running externally). */
  skipContextual?: boolean;
  /** Max results per agent (capped before merge). */
  maxResultsPerAgent?: number;
}

/**
 * Run parallel specialized retrieval agents and merge results.
 *
 * When `skipContextual` is true, only the direct and temporal agents run.
 * This is the intended usage inside the orchestrator, where hybridSearch
 * already runs as the primary search — we augment with the cheap extra agents.
 *
 * Total latency = max(agent_latencies), not sum.
 * Agent errors are isolated — others still return results.
 */
export async function parallelRetrieval(
  query: string,
  qmd: QmdClient,
  memoryDir: string,
  options: ParallelRetrievalOptions = {},
): Promise<QmdSearchResult[]> {
  const maxResults = options.maxResults ?? 20;
  const maxPerAgent = options.maxResultsPerAgent ?? maxResults;
  const startMs = Date.now();

  // Rough entity detection: count proper-noun-like tokens in query
  const knownEntityCount = (query.match(/\b[A-Z][a-z]{1,}/g) ?? []).length;

  const runDirect = shouldRunAgent("direct", query, knownEntityCount);
  const runTemporal = shouldRunAgent("temporal", query, knownEntityCount);
  const runContextual = !options.skipContextual && shouldRunAgent("contextual", query, knownEntityCount);

  const [directResults, temporalResults, contextualResults] = await Promise.all([
    runDirect
      ? runDirectAgent(query, memoryDir, maxPerAgent).catch((err) => {
        log.debug(`parallelRetrieval: DirectAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
    runTemporal
      ? runTemporalAgent(query, memoryDir, maxPerAgent).catch((err) => {
        log.debug(`parallelRetrieval: TemporalAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
    runContextual
      ? runContextualAgent(query, qmd, options.collection, maxPerAgent, options.signal).catch((err) => {
        log.debug(`parallelRetrieval: ContextualAgent failed — ${err}`);
        return [] as ParallelSearchResult[];
      })
      : Promise.resolve([] as ParallelSearchResult[]),
  ]);

  const durationMs = Date.now() - startMs;
  log.debug(
    `parallelRetrieval: direct=${directResults.length} temporal=${temporalResults.length} contextual=${contextualResults.length} durationMs=${durationMs}ms`,
  );

  return mergeAgentResults(
    [...directResults, ...temporalResults, ...contextualResults],
    PARALLEL_AGENT_WEIGHTS,
    maxResults,
  );
}
