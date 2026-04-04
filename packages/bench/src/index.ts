/**
 * @engram/bench — barrel re-export
 */

export type {
  BenchTier,
  TierDetail,
  ExplainResult,
  RecallMetrics,
  BenchmarkReport,
  BenchmarkSuiteResult,
  SavedBaseline,
  RegressionGateResult,
  RegressionDetail,
  BenchConfig,
} from "./types.js";

export {
  loadBaseline,
  saveBaseline,
  runExplain,
  runBenchSuite,
  checkRegression,
  generateReport,
} from "./benchmark.js";
