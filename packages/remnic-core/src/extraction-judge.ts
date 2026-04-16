/**
 * Extraction Judge — LLM-as-judge fact-worthiness gate (issue #376).
 *
 * Evaluates extracted facts against a durability rubric before they are
 * persisted. Facts that are unlikely to be useful 30+ days from now or
 * across sessions are rejected (or shadow-logged depending on config).
 *
 * Design constraints:
 *   - Corrections and principles are auto-approved (safety bypass).
 *   - Critical-importance facts are auto-approved.
 *   - Batches respect extractionJudgeBatchSize.
 *   - Content-hash caching avoids redundant LLM calls.
 *   - Performance budget: <= 1.5s per batch.
 */

import { createHash } from "node:crypto";
import { log } from "./logger.js";
import type { PluginConfig, ImportanceLevel } from "./types.js";
import type { LocalLlmClient } from "./local-llm.js";
import type { FallbackLlmClient } from "./fallback-llm.js";
import { extractJsonCandidates } from "./json-extract.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface JudgeCandidate {
  text: string;
  category: string;
  confidence: number;
  tags?: string[];
  /** Local importance level, set by caller before judging. */
  importanceLevel?: ImportanceLevel;
}

export interface JudgeVerdict {
  durable: boolean;
  reason: string;
}

export interface JudgeBatchResult {
  verdicts: Map<number, JudgeVerdict>;
  /** Number of verdicts served from cache. */
  cached: number;
  /** Number of verdicts produced by an LLM call. */
  judged: number;
  /** Total wall-clock time in milliseconds. */
  elapsed: number;
}

// ---------------------------------------------------------------------------
// Prompt (embedded; mirrors prompts/extraction_judge.prompt.md)
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are a memory curator evaluating whether extracted facts are **durable** — worth storing for long-term recall across sessions.

A fact is **durable** if it will still be useful 30+ days from now and is relevant across multiple sessions, not just the current task.

DURABLE examples (approve):
- Personal preferences, identities, or relationships
- Decisions with rationale that affect future work
- Corrections to previously held beliefs
- Principles, rules, or constraints the user wants respected
- Stable facts about projects, tools, or workflows
- Commitments, deadlines, or obligations

NOT DURABLE examples (reject):
- Transient task details ("currently debugging line 42")
- Ephemeral state ("the build is running now")
- Routine operations ("ran npm install")
- Conversational filler or acknowledgements
- Information that will be stale within hours
- Step-by-step instructions for a one-time task

Return a JSON array of objects with these fields:
- index: number (the candidate index)
- durable: boolean (true if the fact is durable)
- reason: string (brief explanation)

Rules:
1. Return exactly one verdict per input candidate, matched by index.
2. The reason field must be a short phrase (under 80 characters).
3. When in doubt lean toward durable — false negatives are worse than false positives.
4. Output valid JSON only. No markdown fences, no commentary.

Example output:
[{"index": 0, "durable": true, "reason": "Stable personal preference"}, {"index": 1, "durable": false, "reason": "Ephemeral build status"}]`;

// ---------------------------------------------------------------------------
// Content-hash cache (in-memory, per-process fallback)
// ---------------------------------------------------------------------------

/** Maximum entries before evicting the oldest half. */
const VERDICT_CACHE_MAX_SIZE = 10_000;

/** Module-level fallback cache, used when callers do not pass their own. */
const defaultVerdictCache = new Map<string, JudgeVerdict>();

function cacheKey(text: string, category: string): string {
  return createHash("sha256").update(`${text}\0${category}`).digest("hex");
}

/**
 * Enforce the max-size invariant on a verdict cache. When the cache exceeds
 * VERDICT_CACHE_MAX_SIZE, the oldest half of entries are deleted (Map
 * iteration order is insertion order).
 */
function enforceMaxCacheSize(cache: Map<string, JudgeVerdict>): void {
  if (cache.size <= VERDICT_CACHE_MAX_SIZE) return;
  const deleteCount = Math.floor(cache.size / 2);
  let deleted = 0;
  for (const key of cache.keys()) {
    if (deleted >= deleteCount) break;
    cache.delete(key);
    deleted++;
  }
}

// ---------------------------------------------------------------------------
// Categories that bypass the judge (safety / correctness)
// ---------------------------------------------------------------------------

const AUTO_APPROVE_CATEGORIES = new Set(["correction", "principle"]);

// ---------------------------------------------------------------------------
// Core judge function
// ---------------------------------------------------------------------------

/**
 * Evaluate a batch of candidate facts for durability.
 *
 * Auto-approves corrections, principles, and critical-importance facts.
 * Remaining candidates are batched (up to extractionJudgeBatchSize),
 * checked against an in-memory content-hash cache, and sent to the LLM
 * for verdict.
 */
export async function judgeFactDurability(
  candidates: JudgeCandidate[],
  config: PluginConfig,
  localLlm: LocalLlmClient | null,
  fallbackLlm: FallbackLlmClient | null,
  cache?: Map<string, JudgeVerdict>,
): Promise<JudgeBatchResult> {
  const startMs = Date.now();
  const verdicts = new Map<number, JudgeVerdict>();
  let cached = 0;
  let judged = 0;

  // Use caller-provided cache for per-orchestrator scoping, or fall back
  // to the module-level default cache.
  const verdictCache = cache ?? defaultVerdictCache;

  if (candidates.length === 0) {
    return { verdicts, cached, judged, elapsed: 0 };
  }

  // Indices that need LLM judgment
  const pendingIndices: number[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];

    // Auto-approve safety categories
    if (AUTO_APPROVE_CATEGORIES.has(c.category)) {
      verdicts.set(i, {
        durable: true,
        reason: `Auto-approved: ${c.category} category bypasses judge`,
      });
      continue;
    }

    // Auto-approve critical importance
    if (c.importanceLevel === "critical") {
      verdicts.set(i, {
        durable: true,
        reason: "Auto-approved: critical importance",
      });
      continue;
    }

    // Check cache
    const key = cacheKey(c.text, c.category);
    const cachedVerdict = verdictCache.get(key);
    if (cachedVerdict) {
      verdicts.set(i, cachedVerdict);
      cached++;
      continue;
    }

    pendingIndices.push(i);
  }

  // If all resolved without LLM, return early
  if (pendingIndices.length === 0) {
    return { verdicts, cached, judged, elapsed: Date.now() - startMs };
  }

  // Batch the pending candidates up to batchSize
  const batchSize = config.extractionJudgeBatchSize;
  for (let batchStart = 0; batchStart < pendingIndices.length; batchStart += batchSize) {
    const batchIndices = pendingIndices.slice(batchStart, batchStart + batchSize);
    const batchPayload = batchIndices.map((idx) => ({
      index: idx,
      text: candidates[idx].text,
      category: candidates[idx].category,
      confidence: candidates[idx].confidence,
    }));

    const userPrompt = JSON.stringify(batchPayload);

    try {
      const llmResponse = await callJudgeLlm(
        userPrompt,
        config,
        localLlm,
        fallbackLlm,
      );

      if (llmResponse) {
        const parsed = parseJudgeResponse(llmResponse, batchIndices);
        for (const [idx, verdict] of parsed.entries()) {
          verdicts.set(idx, verdict);
          judged++;
          // Cache the verdict
          const c = candidates[idx];
          verdictCache.set(cacheKey(c.text, c.category), verdict);
        }
        // Evict oldest entries if cache exceeds max size
        enforceMaxCacheSize(verdictCache);
      }
    } catch (err) {
      // Fail-open: if the LLM call fails, approve all candidates in this batch
      log.warn(
        `extraction-judge: LLM call failed, approving batch (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Fill in any missing verdicts from this batch (fail-open: approve)
    for (const idx of batchIndices) {
      if (!verdicts.has(idx)) {
        verdicts.set(idx, {
          durable: true,
          reason: "Approved by default (judge unavailable or parse error)",
        });
      }
    }
  }

  return { verdicts, cached, judged, elapsed: Date.now() - startMs };
}

