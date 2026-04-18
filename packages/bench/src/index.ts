/**
 * @remnic/bench — phase 1 bench foundation exports
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
  BenchmarkMode,
  BenchmarkTier,
  BenchmarkStatus,
  BenchmarkCategory,
  BuiltInProvider,
  ProviderConfig,
  TaskTokenUsage,
  TaskResult,
  MetricAggregate,
  AggregateMetrics,
  ComparisonMetricDelta,
  ComparisonResult,
  ConfidenceInterval,
  EffectSizeInterpretation,
  EffectSizeSummary,
  StatisticalReport,
  BenchmarkResult,
  BenchmarkMeta,
  BenchmarkDefinition,
  RunBenchmarkOptions,
  ResolvedRunBenchmarkOptions,
} from "./types.js";

export type {
  Message,
  SearchResult,
  MemoryStats,
  BenchJudge,
  BenchMemoryAdapter,
  LlmJudge,
  MemorySystem,
} from "./adapters/types.js";

export {
  createLightweightAdapter,
  createRemnicAdapter,
} from "./adapters/remnic-adapter.js";
export type {
  CompletionOpts,
  CompletionResult,
  DiscoveredModel,
  TokenUsage,
  LlmProvider,
} from "./providers/types.js";

export { BENCHMARK_RESULT_SCHEMA } from "./schema.js";
export { createOpenAiCompatibleProvider } from "./providers/openai-compatible.js";
export {
  buildBenchmarkRunSeeds,
  orchestrateBenchmarkRuns,
  resolveBenchmarkRunCount,
  runBenchmark,
  listBenchmarks,
  getBenchmark,
  writeBenchmarkResult,
  loadBaseline,
  saveBaseline,
  runExplain,
  runBenchSuite,
  checkRegression,
  generateReport,
} from "./benchmark.js";
export {
  exactMatch,
  f1Score,
  rougeL,
  recallAtK,
  containsAnswer,
  llmJudgeScore,
  timed,
  aggregateTaskScores,
} from "./scorer.js";
export {
  bootstrapMeanConfidenceInterval,
  pairedDeltaConfidenceInterval,
} from "./stats/bootstrap.js";
export { cohensD, interpretEffectSize } from "./stats/effect-size.js";
export { compareResults } from "./stats/comparison.js";
