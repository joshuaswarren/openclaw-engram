/**
 * Resolution Verbs — executes user-chosen resolution actions on contradiction pairs (issue #520).
 *
 * All resolution paths delegate to StorageManager.supersedeMemory. Do not
 * reimplement supersession logic here (rule 22: deduplicate resolution).
 */

import type { StorageManager } from "../storage.js";
import type { ResolutionVerb } from "./contradiction-review.js";
import { resolvePair, readPair } from "./contradiction-review.js";
import { log } from "../logger.js";

export interface ResolutionResult {
  pairId: string;
  verb: ResolutionVerb;
  /** Memory IDs affected by the resolution. */
  affectedIds: string[];
  /** Human-readable status. */
  message: string;
}

const VALID_VERBS: ResolutionVerb[] = ["keep-a", "keep-b", "merge", "both-valid", "needs-more-context"];

export function isValidResolutionVerb(value: string): value is ResolutionVerb {
  return VALID_VERBS.includes(value as ResolutionVerb);
}

/**
 * Execute a resolution verb on a contradiction pair.
 *
 * - `keep-a`: Supersede B, keep A active.
 * - `keep-b`: Supersede A, keep B active.
 * - `merge`: Mark both as superseded by a synthetic merged ID.
 * - `both-valid`: Mark pair as reviewed; no memories are superseded.
 * - `needs-more-context`: Defer; no action, short cooldown.
 */
export async function executeResolution(
  memoryDir: string,
  storage: StorageManager,
  pairId: string,
  verb: ResolutionVerb,
): Promise<ResolutionResult> {
  const pair = readPair(memoryDir, pairId);
  if (!pair) {
    return { pairId, verb, affectedIds: [], message: `Pair ${pairId} not found` };
  }

  if (pair.resolution) {
    return { pairId, verb, affectedIds: [], message: `Pair already resolved with verb "${pair.resolution}"` };
  }

  const [idA, idB] = pair.memoryIds;
  const affectedIds: string[] = [];
  let message = "";

  switch (verb) {
    case "keep-a": {
      await supersedeSafe(storage, idB, idA, "contradiction-resolution:keep-a");
      affectedIds.push(idB);
      message = `Kept ${idA}, superseded ${idB}`;
      break;
    }
    case "keep-b": {
      await supersedeSafe(storage, idA, idB, "contradiction-resolution:keep-b");
      affectedIds.push(idA);
      message = `Kept ${idB}, superseded ${idA}`;
      break;
    }
    case "merge": {
      const mergedId = `merged-${pairId}`;
      await supersedeSafe(storage, idA, mergedId, "contradiction-resolution:merge");
      await supersedeSafe(storage, idB, mergedId, "contradiction-resolution:merge");
      affectedIds.push(idA, idB);
      message = `Both memories superseded by merged ${mergedId}`;
      break;
    }
    case "both-valid": {
      message = "Pair marked as both-valid; cooldown applied";
      break;
    }
    case "needs-more-context": {
      message = "Deferred; no action taken, short cooldown applied";
      break;
    }
  }

  resolvePair(memoryDir, pairId, verb);
  log.info("[contradiction-resolution] pair=%s verb=%s affected=%d", pairId, verb, affectedIds.length);
  return { pairId, verb, affectedIds, message };
}

async function supersedeSafe(
  storage: StorageManager,
  oldId: string,
  newId: string,
  reason: string,
): Promise<void> {
  try {
    await storage.supersedeMemory(oldId, newId, reason);
  } catch (err) {
    log.warn(
      "[contradiction-resolution] supersede failed %s → %s: %s",
      oldId,
      newId,
      err instanceof Error ? err.message : err,
    );
  }
}
