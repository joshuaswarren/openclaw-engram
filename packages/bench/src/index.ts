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
  BenchRuntimeProfile,
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
  BenchResponse,
  BenchResponder,
  BenchJudgeResult,
  BenchJudge,
  BenchMemoryAdapter,
  LlmJudge,
  MemorySystem,
} from "./adapters/types.js";

export type {
  GoldEntityType,
  GoldEntity,
  GoldLink,
  GoldPage,
  GoldGraph,
  ExtractedEntity,
  ExtractedLink,
  ExtractedPage,
  MemoryGraph,
  IngestionLog,
  IngestionBenchAdapter,
} from "./ingestion-types.js";

export { REQUIRED_FRONTMATTER_FIELDS } from "./ingestion-types.js";

export type {
  GeneratedFile,
  FixtureOutput,
  FixtureGenerator,
} from "./fixtures/inbox/types.js";

export {
  createLightweightAdapter,
  createRemnicAdapter,
} from "./adapters/remnic-adapter.js";
export type { RemnicAdapterOptions } from "./adapters/remnic-adapter.js";
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
export {
  answerBenchmarkQuestion,
} from "./answering.js";
export {
  createGatewayResponder,
  createProviderBackedJudge,
  createProviderBackedResponder,
  createProviderBackedStructuredJudge,
  createResponderFromProvider,
  createStructuredJudgeFromProvider,
} from "./responders.js";
export { createLiteLlmProvider } from "./providers/litellm.js";
export { createOllamaProvider } from "./providers/ollama.js";
export { createOpenAiCompatibleProvider } from "./providers/openai-compatible.js";
export type {
  BenchModelSource,
  ResolveBenchRuntimeProfileOptions,
  ResolvedBenchRuntimeProfile,
} from "./runtime-profiles.js";
export { resolveBenchRuntimeProfile } from "./runtime-profiles.js";
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
  llmJudgeScoreDetailed,
  timed,
  aggregateTaskScores,
} from "./scorer.js";
export {
  bootstrapMeanConfidenceInterval,
  pairedDeltaConfidenceInterval,
} from "./stats/bootstrap.js";
export { cohensD, interpretEffectSize } from "./stats/effect-size.js";
export { compareResults, getBenchmarkLowerIsBetter } from "./stats/comparison.js";
export {
  assertPublishableIntegrity,
  buildBenchmarkPublishFeed,
  deleteBenchmarkResults,
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
export type {
  BuildBenchmarkPublishFeedOptions,
  PublishSkipReason,
  PublishSkipRecord,
  PublishedBenchmarkFeed,
  PublishedBenchmarkFeedEntry,
} from "./results-store.js";

// Integrity pipeline (sealed qrels, canary adapter, contamination, randomize).
export * from "./integrity/index.js";
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

export {
  matchEntity,
  entityRecall,
  linkMatches,
  backlinkF1,
  schemaCompleteness,
} from "./ingestion-scorer.js";

export { emailFixture } from "./fixtures/inbox/email.js";
export { projectFolderFixture } from "./fixtures/inbox/project-folder.js";
export { calendarFixture } from "./fixtures/inbox/calendar.js";
export { chatFixture } from "./fixtures/inbox/chat.js";

// Assistant bench tier — sealed-rubric judge infrastructure.
export {
  ASSISTANT_RUBRIC_DIMENSIONS,
  buildJudgePayload,
  clampScore,
  createDeterministicSpotCheckLogger,
  createSpotCheckFileLogger,
  loadSealedRubric,
  parseRubricResponse,
  runSealedJudge,
  verifyRubricDigest,
  zeroScores,
} from "./judges/sealed-rubric.js";
export type {
  AssistantRubricDimension,
  AssistantRubricScores,
  SealedJudgeDecision,
  SealedJudgeInput,
  SealedRubric,
  SpotCheckLogger,
  StructuredJudge,
} from "./judges/sealed-rubric.js";
export {
  DEFAULT_ASSISTANT_RUBRIC_ID,
  SEALED_PROMPT_REGISTRY,
} from "./judges/sealed-prompts/index.js";

// Assistant bench tier — shared runner helpers.
export {
  ASSISTANT_AGENT_CONFIG_KEY,
  ASSISTANT_JUDGE_CONFIG_KEY,
  ASSISTANT_RUBRIC_ID_KEY,
  ASSISTANT_SEEDS_CONFIG_KEY,
  ASSISTANT_SPOT_CHECK_DIR_KEY,
  renderMemorySummaryForJudge,
  renderMemoryViewForAgent,
  resolveAssistantAgent,
  resolveAssistantRubricId,
  resolveAssistantSeeds,
  resolveAssistantSpotCheckDir,
  resolveStructuredJudge,
  runAssistantBenchmark,
} from "./benchmarks/remnic/_assistant-common/index.js";
export type {
  AssistantAgent,
  AssistantMemoryFact,
  AssistantMemoryGraph,
  AssistantRunnerOptions,
  AssistantScenario,
  AssistantStance,
} from "./benchmarks/remnic/_assistant-common/index.js";

// Assistant bench tier — individual benchmark exports.
export {
  ASSISTANT_MORNING_BRIEF_SCENARIOS,
  ASSISTANT_MORNING_BRIEF_SMOKE_SCENARIOS,
} from "./benchmarks/remnic/assistant-morning-brief/fixture.js";
export {
  assistantMorningBriefDefinition,
  runAssistantMorningBriefBenchmark,
} from "./benchmarks/remnic/assistant-morning-brief/runner.js";
export {
  ASSISTANT_MEETING_PREP_SCENARIOS,
  ASSISTANT_MEETING_PREP_SMOKE_SCENARIOS,
} from "./benchmarks/remnic/assistant-meeting-prep/fixture.js";
export {
  assistantMeetingPrepDefinition,
  runAssistantMeetingPrepBenchmark,
} from "./benchmarks/remnic/assistant-meeting-prep/runner.js";
export {
  ASSISTANT_NEXT_BEST_ACTION_SCENARIOS,
  ASSISTANT_NEXT_BEST_ACTION_SMOKE_SCENARIOS,
} from "./benchmarks/remnic/assistant-next-best-action/fixture.js";
export {
  assistantNextBestActionDefinition,
  runAssistantNextBestActionBenchmark,
} from "./benchmarks/remnic/assistant-next-best-action/runner.js";
export {
  ASSISTANT_SYNTHESIS_SCENARIOS,
  ASSISTANT_SYNTHESIS_SMOKE_SCENARIOS,
} from "./benchmarks/remnic/assistant-synthesis/fixture.js";
export {
  assistantSynthesisDefinition,
  runAssistantSynthesisBenchmark,
} from "./benchmarks/remnic/assistant-synthesis/runner.js";
