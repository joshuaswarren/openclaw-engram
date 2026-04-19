/**
 * @remnic/core
 *
 * Framework-agnostic Remnic memory engine.
 *
 * Exports the orchestrator, config parsing, storage, search,
 * extraction, graph, trust zones, and access layer.
 *
 * This package has ZERO OpenClaw imports — it can be consumed by
 * any host adapter (CLI, HTTP server, MCP server, etc.).
 *
 * Usage:
 *   import { Orchestrator, parseConfig } from "@remnic/core";
 *   const config = parseConfig({ memoryDir: "/tmp/mem" });
 *   const orch = new Orchestrator(config);
 *   await orch.initialize();
 */

// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------

export { PLUGIN_ID, LEGACY_PLUGIN_ID, resolveRemnicPluginEntry } from "./plugin-id.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export { parseConfig } from "./config.js";
export {
  migrateFromEngram,
  rollbackFromEngramMigration,
  type MigrationResult,
  type MigrationOptions,
  type RollbackResult,
} from "./migrate/from-engram.js";

// ---------------------------------------------------------------------------
// Orchestrator — primary entry point
// ---------------------------------------------------------------------------

export {
  Orchestrator,
  sanitizeSessionKeyForFilename,
  defaultWorkspaceDir,
} from "./orchestrator.js";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export { StorageManager } from "./storage.js";

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export { ExtractionEngine } from "./extraction.js";

// ---------------------------------------------------------------------------
// Extraction Judge (issue #376)
// ---------------------------------------------------------------------------

export {
  judgeFactDurability,
  clearVerdictCache,
  verdictCacheSize,
  createVerdictCache,
  type JudgeCandidate,
  type JudgeVerdict,
  type JudgeBatchResult,
} from "./extraction-judge.js";

// ---------------------------------------------------------------------------
// Inline source attribution (issue #369)
// ---------------------------------------------------------------------------

export {
  DEFAULT_CITATION_FORMAT,
  CITATION_UNKNOWN,
  attachCitation,
  deriveSessionId,
  formatCitation,
  hasCitation,
  parseAllCitations,
  parseCitation,
  stripCitation,
  type CitationContext,
  type ParsedCitation,
} from "./source-attribution.js";

// ---------------------------------------------------------------------------
// Search backends
// ---------------------------------------------------------------------------

export { QmdClient } from "./qmd.js";
export { LanceDbBackend } from "./search/lancedb-backend.js";
export { OramaBackend } from "./search/orama-backend.js";
export { MeilisearchBackend } from "./search/meilisearch-backend.js";

// ---------------------------------------------------------------------------
// Entity / Graph
// ---------------------------------------------------------------------------

export { buildEntityRecallSection } from "./entity-retrieval.js";
export { resolvePrincipal } from "./namespaces/principal.js";

// ---------------------------------------------------------------------------
// Trust zones
// ---------------------------------------------------------------------------

export {
  isTrustZoneName,
  type TrustZoneName,
  type TrustZoneRecord,
  type TrustZoneRecordKind,
  type TrustZoneSourceClass,
} from "./trust-zones.js";

// ---------------------------------------------------------------------------
// Access layer (HTTP + MCP + schema validation)
// ---------------------------------------------------------------------------

export { EngramAccessService, EngramAccessInputError } from "./access-service.js";
export { EngramAccessHttpServer } from "./access-http.js";
export { EngramMcpServer } from "./access-mcp.js";

export {
  validateRequest,
  formatZodError,
  recallRequestSchema,
  observeRequestSchema,
  memoryStoreRequestSchema,
  suggestionSubmitRequestSchema,
  type SchemaValidationError,
  type SchemaName,
  type RecallRequest,
  type ObserveRequest,
  type MemoryStoreRequest,
  type SuggestionSubmitRequest,
} from "./access-schema.js";

// ---------------------------------------------------------------------------
// Day summary / LCM
// ---------------------------------------------------------------------------

