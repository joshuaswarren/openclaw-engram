/**
 * Resolver decision tree for the MECE taxonomy.
 *
 * Given extracted content and its MemoryCategory, determines which
 * taxonomy category the knowledge should be filed under.
 */

import type { MemoryCategory } from "../types.js";
import type { ResolverDecision, Taxonomy, TaxonomyCategory } from "./types.js";

const DEFAULT_CATEGORY_ID = "facts";

/**
 * Resolve a piece of content to a taxonomy category.
 *
 * Algorithm:
 * 1. Find all taxonomy categories whose `memoryCategories` include
 *    the given `memoryCategory`.
 * 2. If exactly one match, return it with confidence 1.0.
 * 3. If multiple matches, pick the one with the lowest priority
 *    number (highest precedence). Apply keyword heuristics from
 *    filing rules as a secondary signal.
 * 4. If no match, fall back to the "facts" category (or first
 *    category if "facts" is absent) with low confidence.
 * 5. Always populate `alternatives` with other plausible categories.
 */
export function resolveCategory(
  content: string,
  memoryCategory: MemoryCategory,
  taxonomy: Taxonomy,
): ResolverDecision {
  const contentLower = content.toLowerCase();

  // Step 1: find matching categories
  const matches = taxonomy.categories.filter((cat) =>
    cat.memoryCategories.includes(memoryCategory),
  );

  if (matches.length === 0) {
    // No taxonomy category accepts this MemoryCategory — fall back
    const fallback =
      taxonomy.categories.find((c) => c.id === DEFAULT_CATEGORY_ID) ??
      taxonomy.categories[0];
    if (!fallback) {
      return {
        categoryId: DEFAULT_CATEGORY_ID,
        confidence: 0,
        reason: "Taxonomy is empty; using default category",
        alternatives: [],
      };
    }
    const alternatives = taxonomy.categories
      .filter((c) => c.id !== fallback.id)
      .map((c) => ({
        categoryId: c.id,
        reason: c.description,
      }));
    return {
      categoryId: fallback.id,
      confidence: 0.3,
      reason: `No taxonomy category maps to MemoryCategory "${memoryCategory}"; falling back to "${fallback.name}"`,
      alternatives,
    };
  }

  if (matches.length === 1) {
    const match = matches[0]!;
    const alternatives = taxonomy.categories
      .filter((c) => c.id !== match.id)
      .map((c) => ({
        categoryId: c.id,
        reason: c.description,
      }));
    return {
      categoryId: match.id,
      confidence: 1.0,
      reason: `Unique match: MemoryCategory "${memoryCategory}" maps to "${match.name}"`,
      alternatives,
    };
  }

  // Multiple matches — use filing rule keyword heuristics + priority
  const scored = matches.map((cat) => ({
    cat,
    keywordScore: computeKeywordScore(contentLower, cat),
  }));

  // Sort by keyword score descending, then priority ascending (lower wins)
  scored.sort((a, b) => {
    if (b.keywordScore !== a.keywordScore) return b.keywordScore - a.keywordScore;
    return a.cat.priority - b.cat.priority;
  });

  const best = scored[0]!;
  const runnerUp = scored[1];

  // Confidence is higher when keyword match clearly differentiates
  const confidence =
    best.keywordScore > 0 && (!runnerUp || best.keywordScore > runnerUp.keywordScore)
      ? 0.9
      : 0.7;

  const alternatives = taxonomy.categories
    .filter((c) => c.id !== best.cat.id)
    .map((c) => ({
      categoryId: c.id,
      reason: c.description,
    }));

  const reason =
    best.keywordScore > 0
      ? `Filing rules for "${best.cat.name}" matched content keywords (priority ${best.cat.priority})`
      : `Priority tie-break: "${best.cat.name}" has lowest priority number (${best.cat.priority})`;

  return {
    categoryId: best.cat.id,
    confidence,
    reason,
    alternatives,
  };
}

/**
 * Compute a simple keyword overlap score between content and
 * a category's filing rules + description.
 */
function computeKeywordScore(contentLower: string, cat: TaxonomyCategory): number {
  let score = 0;
  const ruleText = [...cat.filingRules, cat.description]
    .join(" ")
    .toLowerCase();

  // Extract meaningful words (3+ chars) from the rule text
  const keywords = ruleText
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

  for (const kw of keywords) {
    if (contentLower.includes(kw)) {
      score += 1;
    }
  }
  return score;
}
