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

export { loadDaySummaryPrompt } from "./day-summary.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export { BootstrapEngine } from "./bootstrap.js";

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
// Connector Manager
// ---------------------------------------------------------------------------

export {
  listConnectors,
  installConnector,
  removeConnector,
  doctorConnector,
  loadRegistry,
  saveRegistry,
  type ConnectorManifest,
  type ConnectorCapability,
  type ConnectorInstance,
  type ConnectorRegistry,
  type InstallOptions,
  type InstallResult,
  type RemoveResult,
  type DoctorResult,
  type DoctorCheck,
} from "./connectors/index.js";

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
} from "./types.js";
