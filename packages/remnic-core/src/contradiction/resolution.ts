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
  let supersedeFailed = false;

  switch (verb) {
    case "keep-a": {
      const ok = await supersedeSafe(storage, idB, idA, "contradiction-resolution:keep-a");
      if (ok) { affectedIds.push(idB); message = `Kept ${idA}, superseded ${idB}`; }
      else { supersedeFailed = true; message = `Supersede failed for ${idB}; not resolving`; }
      break;
    }
    case "keep-b": {
      const ok = await supersedeSafe(storage, idA, idB, "contradiction-resolution:keep-b");
      if (ok) { affectedIds.push(idA); message = `Kept ${idB}, superseded ${idA}`; }
      else { supersedeFailed = true; message = `Supersede failed for ${idA}; not resolving`; }
      break;
    }
    case "merge": {
      const mergedId = `merged-${pairId}`;
      const okA = await supersedeSafe(storage, idA, mergedId, "contradiction-resolution:merge");
      const okB = await supersedeSafe(storage, idB, mergedId, "contradiction-resolution:merge");
      if (okA) affectedIds.push(idA);
      if (okB) affectedIds.push(idB);
      if (!okA || !okB) {
        supersedeFailed = true;
        message = `Merge incomplete: ${affectedIds.length}/2 superseded; not resolving to allow retry`;
      } else {
        message = `Both memories superseded by merged ${mergedId}`;
      }
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

  if (!supersedeFailed) {
    resolvePair(memoryDir, pairId, verb);
  }
  log.info("[contradiction-resolution] pair=%s verb=%s affected=%d", pairId, verb, affectedIds.length);
  return { pairId, verb, affectedIds, message };
}

async function supersedeSafe(
  storage: StorageManager,
  oldId: string,
  newId: string,
  reason: string,
): Promise<boolean> {
  try {
    const result = await storage.supersedeMemory(oldId, newId, reason);
    if (result === false) {
      log.warn("[contradiction-resolution] supersede returned false for %s → %s", oldId, newId);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(
      "[contradiction-resolution] supersede failed %s → %s: %s",
      oldId,
      newId,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
