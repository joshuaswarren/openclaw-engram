/**
 * @remnic/core — Memory Extension Publisher Registry
 *
 * Central registry of host-specific publishers. Each publisher knows
 * how to write Remnic instruction artefacts into a host's extension
 * directory.
 *
 * Usage:
 *   import { publisherFor } from "../memory-extension/index.js";
 *   const pub = publisherFor("codex");
 *   if (pub && await pub.isHostAvailable()) { ... }
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
import { CodexMemoryExtensionPublisher } from "./codex-publisher.js";
import { ClaudeCodeMemoryExtensionPublisher } from "./claude-code-publisher.js";
import { HermesMemoryExtensionPublisher } from "./hermes-publisher.js";

/**
 * Factory registry keyed by host ID. Each value is a zero-argument
 * factory that returns a fresh publisher instance.
 */
export const PUBLISHERS: Record<string, () => MemoryExtensionPublisher> = {
  "codex": () => new CodexMemoryExtensionPublisher(),
  "claude-code": () => new ClaudeCodeMemoryExtensionPublisher(),
  "hermes": () => new HermesMemoryExtensionPublisher(),
};

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
