/**
 * @remnic/core — Memory Extension Publisher Registry
 *
 * Central registry for host-specific publishers. The registry itself
 * is empty at import time — host adapters (e.g. the CLI) call
 * {@link registerPublisher} to wire concrete implementations.
 *
 * Core exports the interface, the registry helpers, and the concrete
 * publisher *classes* (so host packages can import them), but never
 * auto-registers them. This keeps the architecture boundary clean:
 * core has no host-specific wiring.
 *
 * Usage (in a host adapter):
 *   import { registerPublisher, CodexMemoryExtensionPublisher } from "@remnic/core";
 *   registerPublisher("codex", () => new CodexMemoryExtensionPublisher());
 */

export type {
  MemoryExtensionPublisher,
  PublishContext,
  PublishResult,
  PublisherCapabilities,
} from "./types.js";

export {
  REMNIC_SEMANTIC_OVERVIEW,
  REMNIC_CITATION_FORMAT,
  REMNIC_MCP_TOOL_INVENTORY,
  REMNIC_RECALL_DECISION_RULES,
} from "./shared-instructions.js";

export { CodexMemoryExtensionPublisher } from "./codex-publisher.js";
export { ClaudeCodeMemoryExtensionPublisher } from "./claude-code-publisher.js";
export { HermesMemoryExtensionPublisher } from "./hermes-publisher.js";

import type { MemoryExtensionPublisher } from "./types.js";

/**
 * Factory registry keyed by host ID. Each value is a zero-argument
 * factory that returns a fresh publisher instance.
 *
 * Starts empty — host adapters populate it via {@link registerPublisher}.
 * This avoids wiring host-specific implementations directly into
 * `@remnic/core` (CLAUDE.md gotcha #31).
 */
export const PUBLISHERS: Record<string, () => MemoryExtensionPublisher> = {};

/**
 * Register a publisher factory for the given host ID.
 *
 * Call this from the CLI or host-specific package at startup to
 * populate the registry before any `publisherFor()` lookups.
 */
export function registerPublisher(
  hostId: string,
  factory: () => MemoryExtensionPublisher,
): void {
  PUBLISHERS[hostId] = factory;
}

/**
 * Maps connector IDs to publisher host IDs.
 *
 * Most connector IDs match their publisher host ID exactly (e.g.
 * "claude-code" -> "claude-code", "hermes" -> "hermes").
 * This map only needs entries for connector IDs that differ from
 * their publisher host ID. Connectors without a publisher (e.g.
 * "cursor", "cline") are intentionally absent.
 */
const CONNECTOR_TO_HOST: Record<string, string> = {
  "codex-cli": "codex",
};

/**
 * Resolve a connector ID to its publisher host ID.
 *
 * Returns the explicit mapping if one exists, otherwise returns
 * the connector ID itself (identity mapping covers the common case
 * where connector ID === host ID).
 */
export function hostIdForConnector(connectorId: string): string {
  return CONNECTOR_TO_HOST[connectorId] ?? connectorId;
}

/**
 * Look up a publisher by host ID.
 * Returns undefined for unknown host IDs rather than throwing.
 */
export function publisherFor(hostId: string): MemoryExtensionPublisher | undefined {
  const factory = PUBLISHERS[hostId];
  return factory ? factory() : undefined;
}

/**
 * Look up a publisher by connector ID.
 *
 * Resolves the connector ID to its host ID first (e.g. "codex-cli" -> "codex"),
 * then looks up the publisher. Returns undefined if no publisher exists for
 * the resolved host ID.
 */
export function publisherForConnector(connectorId: string): MemoryExtensionPublisher | undefined {
  return publisherFor(hostIdForConnector(connectorId));
}
