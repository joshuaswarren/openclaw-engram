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
// Public types
// ---------------------------------------------------------------------------

export type { AccessConfig, AccessHealthResponse, AccessRecallResponse } from "../../../src/types.js";
