/**
 * Contradiction Review Queue — storage for detected contradiction pairs (issue #520).
 *
 * Stores candidate pairs as JSON files under `memoryDir/.review/contradictions/`.
 * Pair IDs are deterministic (sha256 of sorted memory IDs) so reruns are idempotent.
 *
 * Lifecycle:
 *   - `contradicts` → awaiting user review
 *   - `duplicates` → auto-flagged for dedup (still needs user approval)
 *   - `independent` / `both-valid` → dormant with cooldown
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { log } from "../logger.js";
import type { ContradictionVerdict } from "./contradiction-judge.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ResolutionVerb = "keep-a" | "keep-b" | "merge" | "both-valid" | "needs-more-context";

export interface ContradictionPair {
  /** Deterministic pair ID: sha256(sorted(memoryIdA, memoryIdB)). */
  pairId: string;
  /** Memory IDs (sorted). */
  memoryIds: [string, string];
  /** Judge verdict. */
  verdict: ContradictionVerdict;
  /** Judge rationale. */
  rationale: string;
  /** Judge confidence in [0, 1]. */
  confidence: number;
  /** ISO timestamp when detected. */
  detectedAt: string;
  /** ISO timestamp when last reviewed by user. */
  lastReviewedAt?: string;
  /** Resolution verb applied by user. */
  resolution?: ResolutionVerb;
  /** Namespace scope. */
  namespace?: string;
}

export interface ContradictionListResult {
  pairs: ContradictionPair[];
  total: number;
  durationMs: number;
}

export type ContradictionFilter = ContradictionVerdict | "all" | "unresolved";

// ── Helpers ────────────────────────────────────────────────────────────────────

export function computePairId(memoryIdA: string, memoryIdB: string): string {
  const sorted = [memoryIdA, memoryIdB].sort();
  return createHash("sha256").update(sorted.join("::")).digest("hex").slice(0, 24);
}

function reviewDir(memoryDir: string): string {
  return path.join(memoryDir, ".review", "contradictions");
}

function pairPath(memoryDir: string, pairId: string): string {
  if (pairId.includes("/") || pairId.includes("\\") || pairId.includes("..")) {
    throw new Error(`Invalid pairId: ${pairId}`);
  }
  return path.join(reviewDir(memoryDir), `${pairId}.json`);
}

function ensureDir(memoryDir: string): void {
  const dir = reviewDir(memoryDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Write a contradiction pair to the review queue.
 * Idempotent: if the pair already exists with a higher or equal confidence,
 * the existing entry is preserved.
 */
export function writePair(memoryDir: string, pair: Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] }): ContradictionPair {
  ensureDir(memoryDir);
  const pairId = computePairId(pair.memoryIds[0], pair.memoryIds[1]);
  const existing = readPair(memoryDir, pairId);

  // Preserve user resolution if already reviewed
  if (existing?.resolution) {
    return existing;
  }

  // Preserve cooldown: don't overwrite a cooled-down entry with lower confidence
  if (existing && existing.confidence >= pair.confidence) {
    return existing;
  }

  const full: ContradictionPair = {
    ...pair,
    pairId,
    lastReviewedAt: existing?.lastReviewedAt,
    resolution: existing?.resolution,
  };

  const filePath = pairPath(memoryDir, pairId);
  const tmpPath = `${filePath}.tmp`;

  // Atomic write: temp then rename (rule 54)
  fs.writeFileSync(tmpPath, JSON.stringify(full, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);

  return full;
}

/**
 * Write multiple pairs, deduplicating inputs first (rule 49).
 */
export function writePairs(memoryDir: string, pairs: Array<Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] }>): ContradictionPair[] {
  const seen = new Set<string>();
  const results: ContradictionPair[] = [];

  for (const pair of pairs) {
    const key = computePairId(pair.memoryIds[0], pair.memoryIds[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(writePair(memoryDir, pair));
  }

  return results;
}

// ── Read ───────────────────────────────────────────────────────────────────────

/**
 * Read a single pair by ID. Returns null if not found.
 */
export function readPair(memoryDir: string, pairId: string): ContradictionPair | null {
  const filePath = pairPath(memoryDir, pairId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.memoryIds)) {
      return parsed as ContradictionPair;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List pairs in the review queue, optionally filtered by verdict.
 */
export function listPairs(
  memoryDir: string,
  options?: {
    filter?: ContradictionFilter;
    namespace?: string;
    limit?: number;
  },
): ContradictionListResult {
  const startTime = Date.now();
  const dir = reviewDir(memoryDir);
  const { filter = "all", namespace, limit = 50 } = options ?? {};
  const pairs: ContradictionPair[] = [];
  let total = 0;

  if (!fs.existsSync(dir)) {
    return { pairs: [], total: 0, durationMs: Date.now() - startTime };
  }

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;

    try {
      const raw = fs.readFileSync(path.join(dir, entry), "utf-8");
      const pair = JSON.parse(raw) as ContradictionPair;

      if (typeof pair !== "object" || pair === null) continue;
      if (!Array.isArray(pair.memoryIds)) continue;

      // Namespace filter
      if (namespace && pair.namespace !== namespace) continue;

      // Verdict filter
      if (filter === "unresolved") {
        if (pair.resolution) continue;
        if (pair.verdict === "independent") continue;
      } else if (filter !== "all" && pair.verdict !== filter) {
        continue;
      }

      total++;
      if (pairs.length < limit) pairs.push(pair);
    } catch {
      continue;
    }
  }

  return { pairs, total, durationMs: Date.now() - startTime };
}

// ── Cooldown ───────────────────────────────────────────────────────────────────

/**
 * Check if a pair is within its cooldown window.
 * Returns true if the pair should be SKIPPED (still cooling down).
 */
export function isCoolingDown(pair: ContradictionPair, cooldownDays: number): boolean {
  if (cooldownDays <= 0) return false; // rule 27: guard against 0
  if (!pair.lastReviewedAt) return false;

  const lastReviewed = new Date(pair.lastReviewedAt).getTime();
  if (!Number.isFinite(lastReviewed)) return false;

  const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
  return Date.now() < lastReviewed + cooldownMs;
}

/**
 * Mark a pair as reviewed (sets lastReviewedAt and resolution).
 */
export function resolvePair(
  memoryDir: string,
  pairId: string,
  verb: ResolutionVerb,
): ContradictionPair | null {
  const existing = readPair(memoryDir, pairId);
  if (!existing) return null;

  const updated: ContradictionPair = {
    ...existing,
    lastReviewedAt: new Date().toISOString(),
    resolution: verb,
  };

  const filePath = pairPath(memoryDir, pairId);
  const tmpPath = `${filePath}.tmp`;

  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);

  return updated;
}

/**
 * Check whether a pair's referenced memories have changed since detection,
 * which should override cooldown.
 */
export function memoryHashesChanged(
  _memoryDir: string,
  _pair: ContradictionPair,
  _getCurrentHash: (memoryId: string) => string | null,
): boolean {
  // Intentionally a stub for now — the full implementation would compare
  // content hashes stored at detection time with current hashes.
  return false;
}
