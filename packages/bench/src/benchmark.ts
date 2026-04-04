/**
 * @engram/bench — Benchmark runner
 *
 * Runs retrieval queries through the EngramAccessService recall() API
 * and measures latency per tier (exact → full search).
 */

import fs from "node:fs";
import path from "node:path";
import { EngramAccessService } from "@engram/core";
import type {
  BenchConfig,
  BenchTier,
  BenchmarkReport,
  BenchmarkSuiteResult,
  ExplainResult,
  RecallMetrics,
  RegressionDetail,
  RegressionGateResult,
  SavedBaseline,
  TierDetail,
} from "./types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_BASELINE_PATH = path.join(
  process.cwd(),
  "benchmarks",
  "baseline.json",
);
const DEFAULT_REPORT_PATH = path.join(
  process.cwd(),
  "benchmarks",
  "report.json",
);
const HIGH_CONF_THRESHOLD = 0.95;
const BASELINE_VERSION = 1;

const DEFAULT_QUERIES = [
  "What is the storage?",
  "How do I access storage?",
  "What categories exist?",
  "How is memory organized?",
  "What is the recall budget?",
  "What is the extraction pipeline?",
  "What facts are stored about the project?",
  "What is the architecture?",
];

const DEFAULT_TOLERANCE = 10; // 10 % regression tolerance

// ── Types for recall results ───────────────────────────────────────────────────

interface RecallMemory {
  id: string;
  content: string;
  category?: string;
  confidence?: number;
  frontmatter?: Record<string, unknown>;
}

interface RecallResponse {
  memories?: RecallMemory[];
  debug?: unknown;
  [key: string]: unknown;
}

// ── High-resolution timer ──────────────────────────────────────────────────────

function hrTimeMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1_000 + Math.round(ns / 1_000_000);
}

// ── Baseline I/O ───────────────────────────────────────────────────────────────

export function loadBaseline(
  baselinePath?: string,
): SavedBaseline | undefined {
  const p = baselinePath ?? DEFAULT_BASELINE_PATH;
  if (!fs.existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (raw.version !== BASELINE_VERSION) {
      console.warn(
        `Baseline version mismatch: expected ${BASELINE_VERSION}, got ${raw.version}`,
      );
    }
    return raw as SavedBaseline;
  } catch {
    return undefined;
  }
}

export function saveBaseline(
  baselinePath: string,
  baseline: SavedBaseline,
): void {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
}

// ── Tiered retrieval ───────────────────────────────────────────────────────────

async function recallWithTiers(
  service: EngramAccessService,
  query: string,
): Promise<{ tiers: BenchTier[]; tierDetails: TierDetail[] }> {
  const tiers: BenchTier[] = [];
  const tierDetails: TierDetail[] = [];

  // Tier 0 — exact match
  const t0 = hrTimeMs();
  const r0 = (await service.recall({ query, mode: "auto" })) as RecallResponse;
  const d0 = hrTimeMs() - t0;
  if (r0.memories && r0.memories.length > 0) {
    tiers.push("exact_match");
    tierDetails.push({
      tier: "exact_match",
      latencyMs: d0,
      resultsCount: r0.memories.length,
    });
    return { tiers, tierDetails };
  }

  // Tier 1 — keyword / category overlap
  const t1 = hrTimeMs();
  const r1 = (await service.recall({ query, mode: "auto" })) as RecallResponse;
  const d1 = hrTimeMs() - t1;
  const hasKeywordMatch = (r1.memories ?? []).some((m) =>
    query
      .toLowerCase()
      .split(/\s+/)
      .some(
        (kw) =>
          kw.length > 2 &&
          m.content.toLowerCase().includes(kw.toLowerCase()),
      ),
  );
  if (hasKeywordMatch) {
    tiers.push("category_match");
    tierDetails.push({
      tier: "category_match",
      latencyMs: d1,
      resultsCount: r1.memories!.length,
    });
    return { tiers, tierDetails };
  }

  // Tier 2 — high-confidence facts
  const t2 = hrTimeMs();
  const r2 = (await service.recall({ query, mode: "auto" })) as RecallResponse;
  const d2 = hrTimeMs() - t2;
  const highConf = (r2.memories ?? []).filter((m) => {
    const conf = m.confidence ?? m.frontmatter?.confidence;
    return conf != null && parseFloat(String(conf)) >= HIGH_CONF_THRESHOLD;
  });
  if (highConf.length > 0) {
    tiers.push("high_confidence");
    tierDetails.push({
      tier: "high_confidence",
      latencyMs: d2,
      resultsCount: highConf.length,
    });
    return { tiers, tierDetails };
  }

  // Tier 3 — semantic search (any results from standard recall)
  const t3 = hrTimeMs();
  const r3 = (await service.recall({ query, mode: "auto" })) as RecallResponse;
  const d3 = hrTimeMs() - t3;
  if (r3.memories && r3.memories.length > 0) {
    tiers.push("semantic_search");
    tierDetails.push({
      tier: "semantic_search",
      latencyMs: d3,
      resultsCount: r3.memories.length,
    });
    return { tiers, tierDetails };
  }

  // Tier 4 — full search fallback
  const t4 = hrTimeMs();
  const r4 = (await service.recall({ query, mode: "full" })) as RecallResponse;
  const d4 = hrTimeMs() - t4;
  if (r4.memories && r4.memories.length > 0) {
    tiers.push("full_search");
    tierDetails.push({
      tier: "full_search",
      latencyMs: d4,
      resultsCount: r4.memories.length,
    });
    return { tiers, tierDetails };
  }

  // No results
  tiers.push("no_results");
  tierDetails.push({
    tier: "no_results",
    latencyMs: d0 + d1 + d2 + d3 + d4,
    resultsCount: 0,
  });
  return { tiers, tierDetails };
}

