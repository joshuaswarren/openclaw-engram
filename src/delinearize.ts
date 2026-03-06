/**
 * De-linearization transform (SimpleMem-inspired).
 *
 * Converts extracted memories from context-dependent to context-independent
 * by resolving coreferences and anchoring temporal expressions.
 */

interface EntityRef {
  name: string;
  type: "person" | "project" | "tool" | "company" | "place" | "other";
  facts: string[];
}

const PRONOUN_MAP: Record<string, { types: string[]; plural: boolean }> = {
  "he": { types: ["person"], plural: false },
  "she": { types: ["person"], plural: false },
  "him": { types: ["person"], plural: false },
  "her": { types: ["person"], plural: false },
  "his": { types: ["person"], plural: false },
  "they": { types: ["company", "project", "other"], plural: true },
  "them": { types: ["company", "project", "other"], plural: true },
  "their": { types: ["company", "project", "other"], plural: true },
  "it": { types: ["project", "tool", "company"], plural: false },
  "its": { types: ["project", "tool", "company"], plural: false },
};

/**
 * Replace pronouns with entity names when there's exactly one
 * matching entity of the right type (unambiguous resolution).
 */
export function resolveCoReferences(fact: string, entities: EntityRef[]): string {
  if (entities.length === 0) return fact;

  let result = fact;
  for (const [pronoun, info] of Object.entries(PRONOUN_MAP)) {
    const regex = new RegExp(`\\b${pronoun}\\b`, "gi");
    if (!regex.test(result)) continue;

    const candidates = entities.filter((e) => info.types.includes(e.type));
    if (candidates.length !== 1) continue;

    const entityName = candidates[0].name;
    result = result.replace(
      new RegExp(`\\b${pronoun}\\b`, "i"),
      entityName,
    );

    // Simple verb agreement fix for "they use" → "entity uses"
    if (pronoun.toLowerCase() === "they") {
      result = result.replace(
        new RegExp(`${escapeRegex(entityName)}\\s+(\\w+)\\b`),
        (match, verb: string) => {
          if (verb.endsWith("s") || verb.endsWith("ed") || verb.endsWith("ing")) return match;
          return `${entityName} ${verb}s`;
        },
      );
    }
  }
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const TEMPORAL_PATTERNS: Array<{
  pattern: RegExp;
  replace: (now: Date) => string;
}> = [
  {
    pattern: /\byesterday\b/gi,
    replace: (now) => {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
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
      d.setDate(d.getDate() + 1);
      return `on ${formatDate(d)}`;
    },
  },
  {
    pattern: /\blast week\b/gi,
    replace: (now) => {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return `around ${formatDate(d)}`;
    },
  },
  {
    pattern: /\blast month\b/gi,
    replace: (now) => {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      return `around ${formatDate(d)}`;
    },
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
    pattern: /\bearlier today\b/gi,
    replace: (now) => `earlier on ${formatDate(now)}`,
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
  entities: EntityRef[],
  timestamp: Date,
): string {
  let result = resolveCoReferences(factContent, entities);
  result = anchorTemporalExpressions(result, timestamp);
  return result;
}
