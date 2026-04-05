/**
 * @engram/core
 *
 * Framework-agnostic Engram memory engine.
 *
 * Re-exports the orchestrator, config parsing, storage, search,
 * extraction, graph, trust zones, and access layer from the
 * canonical implementation in `src/`.
 *
 * This package has ZERO OpenClaw imports — it can be consumed by
 * any host adapter (CLI, HTTP server, MCP server, etc.).
 *
 * Usage:
 *   import { Orchestrator, parseConfig } from "@engram/core";
 *   const config = parseConfig({ memoryDir: "/tmp/mem" });
 *   const orch = new Orchestrator(config);
 *   await orch.initialize();
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export { parseConfig } from "../../../src/config.js";
// Note: PluginConfig, ExtractionConfig, SearchBackendConfig, ConsolidationConfig,
// TrustZoneConfig are not yet exported from the root config module. These will be
// available once the config types are fully extracted into @engram/core.

// ---------------------------------------------------------------------------
// Orchestrator — primary entry point
// ---------------------------------------------------------------------------

export {
  Orchestrator,
  sanitizeSessionKeyForFilename,
  defaultWorkspaceDir,
} from "../../../src/orchestrator.js";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export { StorageManager } from "../../../src/storage.js";

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export { ExtractionEngine } from "../../../src/extraction.js";
// Note: extractMemories, ExtractedFact, ExtractionResult types will be exported
// once the extraction pipeline is fully extracted into @engram/core.

// ---------------------------------------------------------------------------
// Search backends
// ---------------------------------------------------------------------------

export { QmdClient } from "../../../src/qmd.js";
export { LanceDbBackend } from "../../../src/search/lancedb-backend.js";
export { OramaBackend } from "../../../src/search/orama-backend.js";
export { MeilisearchBackend } from "../../../src/search/meilisearch-backend.js";

// ---------------------------------------------------------------------------
// Entity / Graph
// ---------------------------------------------------------------------------

export { buildEntityRecallSection } from "../../../src/entity-retrieval.js";

// ---------------------------------------------------------------------------
// Trust zones
// ---------------------------------------------------------------------------

export {
  isTrustZoneName,
  type TrustZoneName,
  type TrustZoneRecord,
  type TrustZoneRecordKind,
  type TrustZoneSourceClass,
} from "../../../src/trust-zones.js";

// ---------------------------------------------------------------------------
// Access layer (HTTP + MCP + schema validation)
// ---------------------------------------------------------------------------

export { EngramAccessService, EngramAccessInputError } from "../../../src/access-service.js";
export { EngramAccessHttpServer } from "../../../src/access-http.js";
export { EngramMcpServer } from "../../../src/access-mcp.js";

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
} from "../../../src/access-schema.js";

// ---------------------------------------------------------------------------
// Day summary / LCM
// ---------------------------------------------------------------------------

export { loadDaySummaryPrompt } from "../../../src/day-summary.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export { BootstrapEngine } from "../../../src/bootstrap.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export { initLogger, log } from "../../../src/logger.js";

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
// Public types
// ---------------------------------------------------------------------------

// Note: AccessConfig, AccessHealthResponse, AccessRecallResponse are defined
// in the access layer but not yet exported from the root types module.


// ---------------------------------------------------------------------------
// Bench (M7) — re-export from @engram/bench
// ---------------------------------------------------------------------------

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
} from "../../bench/src/types.js";

export {
  loadBaseline,
  saveBaseline,
  runExplain,
  runBenchSuite,
  checkRegression,
  generateReport,
} from "../../bench/src/benchmark.js";
