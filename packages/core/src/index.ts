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

export {
  parseConfig,
  resolveConfig,
  validateResolvedConfig,
  type EngramConfig,
  type ResolvedEngramConfig,
  type ExtractionConfig,
  type SearchBackendConfig,
  type ConsolidationConfig,
  type TrustZoneConfig,
} from "../../../src/config.js";

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

export {
  extractMemories,
  type ExtractedFact,
  type ExtractionResult,
} from "../../../src/extraction.js";

// ---------------------------------------------------------------------------
// Search backends
// ---------------------------------------------------------------------------

export { QmdSearchBackend } from "../../../src/qmd-search.js";
export { LanceDbSearchBackend } from "../../../src/lancedb-search.js";
export { OramaSearchBackend } from "../../../src/orama-search.js";
export { MeiliSearchBackend } from "../../../src/meilisearch-backend.js";

// ---------------------------------------------------------------------------
// Entity / Graph
// ---------------------------------------------------------------------------

export { EntityGraphManager } from "../../../src/entity-retrieval.js";

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

export { bootstrap } from "../../../src/bootstrap.js";

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

export type { AccessConfig, AccessHealthResponse, AccessRecallResponse } from "../../../src/types.js";
