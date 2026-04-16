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
 * Look up a publisher by host ID.
 * Returns undefined for unknown host IDs rather than throwing.
 */
export function publisherFor(hostId: string): MemoryExtensionPublisher | undefined {
  const factory = PUBLISHERS[hostId];
  return factory ? factory() : undefined;
}