// ── Explain mode ───────────────────────────────────────────────────────────────

export async function runExplain(
  service: EngramAccessService,
  query: string,
): Promise<ExplainResult> {
  const start = hrTimeMs();
  const { tiers, tierDetails } = await recallWithTiers(service, query);
  const totalDuration = hrTimeMs() - start;
  return {
    query,
    tiersUsed: tiers,
    tierResults: tierDetails,
    durationMs: tierDetails[0]?.latencyMs ?? totalDuration,
    totalDurationMs: totalDuration,
  };
}

// ── Single benchmark ───────────────────────────────────────────────────────────

async function runSingle(
  service: EngramAccessService,
  queryText: string,
): Promise<RecallMetrics> {
  const start = hrTimeMs();
  const { tiers, tierDetails } = await recallWithTiers(service, queryText);
  const duration = hrTimeMs() - start;
  return {
    query: queryText,
    latencyMs: duration,
    tiersUsed: tiers,
    throughput: duration > 0 ? 1 / (duration / 1_000) : 0,
    resultsCount: tierDetails.reduce((sum, t) => sum + t.resultsCount, 0),
    totalDurationMs: duration,
    tierDetails,
  };
}

// ── Full suite ─────────────────────────────────────────────────────────────────

export async function runBenchSuite(
  service: EngramAccessService,
  config: BenchConfig = {},
): Promise<BenchmarkSuiteResult> {
  const queries = config.queries ?? DEFAULT_QUERIES;
  const regressionTolerance = config.regressionTolerance ?? DEFAULT_TOLERANCE;
  const baselinePath = config.baselinePath ?? DEFAULT_BASELINE_PATH;
  const reportPath = config.reportPath ?? DEFAULT_REPORT_PATH;
  const explain = config.explain ?? false;

  const results: RecallMetrics[] = [];
  const suiteStart = hrTimeMs();

  for (const q of queries) {
    if (explain) {
      const ex = await runExplain(service, q);
      results.push({
        query: ex.query,
        latencyMs: ex.durationMs,
        tiersUsed: ex.tiersUsed,
        throughput: ex.totalDurationMs > 0 ? 1 / (ex.totalDurationMs / 1_000) : 0,
        resultsCount: ex.tierResults.reduce((sum, t) => sum + t.resultsCount, 0),
        totalDurationMs: ex.totalDurationMs,
        tierDetails: ex.tierResults,
      });
    } else {
      results.push(await runSingle(service, q));
    }
  }

  const totalDuration = hrTimeMs() - suiteStart;

  // Build per-query metrics map
  const metrics: Record<string, number> = {};
  for (const r of results) {
    metrics[r.query] = r.latencyMs;
  }

  const report = generateReport(results, reportPath);
  const baseline = loadBaseline(baselinePath);
  const regressionResult = checkRegression(metrics, baseline, regressionTolerance);

  // Auto-save baseline if none exists
  if (!baseline) {
    saveBaseline(baselinePath, {
      version: BASELINE_VERSION,
      timestamp: new Date().toISOString(),
      metrics,
    });
  }

  return {
    results,
    report,
    totalDurationMs: totalDuration,
    regressions: regressionResult.regressions,
  };
}

// ── Regression gate ────────────────────────────────────────────────────────────

export function checkRegression(
  metrics: Record<string, number>,
  baseline: SavedBaseline | undefined,
  tolerance: number,
): RegressionGateResult {
  if (!baseline) return { passed: true, regressions: [] };

  const regressions: RegressionDetail[] = [];
  for (const [metricName, currentValue] of Object.entries(metrics)) {
    const baselineValue = baseline.metrics[metricName];
    if (baselineValue === undefined) continue;
    const changePercent =
      baselineValue > 0
        ? ((currentValue - baselineValue) / baselineValue) * 100
        : 0;
    regressions.push({
      metric: metricName,
      currentValue,
      baselineValue,
      tolerance,
      passed: changePercent <= tolerance,
    });
  }

  return {
    passed: regressions.every((r) => r.passed),
    regressions,
  };
}

// ── Report generation ──────────────────────────────────────────────────────────

export function generateReport(
  results: RecallMetrics[],
  reportPath?: string,
): BenchmarkReport {
  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    queries: results.map((r) => ({
      query: r.query,
      tiersUsed: r.tiersUsed,
      durationMs: r.latencyMs,
      resultsCount: r.resultsCount,
      throughput: r.throughput,
      tierDetails: r.tierDetails,
    })),
    totalDurationMs: results.reduce((sum, r) => sum + r.totalDurationMs, 0),
  };

  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  }

  return report;
}
