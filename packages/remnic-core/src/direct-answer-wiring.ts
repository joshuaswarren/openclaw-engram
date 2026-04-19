/**
 * Direct-answer wiring (issue #518 slice 3).
 *
 * Binds the pure eligibility decision (`direct-answer.ts`) to the data
 * sources needed to build candidates: storage, trust-zones, taxonomy,
 * and importance scoring.  Kept as a separate module so that:
 *
 * - The eligibility layer stays pure and unit-testable without stores.
 * - Each caller injects its own source accessors.  The orchestrator
 *   binding is a follow-on slice; tests here use mock sources.
 * - The wiring is safe to ship alone — nothing calls `tryDirectAnswer`
 *   yet, so enabling this module's presence does not change recall
 *   behavior.  The next slice adds exactly one call site before QMD.
 *
 * Short-circuit contract:
 *
 * - When `config.recallDirectAnswerEnabled === false`, the function
 *   returns the eligibility verdict with reason `"disabled"` without
 *   touching any source accessor.  This is the documented default.
 * - When enabled, the wiring cheaply drops non-trusted-zone memories
 *   and ineligible taxonomy buckets before computing importance, so
 *   the eligibility module sees a pre-filtered candidate set.  The
 *   eligibility module still performs the same checks itself — this
 *   module is purely an I/O and prefiltering layer.
 */

import type { MemoryFile, PluginConfig } from "./types.js";
import type { TrustZoneName } from "./trust-zones.js";
import type { Taxonomy } from "./taxonomy/types.js";
import { resolveCategory } from "./taxonomy/resolver.js";
import {
  isDirectAnswerEligible,
  type DirectAnswerCandidate,
  type DirectAnswerConfig,
  type DirectAnswerResult,
} from "./direct-answer.js";

/**
 * Caller-provided accessors for candidate sourcing.  Decouples the
 * wiring from any specific storage / trust-zone / importance backend.
 */
export interface DirectAnswerSources {
  /**
   * List memories eligible to be considered for direct-answer.
   * Callers are expected to return only active, non-superseded memories
   * in the requested namespace; the wiring will cheaply re-filter on
   * trust zone and taxonomy bucket and hand the rest to the eligibility
   * module, which applies the full gate ladder.
   */
  listCandidateMemories(options: {
    namespace: string;
    abortSignal?: AbortSignal;
  }): Promise<MemoryFile[]>;
  /**
   * Resolve the trust-zone record for a memory.  Returns `null` when
   * the memory has no trust-zone record (treated as not trusted).
   */
  trustZoneFor(memoryId: string): Promise<TrustZoneName | null>;
  /**
   * Resolve a calibrated importance score in [0, 1] for a memory.
   */
  importanceFor(memory: MemoryFile): number;
  /**
   * Taxonomy used to classify memories into direct-answer buckets.
   */
  taxonomy: Taxonomy;
}

export interface DirectAnswerWiringInput {
  query: string;
  namespace: string;
  config: Pick<
    PluginConfig,
    | "recallDirectAnswerEnabled"
    | "recallDirectAnswerTokenOverlapFloor"
    | "recallDirectAnswerImportanceFloor"
    | "recallDirectAnswerAmbiguityMargin"
    | "recallDirectAnswerEligibleTaxonomyBuckets"
  >;
  sources: DirectAnswerSources;
  queryEntityRefs?: string[];
  abortSignal?: AbortSignal;
}

/**
 * Attempt direct-answer resolution.  Returns the eligibility verdict
 * produced by `isDirectAnswerEligible` with candidates materialized
 * from the caller-supplied sources.
 */
export async function tryDirectAnswer(
  input: DirectAnswerWiringInput,
): Promise<DirectAnswerResult> {
  const { query, namespace, config, sources, queryEntityRefs, abortSignal } = input;

  const eligibilityConfig: DirectAnswerConfig = {
    enabled: config.recallDirectAnswerEnabled,
    tokenOverlapFloor: config.recallDirectAnswerTokenOverlapFloor,
    importanceFloor: config.recallDirectAnswerImportanceFloor,
    ambiguityMargin: config.recallDirectAnswerAmbiguityMargin,
    eligibleTaxonomyBuckets: config.recallDirectAnswerEligibleTaxonomyBuckets,
  };

  // Short-circuit disabled case before touching any I/O.
  if (!eligibilityConfig.enabled) {
    return isDirectAnswerEligible({
      query,
      candidates: [],
      config: eligibilityConfig,
      queryEntityRefs,
    });
  }

  const memories = await sources.listCandidateMemories({ namespace, abortSignal });
  const candidates: DirectAnswerCandidate[] = [];

  for (const memory of memories) {
    if (abortSignal?.aborted) break;

    const trustZone = await sources.trustZoneFor(memory.frontmatter.id);
    // Cheap pre-filter: non-trusted memories can't qualify, so skip
    // taxonomy and importance resolution for them.
    if (trustZone !== "trusted") continue;

    const decision = resolveCategory(
      memory.content,
      memory.frontmatter.category,
      sources.taxonomy,
    );
    const taxonomyBucket = decision.categoryId;
    if (!eligibilityConfig.eligibleTaxonomyBuckets.includes(taxonomyBucket)) continue;

    const importanceScore = sources.importanceFor(memory);

    candidates.push({
      memory,
      trustZone,
      taxonomyBucket,
      importanceScore,
    });
  }

  return isDirectAnswerEligible({
    query,
    candidates,
    config: eligibilityConfig,
    queryEntityRefs,
  });
}
