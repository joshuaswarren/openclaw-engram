/**
 * Public entry point for the ADAM-style memory-extraction attack harness.
 *
 * See the threat model at `docs/security/memory-extraction-threat-model.md`
 * and issue #565.
 */

export { runExtractionAttack, createSeededRng } from "./runner.js";
export {
  createSyntheticTarget,
  SYNTHETIC_MEMORIES,
  OTHER_NAMESPACE_MEMORIES,
} from "./fixture.js";
export type { SyntheticTargetOptions } from "./fixture.js";
export type {
  AttackerMode,
  AttackRecallOptions,
  AttackRetrievalHit,
  ExtractionAttackOptions,
  ExtractionAttackResult,
  ExtractionAttackTarget,
  HarnessRng,
  RecoveredMemory,
  SeededMemory,
  TimelineEntry,
} from "./types.js";
