/**
 * @engram/bench — Public types
 *
 * Retrieval latency ladder:
 *   Tier 0 — exact match (skip full search)
 *   Tier 1 — keyword / category overlap
 *   Tier 2 — high-confidence facts
 *   Tier 3 — semantic vector search
 *   Tier 4 — full retrieval pipeline
 */

// ── Tiers ──────────────────────────────────────────────────────────────────────

export type BenchTier =
  | "exact_match"
  | "category_match"
  | "keyword_overlap"
  | "high_confidence"
  | "semantic_search"
  | "full_search"
  | "no_results";

// ── Per-tier detail ────────────────────────────────────────────────────────────

export interface TierDetail {
  tier: BenchTier;
  latencyMs: number;
  resultsCount: number;
}

// ── Explain result (single query) ──────────────────────────────────────────────

export interface ExplainResult {
  query: string;
  tiersUsed: BenchTier[];
  tierResults: TierDetail[];
  durationMs: number;
  totalDurationMs: number;
}

// ── Recall metrics (single query, possibly iterated) ───────────────────────────

export interface RecallMetrics {
  query: string;
  latencyMs: number;
  tiersUsed: BenchTier[];
  throughput: number;
  resultsCount: number;
  totalDurationMs: number;
  tierDetails: TierDetail[];
}

// ── Benchmark suite result ─────────────────────────────────────────────────────

export interface BenchmarkReport {
  timestamp: string;
  queries: Array<{
    query: string;
    tiersUsed: BenchTier[];
    durationMs: number;
    resultsCount: number;
    throughput: number;
    tierDetails: TierDetail[];
  }>;
  totalDurationMs: number;
}

export interface BenchmarkSuiteResult {
  results: RecallMetrics[];
  report: BenchmarkReport;
  totalDurationMs: number;
  regressions: RegressionDetail[];
}

// ── Baseline & regression ──────────────────────────────────────────────────────

export interface SavedBaseline {
  version: number;
  timestamp: string;
  metrics: Record<string, number>;
}

export interface RegressionGateResult {
  passed: boolean;
  regressions: RegressionDetail[];
}

export interface RegressionDetail {
  metric: string;
  currentValue: number;
  baselineValue: number;
  tolerance: number;
  passed: boolean;
}

// ── Config ─────────────────────────────────────────────────────────────────────

export interface BenchConfig {
  queries?: string[];
  iterations?: number;
  regressionTolerance?: number;
  baselinePath?: string;
  reportPath?: string;
  seed?: number;
  explain?: boolean;
}
