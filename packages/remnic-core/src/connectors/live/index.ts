/**
 * @remnic/core — Live Connectors public barrel (issue #683 PR 1/N)
 *
 * Re-exports the live-connector framework, registry, and state store. This
 * is the only path other modules in `@remnic/core` should import from.
 *
 * NOTE: These symbols intentionally live under `connectors/live/` to avoid
 * colliding with the existing Codex marketplace integration in
 * `connectors/`. Do not flatten this barrel into the parent `connectors/`
 * index — keep the namespaces distinct.
 */

export {
  CONNECTOR_ID_PATTERN,
  isValidConnectorId,
  type ConnectorConfig,
  type ConnectorCursor,
  type ConnectorDocument,
  type ConnectorDocumentSource,
  type LiveConnector,
  type SyncIncrementalArgs,
  type SyncIncrementalResult,
} from "./framework.js";

export {
  LiveConnectorRegistry,
  LiveConnectorRegistryError,
} from "./registry.js";

export {
  listConnectorStates,
  readConnectorState,
  writeConnectorState,
  type ConnectorState,
  type ConnectorSyncStatus,
} from "./state-store.js";
