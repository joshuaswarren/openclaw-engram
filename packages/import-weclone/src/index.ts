// ---------------------------------------------------------------------------
// @remnic/import-weclone — public surface
// ---------------------------------------------------------------------------

export { wecloneImportAdapter } from "./adapter.js";

export {
  parseWeCloneExport,
  type WeClonePlatform,
  type WeClonePreprocessedMessage,
  type WeClonePreprocessedExport,
  type ParseOptions,
} from "./parser.js";

export {
  groupIntoThreads,
  type ThreadGroup,
  type ThreaderOptions,
} from "./threader.js";

export {
  mapParticipants,
  type ParticipantEntity,
} from "./participant.js";

export {
  chunkThreads,
  type ChunkOptions,
} from "./chunker.js";

export {
  createProgressTracker,
  type ImportProgress,
  type ProgressCallback,
} from "./progress.js";