export { loadDaySummaryPrompt, buildExtensionsFooterForSummary } from "./day-summary.js";

// ---------------------------------------------------------------------------
// Active memory bridge
// ---------------------------------------------------------------------------

export {
  getMemoryForActiveMemory,
  recallForActiveMemory,
  type ActiveMemoryGetOutput,
  type ActiveMemoryMetadata,
  type ActiveMemoryRecallParams,
  type ActiveMemorySearchOutput,
  type ActiveMemorySearchResult,
} from "./active-memory-bridge.js";

// ---------------------------------------------------------------------------
// Daily Context Briefing (#370)
// ---------------------------------------------------------------------------

export {
  buildBriefing,
  parseBriefingWindow,
  parseBriefingFocus,
  validateBriefingFormat,
  focusMatchesMemory,
  focusMatchesEntity,
  renderBriefingMarkdown,
  resolveBriefingSaveDir,
  briefingFilename,
  FileCalendarSource,
  BRIEFING_FORMAT_ALLOWED,
  type BuildBriefingOptions,
  type BriefingFollowupGenerator,
  type ParsedBriefingWindow,
  type BriefingFormatValue,
} from "./briefing.js";

// ---------------------------------------------------------------------------
// Binary lifecycle management (#367)
// ---------------------------------------------------------------------------

export {
  type BinaryLifecycleConfig,
  type BinaryStorageBackendConfig,
  type BinaryAssetRecord,
  type BinaryAssetStatus,
  type BinaryLifecycleManifest,
  type PipelineResult,
  type BinaryStorageBackend,
  DEFAULT_SCAN_PATTERNS,
  DEFAULT_MAX_BINARY_SIZE_BYTES,
  DEFAULT_GRACE_PERIOD_DAYS,
  FilesystemBackend,
  NoneBackend,
  createBackend,
  scanForBinaries,
  matchesPatterns,
  readManifest,
  writeManifest,
  manifestPath,
  manifestDir,
  emptyManifest,
  runBinaryLifecyclePipeline,
} from "./binary-lifecycle/index.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export { BootstrapEngine } from "./bootstrap.js";

// ---------------------------------------------------------------------------
// Codex compatibility helpers
// ---------------------------------------------------------------------------

