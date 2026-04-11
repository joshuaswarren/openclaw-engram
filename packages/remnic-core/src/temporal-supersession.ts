/**
 * Temporal Supersession (issue #375)
 *
 * When a new fact lands with `structuredAttributes` keyed on a known
 * `entityRef`, any prior fact whose supersession key collides with the new
 * fact's key is marked `status: "superseded"` and linked via
 * `supersededBy` / `supersededAt`.  Recall filters those superseded memories
 * by default so agents see only the "current" value per entity attribute.
 *
 * The algorithm is intentionally O(N) over the memory corpus per write, but
 * skips cheaply when the new fact has no structuredAttributes.  It reuses the
 * cached `readAllMemories()` path so cost is amortized with the rest of the
 * write pipeline.
 */
import type { MemoryFile, MemoryFrontmatter } from "./types.js";
import type { StorageManager } from "./storage.js";
import { log } from "./logger.js";

/**
 * Stable supersession key for an (entityRef, attributeName) pair.
 *
 * The algorithm is:
 *  - normalize the entityRef (trim, lower-case, collapse whitespace)
 *  - normalize the attributeName the same way
 *  - join with `::`
 *
 * Exported so tests and tools can recompute it without depending on storage.
 */
export function computeSupersessionKey(
  entityRef: string | undefined,
  attributeName: string,
): string | null {
  if (!entityRef || typeof entityRef !== "string") return null;
  if (!attributeName || typeof attributeName !== "string") return null;
  const entity = entityRef.trim().toLowerCase().replace(/\s+/g, "-");
  const attr = attributeName.trim().toLowerCase().replace(/\s+/g, "-");
  if (entity.length === 0 || attr.length === 0) return null;
  return `${entity}::${attr}`;
}

/**
 * Compute the full set of supersession keys for a fact with structured
 * attributes.  Returns an empty array if no keys can be derived.
 */
