// ---------------------------------------------------------------------------
// @remnic/import-lossless-claw — public surface
// ---------------------------------------------------------------------------

export {
  importLosslessClaw,
  type ImportLosslessClawOptions,
  type ImportLosslessClawResult,
} from "./importer.js";

export {
  assertLosslessClawSchema,
  openSourceDatabase,
  openInMemoryDestinationDatabase,
  listConversations,
  listMessagesForConversation,
  listSummaries,
  listSummaryMessages,
  listSummaryParents,
  type LosslessClawConversation,
  type LosslessClawMessage,
  type LosslessClawSummary,
  type LosslessClawSummaryMessage,
  type LosslessClawSummaryParent,
} from "./source.js";

export {
  buildMessageMetadata,
  indexSummaryDerivations,
  isMultiParent,
  LOSSLESS_CLAW_SOURCE_LABEL,
  mapMessage,
  mapSummary,
  pickCanonicalParent,
  resolveSessionId,
  resolveSummarySession,
  type MappedMessage,
  type MappedSummaryNode,
} from "./transform.js";
