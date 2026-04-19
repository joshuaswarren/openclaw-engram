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
  CustomBenchmarkScoring,
  CustomBenchmarkSpec,
  CustomBenchmarkTask,
} from "./benchmarks/custom/types.js";

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
  AnthropicProviderConfig,
  CompletionOpts,
  CompletionResult,
  DiscoveredModel,
  TokenUsage,
  LlmProvider,
  OllamaProviderConfig,
  OpenAiCompatibleProviderConfig,
  ProviderBaseConfig,
  ProviderDiscoveryResult,
  ProviderFactoryConfig,
} from "./providers/types.js";

export { BENCHMARK_RESULT_SCHEMA } from "./schema.js";
export { createAnthropicProvider } from "./providers/anthropic.js";
export {
  createProvider,
  discoverAllProviders,
} from "./providers/factory.js";
export { createLiteLlmProvider } from "./providers/litellm.js";
export { createOllamaProvider } from "./providers/ollama.js";
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
  precisionAtK,
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
export {
  buildBenchmarkPublishFeed,
  defaultBenchmarkBaselineDir,
  defaultBenchmarkPublishPath,
  loadBenchmarkResult,
  loadBenchmarkBaseline,
  listBenchmarkBaselines,
  listBenchmarkResults,
  renderBenchmarkResultExport,
  resolveBenchmarkResultReference,
  saveBenchmarkBaseline,
  writeBenchmarkPublishFeed,
} from "./results-store.js";
export {
  loadCustomBenchmarkFile,
  parseCustomBenchmark,
} from "./benchmarks/custom/loader.js";
export {
  runCustomBenchmarkFile,
} from "./benchmarks/custom/runner.js";
export type {
  AbstentionRetrievalCase,
  PersonalizationRetrievalCase,
  SchemaTierCorpus,
  SchemaTierFixture,
  SchemaTierName,
  SchemaTierPage,
  SchemaTierPageFrontmatter,
  TemporalRetrievalCase,
} from "./fixtures/schema-tiers/index.js";
export {
  buildSchemaTierFixture,
  buildSchemaTierSmokeFixture,
  SCHEMA_TIER_FIXTURE,
  SCHEMA_TIER_SMOKE_FIXTURE,
} from "./fixtures/schema-tiers/index.js";