export { CODEX_THREAD_KEY_PREFIX } from "./codex-thread-key.js";
export type { CodexCompatConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Page-level versioning (issue #371)
// ---------------------------------------------------------------------------

export {
  createVersion,
  listVersions,
  getVersion,
  revertToVersion,
  diffVersions,
  type PageVersion,
  type VersionTrigger,
  type VersionHistory,
  type VersioningConfig,
  type VersioningLogger,
} from "./page-versioning.js";

// ---------------------------------------------------------------------------
// OAI-mem-citation blocks (issue #379)
// ---------------------------------------------------------------------------

export {
  parseOaiMemCitation,
  formatOaiMemCitation,
  buildCitationGuidance,
  sanitizeNoteForCitation,
  type CitationEntry,
  type CitationBlock,
  type CitationMetadata,
} from "./citations.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export { initLogger, log } from "./logger.js";

// ---------------------------------------------------------------------------
// Projection (workspace tree)
// ---------------------------------------------------------------------------

export {
  generateContextTree,
  type TreeNode,
  type ProvenanceEntry,
  type GenerateOptions,
  type GenerateResult,
} from "./projection/index.js";

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export {
  onboard,
  type OnboardOptions,
  type OnboardResult,
  type LanguageInfo,
  type DocFile,
  type ProjectShape,
  type IngestionPlan,
} from "./onboarding/index.js";

// ---------------------------------------------------------------------------
// Curation
// ---------------------------------------------------------------------------

export {
  curate,
  type CurateOptions,
  type CuratedStatement,
  type StatementProvenance,
  type CurateResult,
  type DuplicateResult as CurateDuplicateResult,
  type ContradictionResult as CurateContradictionResult,
} from "./curation/index.js";

// ---------------------------------------------------------------------------
// Dedup & Contradiction Detection
// ---------------------------------------------------------------------------

export {
  findDuplicates,
  findContradictions,
  type MemoryEntry,
  type DedupOptions,
  type DedupResult,
  type DuplicatePair,
  type ContradictionOptions,
  type ContradictionPair,
} from "./dedup/index.js";

export {
  decideSemanticDedup,
  type SemanticDedupHit,
  type SemanticDedupLookup,
  type SemanticDedupOptions,
  type SemanticDedupDecision,
} from "./dedup/semantic.js";

// ---------------------------------------------------------------------------
// Review Inbox
// ---------------------------------------------------------------------------

export {
  listReviewItems,
  performReview,
  type ReviewItem,
  type ReviewAction,
  type ReviewResult,
  type ReviewListResult,
  type ReviewOptions,
} from "./review/index.js";

// ---------------------------------------------------------------------------
// Diff-Aware Sync
// ---------------------------------------------------------------------------

export {
  syncChanges,
  watchForChanges,
  type SyncOptions,
  type SyncResult,
  type FileChange,
  type SyncState,
} from "./sync/index.js";

// ---------------------------------------------------------------------------
// Memory Extension Host (#382)
// ---------------------------------------------------------------------------

export {
  discoverMemoryExtensions,
  renderExtensionsBlock,
  renderExtensionsFooter,
  resolveExtensionsRoot,
  REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT,
  type DiscoveredExtension,
  type ExtensionSchema,
} from "./memory-extension-host/index.js";

export {
  buildExtensionsBlockForConsolidation,
} from "./semantic-consolidation.js";

// ---------------------------------------------------------------------------
// Connector Manager
// ---------------------------------------------------------------------------

export {
  listConnectors,
  installConnector,
  removeConnector,
  doctorConnector,
  loadRegistry,
  saveRegistry,
  generateMarketplaceManifest,
  validateMarketplaceManifest,
  checkMarketplaceManifest,
  writeMarketplaceManifest,
  installFromMarketplace,
  MARKETPLACE_SCHEMA_VERSION,
  MARKETPLACE_MANIFEST_FILENAME,
  type ConnectorManifest,
  type ConnectorCapability,
  type ConnectorInstance,
  type ConnectorRegistry,
  type InstallOptions,
  type InstallResult,
  type RemoveResult,
  type DoctorResult,
  type DoctorCheck,
  type MarketplaceManifest,
  type MarketplaceEntry,
  type MarketplaceConfig,
  type MarketplaceInstallType,
  type MarketplaceInstallResult,
  type MarketplaceValidation,
  type MarketplaceLogger,
} from "./connectors/index.js";

export { coerceInstallExtension } from "./connectors/coerce.js";

// ---------------------------------------------------------------------------
// Spaces + Collaboration
// ---------------------------------------------------------------------------

export {
  listSpaces,
  getActiveSpace,
  createSpace,
  deleteSpace,
  switchSpace,
  pushToSpace,
  pullFromSpace,
  shareSpace,
  promoteSpace,
  mergeSpaces,
  loadManifest,
  saveManifest,
  getAuditLog,
  getSpacesDir,
  getManifestPath,
  type Space,
  type SpaceKind,
  type SpaceManifest,
  type SpaceSwitchResult,
  type SpacePushResult,
  type SpacePullResult,
  type SpaceShareResult,
  type SpacePromoteResult,
  type ConflictEntry,
  type MergeResult,
  type AuditEntry,
} from "./spaces/index.js";

// ---------------------------------------------------------------------------
// Token Management
// ---------------------------------------------------------------------------

export {
  generateToken,
  listTokens,
  revokeToken,
  getAllValidTokens,
  getAllValidTokensCached,
  resolveConnectorFromToken,
  loadTokenStore,
  saveTokenStore,
  type TokenEntry,
  type TokenStore,
} from "./tokens.js";

// ---------------------------------------------------------------------------
// Codex materializer (#378)
// ---------------------------------------------------------------------------

export {
  runCodexMaterialize,
  runPostConsolidationMaterialize,
  type RunMaterializeOptions,
  type PostConsolidationMaterializeOptions,
} from "./connectors/codex-materialize-runner.js";
export {
  materializeForNamespace,
  ensureSentinel,
  describeMemoriesDir,
  SENTINEL_FILE,
  MATERIALIZE_VERSION,
  type MaterializeOptions,
  type MaterializeResult,
  type RolloutSummaryInput,
} from "./connectors/codex-materialize.js";

// ---------------------------------------------------------------------------
// Memory Extension Publishers (#381)
// ---------------------------------------------------------------------------

export {
  publisherFor,
  publisherForConnector,
  hostIdForConnector,
  registerPublisher,
  PUBLISHERS,
  CodexMemoryExtensionPublisher,
  ClaudeCodeMemoryExtensionPublisher,
  HermesMemoryExtensionPublisher,
  REMNIC_SEMANTIC_OVERVIEW,
  REMNIC_CITATION_FORMAT,
  REMNIC_MCP_TOOL_INVENTORY,
  REMNIC_RECALL_DECISION_RULES,
  type MemoryExtensionPublisher,
  type PublishContext,
  type PublishResult,
  type PublisherCapabilities,
} from "./memory-extension/index.js";

// ---------------------------------------------------------------------------
// MECE Taxonomy (#366)
// ---------------------------------------------------------------------------

export {
  DEFAULT_TAXONOMY,
  resolveCategory,
  generateResolverDocument,
  loadTaxonomy,
  saveTaxonomy,
  validateSlug,
  validateTaxonomy,
  getTaxonomyDir,
  getTaxonomyFilePath,
  type Taxonomy,
  type TaxonomyCategory,
  type ResolverDecision,
} from "./taxonomy/index.js";

// ---------------------------------------------------------------------------
// Enrichment pipeline (issue #365)
// ---------------------------------------------------------------------------

export {
  EnrichmentProviderRegistry,
  WebSearchProvider,
  runEnrichmentPipeline,
  appendAuditEntry,
  readAuditLog,
  defaultEnrichmentPipelineConfig,
  type EnrichmentCandidate,
  type EnrichmentCostTier,
  type EnrichmentPipelineConfig,
  type EnrichmentProvider,
  type EnrichmentProviderConfig,
  type EnrichmentResult,
  type EntityEnrichmentInput,
  type EnrichmentAuditEntry,
  type WebSearchFn,
  type WebSearchProviderOptions,
} from "./enrichment/index.js";

// Bulk-import pipeline (#460)
// ---------------------------------------------------------------------------

export {
  type BulkImportSource,
  type ImportTurn,
  type BulkImportOptions,
  type ImportSourceRole,
  type BulkImportResult,
  type BulkImportError,
  type BulkImportSourceAdapter,
  type ImportTurnValidationIssue,
  isImportRole,
  parseIsoTimestamp,
  validateImportTurn,
  registerBulkImportSource,
  getBulkImportSource,
  listBulkImportSources,
  clearBulkImportSources,
  runBulkImportPipeline,
  formatBatchTranscript,
  type ProcessBatchFn,
  type ProcessBatchResult,
} from "./bulk-import/index.js";

// ---------------------------------------------------------------------------
// Training-data export (issue #459)
// ---------------------------------------------------------------------------

export * from "./training-export/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type {
  PluginConfig,
  MemoryFile,
  MemoryCategory,
  MemoryActionType,
  MemoryActionEligibilityContext,
  MemoryActionEligibilitySource,
  ContinuityImprovementLoop,
  BriefingConfig,
  BriefingWindow,
  BriefingFocus,
  BriefingActiveThread,
  BriefingRecentEntity,
  BriefingOpenCommitment,
  BriefingFollowup,
  BriefingSections,
  BriefingResult,
  CalendarEvent,
  CalendarSource,
} from "./types.js";
