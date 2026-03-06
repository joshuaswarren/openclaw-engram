/**
 * De-linearization transform (SimpleMem-inspired).
 *
 * Converts extracted memories from context-dependent to context-independent
 * by resolving coreferences and anchoring temporal expressions.
 */

import type { EntityMention } from "./types.js";

// possessive: true means the pronoun is a possessive form (his/her/its/their)
// and should be replaced with "entity's" or "entity's" form.
const PRONOUN_MAP: Record<string, { types: string[]; possessive: boolean }> = {
  "he": { types: ["person"], possessive: false },
  "she": { types: ["person"], possessive: false },
  "him": { types: ["person"], possessive: false },
  "her": { types: ["person"], possessive: true },
  "his": { types: ["person"], possessive: true },
  "they": { types: ["company", "project", "other"], possessive: false },
  "them": { types: ["company", "project", "other"], possessive: false },
  "their": { types: ["company", "project", "other"], possessive: true },
  "it": { types: ["project", "tool", "company"], possessive: false },
  "its": { types: ["project", "tool", "company"], possessive: true },
};

/**
 * Replace pronouns with entity names when there's exactly one
 * matching entity of the right type (unambiguous resolution).
 *
 * Possessive pronouns (his/her/its/their) become "entity's".
 * No verb agreement is attempted — it's too fragile with adverbs/modals.
 */
export function resolveCoReferences(fact: string, entities: EntityMention[]): string {
  if (entities.length === 0) return fact;

  let result = fact;
  for (const [pronoun, info] of Object.entries(PRONOUN_MAP)) {
    const regex = new RegExp(`\\b${pronoun}\\b`, "gi");
    if (!regex.test(result)) continue;

    const candidates = entities.filter((e) => info.types.includes(e.type));
    if (candidates.length !== 1) continue;

    const entityName = candidates[0].name;
    const replacement = info.possessive ? `${entityName}'s` : entityName;
    result = result.replace(
      new RegExp(`\\b${pronoun}\\b`, "i"),
      replacement,
    );
  }
  return result;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const TEMPORAL_PATTERNS: Array<{
  pattern: RegExp;
  replace: (now: Date) => string;
// Compound patterns first (longer matches before shorter to avoid partial replacement)
}> = [
  {
    pattern: /\bearlier today\b/gi,
    replace: (now) => `earlier on ${formatDate(now)}`,
  },
  {
    pattern: /\bthis morning\b/gi,
    replace: (now) => `on the morning of ${formatDate(now)}`,
  },
  {
    pattern: /\bthis afternoon\b/gi,
    replace: (now) => `on the afternoon of ${formatDate(now)}`,
  },
  {
    pattern: /\bthis evening\b/gi,
    replace: (now) => `on the evening of ${formatDate(now)}`,
  },
  {
    pattern: /\blast week\b/gi,
    replace: (now) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 7);
      return `around ${formatDate(d)}`;
    },
  },
  {
    pattern: /\blast month\b/gi,
    replace: (now) => {
      const d = new Date(now);
      d.setUTCDate(1); // avoid overflow (e.g. Mar 31 → Feb 31 → Mar 3)
      d.setUTCMonth(d.getUTCMonth() - 1);
      return `around ${formatDate(d)}`;
    },
  },
  // Simple patterns last
  {
    pattern: /\byesterday\b/gi,
    replace: (now) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 1);
      return `on ${formatDate(d)}`;
    },
  },
  {
    pattern: /\btoday\b/gi,
    replace: (now) => `on ${formatDate(now)}`,
  },
  {
    pattern: /\btomorrow\b/gi,
    replace: (now) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + 1);
      return `on ${formatDate(d)}`;
    },
  },
];

/**
 * Replace relative temporal expressions with absolute ISO-8601 dates.
 */
export function anchorTemporalExpressions(fact: string, now: Date): string {
  let result = fact;
  for (const { pattern, replace } of TEMPORAL_PATTERNS) {
    result = result.replace(pattern, replace(now));
  }
  return result;
}

/**
 * Full de-linearization pipeline: coreference + temporal anchoring.
 */
export function delinearize(
  factContent: string,
  entities: EntityMention[],
  timestamp: Date,
): string {
  let result = resolveCoReferences(factContent, entities);
  result = anchorTemporalExpressions(result, timestamp);
  return result;
}