export function supersessionKeysForFact(spec: {
  entityRef?: string;
  structuredAttributes?: Record<string, string>;
}): string[] {
  if (!spec.entityRef) return [];
  if (!spec.structuredAttributes) return [];
  const keys: string[] = [];
  for (const attrName of Object.keys(spec.structuredAttributes)) {
    const key = computeSupersessionKey(spec.entityRef, attrName);
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * Decide whether an existing memory should be superseded by a newly-written
 * memory that carries the supplied supersession key set.
 *
 * Only memories that:
 *  - are currently `active`
 *  - share an `entityRef` with the new fact
 *  - share at least one supersession key with the new fact
 *  - are older than the new fact
 *  - have a conflicting value (different string) for the overlapping key
 * are eligible.  This keeps supersession local to the attribute that actually
 * changed — if fact A sets `{city: Austin, tool: vim}` and fact B sets
 * `{city: NYC}`, only the city attribute is superseded, not the tool.
 */
export function shouldSupersedeExisting(args: {
  candidate: MemoryFrontmatter;
  newEntityRef: string;
  newAttributes: Record<string, string>;
  newCreatedAt: string;
  newMemoryId: string;
}): { matchedKeys: string[] } | null {
  const { candidate, newEntityRef, newAttributes, newCreatedAt, newMemoryId } = args;

  if (candidate.id === newMemoryId) return null;
  if (candidate.status && candidate.status !== "active") return null;
  if (!candidate.entityRef) return null;
  if (!candidate.structuredAttributes) return null;

  const candidateEntityNorm = candidate.entityRef.trim().toLowerCase().replace(/\s+/g, "-");
  const newEntityNorm = newEntityRef.trim().toLowerCase().replace(/\s+/g, "-");
  if (candidateEntityNorm !== newEntityNorm) return null;

  // Must be older than the new fact — equal timestamps are ignored to avoid
  // races within the same millisecond.
  const candidateCreated = Date.parse(candidate.created);
  const newCreated = Date.parse(newCreatedAt);
  if (!Number.isFinite(candidateCreated) || !Number.isFinite(newCreated)) return null;
  if (candidateCreated >= newCreated) return null;

  const matchedKeys: string[] = [];
  for (const [attrName, newValue] of Object.entries(newAttributes)) {
    const candidateValue = candidate.structuredAttributes[attrName];
    if (candidateValue === undefined) continue;
    // Only supersede on conflicting values — identical values are a no-op.
    if (normalizeValue(candidateValue) === normalizeValue(newValue)) continue;
    const key = computeSupersessionKey(newEntityRef, attrName);
    if (key) matchedKeys.push(key);
  }

  return matchedKeys.length > 0 ? { matchedKeys } : null;
}

function normalizeValue(v: string): string {
  return v.trim().toLowerCase();
}

export interface TemporalSupersessionResult {
  supersededIds: string[];
  matchedKeys: string[];
}

/**
 * Scan existing memories and mark any that are superseded by the
 * just-written memory.  Fails open on I/O errors — the new memory is already
 * on disk, and supersession is a best-effort hygiene step.
 */
export async function applyTemporalSupersession(args: {
  storage: StorageManager;
  newMemoryId: string;
  entityRef?: string;
  structuredAttributes?: Record<string, string>;
  createdAt: string;
  enabled: boolean;
}): Promise<TemporalSupersessionResult> {
  const empty: TemporalSupersessionResult = { supersededIds: [], matchedKeys: [] };
  if (!args.enabled) return empty;
  if (!args.entityRef) return empty;
  if (!args.structuredAttributes) return empty;
  if (Object.keys(args.structuredAttributes).length === 0) return empty;

  const newKeys = supersessionKeysForFact({
    entityRef: args.entityRef,
    structuredAttributes: args.structuredAttributes,
  });
  if (newKeys.length === 0) return empty;

  let memories: MemoryFile[];
  try {
    memories = await args.storage.readAllMemories();
  } catch (err) {
    log.warn(`temporal-supersession: readAllMemories failed: ${err}`);
    return empty;
  }

  const supersededIds: string[] = [];
  const matchedKeys = new Set<string>();

  for (const memory of memories) {
    if (memory.frontmatter.id === args.newMemoryId) continue;
    const decision = shouldSupersedeExisting({
      candidate: memory.frontmatter,
      newEntityRef: args.entityRef,
      newAttributes: args.structuredAttributes,
      newCreatedAt: args.createdAt,
      newMemoryId: args.newMemoryId,
    });
    if (!decision) continue;

    try {
      const wrote = await args.storage.writeMemoryFrontmatter(
        memory,
        {
          status: "superseded",
          supersededBy: args.newMemoryId,
          supersededAt: args.createdAt,
          updated: args.createdAt,
        },
        {
          actor: "temporal-supersession",
          reasonCode: "structured-attribute-update",
          relatedMemoryIds: [args.newMemoryId],
        },
      );
      if (wrote) {
        supersededIds.push(memory.frontmatter.id);
        for (const key of decision.matchedKeys) matchedKeys.add(key);
      }
    } catch (err) {
      log.warn(
        `temporal-supersession: failed to mark ${memory.frontmatter.id} superseded: ${err}`,
      );
    }
  }

  if (supersededIds.length > 0) {
    log.debug(
      `temporal-supersession: marked ${supersededIds.length} memories superseded by ${args.newMemoryId} (keys=${Array.from(matchedKeys).join(",")})`,
    );
  }

  return { supersededIds, matchedKeys: Array.from(matchedKeys) };
}

/**
 * Recall-side filter: returns true when the candidate should be excluded
 * from recall because it has been temporally superseded.  When
 * `includeInRecall` is true, this always returns false (the fact is kept),
 * matching the audit/history opt-in described in the config.
 */
export function shouldFilterSupersededFromRecall(
  frontmatter: MemoryFrontmatter,
  options: { enabled: boolean; includeInRecall: boolean },
): boolean {
  if (!options.enabled) return false;
  if (options.includeInRecall) return false;
  return frontmatter.status === "superseded";
}
