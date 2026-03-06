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
  // "her" omitted — ambiguous between object ("saw her") and possessive ("her stack")
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
 *
 * Guards against:
 * - Multiple pronouns of the same entity type → skip all (ambiguous referent)
 * - Entity names containing pronoun substrings → placeholder-based two-pass
 * - Entity names containing $ → escaped before replacement
 */
export function resolveCoReferences(fact: string, entities: EntityMention[]): string {
  if (entities.length === 0) return fact;

  // First pass: collect which pronoun entries match and which entity type they target.
  // If multiple distinct pronoun groups resolve to the same entity type, skip them all
  // (e.g., "She told him" with one person entity → ambiguous, leave unchanged).
  const matchingEntries: Array<{ pronoun: string; info: { types: string[]; possessive: boolean }; entity: EntityMention }> = [];
  const typeToPronouns = new Map<string, Set<string>>();

  for (const [pronoun, info] of Object.entries(PRONOUN_MAP)) {
    const regex = new RegExp(`\\b${pronoun}\\b`, "gi");
    if (!regex.test(fact)) continue;

    const candidates = entities.filter((e) => info.types.includes(e.type));
    if (candidates.length !== 1) continue;

    matchingEntries.push({ pronoun, info, entity: candidates[0] });

    // Track which pronoun groups target which entity type
    for (const t of info.types) {
      if (!typeToPronouns.has(t)) typeToPronouns.set(t, new Set());
      typeToPronouns.get(t)!.add(pronoun);
    }
  }

  // Determine which entity types have ambiguous multi-pronoun references
  const ambiguousTypes = new Set<string>();
  for (const [type, pronouns] of typeToPronouns) {
    const matchedEntities = entities.filter((e) => e.type === type);
    if (matchedEntities.length === 1 && pronouns.size > 1) {
      ambiguousTypes.add(type);
    }
  }

  // Filter out entries whose entity type is ambiguous
  const safeEntries = matchingEntries.filter(
    (e) => !e.info.types.some((t) => ambiguousTypes.has(t)),
  );

  if (safeEntries.length === 0) return fact;

  // Two-pass replacement using placeholders to prevent entity names
  // from being re-matched by subsequent pronoun patterns.
  let result = fact;
  const placeholders: string[] = [];

  for (const { pronoun, info, entity } of safeEntries) {
    const placeholder = `\x00ENTITY_${placeholders.length}\x00`;
    const safeEntityName = entity.name.replace(/\$/g, "$$$$");
    const replacement = info.possessive ? `${safeEntityName}'s` : safeEntityName;
    placeholders.push(replacement);
    result = result.replace(
      new RegExp(`\\b${pronoun}\\b`, "gi"),
      placeholder,
    );
  }

  // Restore placeholders with actual entity names
  for (let i = 0; i < placeholders.length; i++) {
    result = result.replaceAll(`\x00ENTITY_${i}\x00`, placeholders[i]);
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