// ---------------------------------------------------------------------------
// LLM call helpers
// ---------------------------------------------------------------------------

async function callJudgeLlm(
  userPrompt: string,
  config: PluginConfig,
  localLlm: LocalLlmClient | null,
  fallbackLlm: FallbackLlmClient | null,
): Promise<string | null> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const modelOverride = config.extractionJudgeModel || undefined;

  // When modelSource is "gateway", skip localLlm and go directly to fallback
  // (the gateway-routed backend). This respects the operator's explicit
  // routing preference.
  const skipLocal = config.modelSource === "gateway";

  // Try local LLM first (unless modelSource says gateway)
  if (localLlm && !skipLocal) {
    try {
      const result = await (localLlm as any).chatCompletion(messages, {
        temperature: 0.1,
        maxTokens: 2048,
        responseFormat: { type: "json_object" },
        timeoutMs: 1500,
        operation: "extraction-judge",
        ...(modelOverride ? { model: modelOverride } : {}),
      });
      if (result?.content) {
        return result.content;
      }
    } catch (err) {
      log.debug(
        `extraction-judge: local LLM failed, trying fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Try fallback LLM
  if (fallbackLlm) {
    try {
      const result = await fallbackLlm.chatCompletion(
        messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
        {
          temperature: 0.1,
          maxTokens: 2048,
          timeoutMs: 1500,
          ...(modelOverride ? { model: modelOverride } : {}),
        },
      );
      if (result?.content) {
        return result.content;
      }
    } catch (err) {
      log.debug(
        `extraction-judge: fallback LLM failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseJudgeResponse(
  raw: string,
  expectedIndices: number[],
): Map<number, JudgeVerdict> {
  const result = new Map<number, JudgeVerdict>();
  const expectedSet = new Set(expectedIndices);

  try {
    // Try direct parse first, then fall back to JSON extraction
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const candidates = extractJsonCandidates(raw);
      if (candidates.length > 0) {
        parsed = JSON.parse(candidates[0]);
      }
    }

    if (!Array.isArray(parsed)) {
      // Might be wrapped in an object with a key
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const values = Object.values(parsed as Record<string, unknown>);
        for (const v of values) {
          if (Array.isArray(v)) {
            parsed = v;
            break;
          }
        }
      }
      if (!Array.isArray(parsed)) {
        log.debug("extraction-judge: response is not an array, cannot parse");
        return result;
      }
    }

    for (const item of parsed) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof (item as any).index !== "number"
      ) {
        continue;
      }
      const idx = (item as any).index as number;
      if (!expectedSet.has(idx)) continue;

      const durable =
        typeof (item as any).durable === "boolean"
          ? (item as any).durable
          : true; // fail-open
      const reason =
        typeof (item as any).reason === "string"
          ? ((item as any).reason as string).slice(0, 120)
          : "No reason provided";

      result.set(idx, { durable, reason });
    }
  } catch (err) {
    log.debug(
      `extraction-judge: failed to parse response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Cache management (exposed for testing)
// ---------------------------------------------------------------------------

/** Clear the in-memory default verdict cache. Primarily for tests. */
export function clearVerdictCache(): void {
  defaultVerdictCache.clear();
}

/** Return the current default verdict cache size. Primarily for tests. */
export function verdictCacheSize(): number {
  return defaultVerdictCache.size;
}

/** Create a new per-instance verdict cache. Orchestrators should hold one. */
export function createVerdictCache(): Map<string, JudgeVerdict> {
  return new Map();
}
