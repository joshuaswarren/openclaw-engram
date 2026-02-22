/**
 * HiMem — Episode/Note dual store (v8.0 Phase 2B)
 *
 * Classifies extracted memories as:
 *   episode — time-specific events, actions, observations (event fidelity)
 *   note    — stable beliefs, preferences, decisions, constraints
 *
 * Based on the HiMem paper: episodes are ephemeral, notes are reconsolidated
 * into a stable belief layer. This classification gates reconsolidation.
 */

export type MemoryKind = "episode" | "note";

/**
 * Keywords that signal a stable belief/preference/constraint.
 * If any appear in the content, lean toward "note".
 */
const NOTE_SIGNALS = [
  /\bprefers?\b/i,
  /\bwants?\b/i,
  /\bneeds?\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bmust\b/i,
  /\bshould\b/i,
  /\bgoal\b/i,
  /\bdecid(?:ed|es|e)\b/i,
  /\bpolic(?:y|ies)\b/i,
  /\brequir(?:es?|ement)\b/i,
  /\bconstraint\b/i,
  /\bstandard\b/i,
  /\bconvention\b/i,
];

/**
 * Keywords that signal a time-specific event/action.
 * If any appear in the content, lean toward "episode".
 */
const EPISODE_SIGNALS = [
  /\byesterday\b/i,
  /\btoday\b/i,
  /\blast\s+(?:week|month|year|Tuesday|Wednesday|Thursday|Friday|Monday|Sunday|Saturday)\b/i,
  /\bon\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\b(?:just|recently|earlier|this morning|this afternoon)\b/i,
  /\bdeployed\b/i,
  /\bpushed\b/i,
  /\bfixed\b/i,
  /\bmerged\b/i,
  /\breported\b/i,
  /\bmentioned\b/i,
  /\bsaid\b/i,
  /\bhappened\b/i,
  /\bfailed\b/i,
  /\bcompleted\b/i,
  /\bshipped\b/i,
];

/** Category names that strongly suggest a note (stable belief) */
const NOTE_CATEGORIES = new Set([
  "preference",
  "constraint",
  "goal",
  "habit",
  "policy",
  "standard",
  "belief",
  "decision",
]);

/** Category names that strongly suggest an episode */
const EPISODE_CATEGORIES = new Set(["event", "action", "observation", "issue", "bug", "incident"]);

/** Tag values that signal a stable belief */
const NOTE_TAGS = new Set(["preference", "constraint", "goal", "habit", "policy", "belief"]);

/** Tag values that signal a time-specific event */
const EPISODE_TAGS = new Set(["bug", "fix", "deploy", "incident", "release", "merge", "event"]);

/**
 * Classify a memory fact as "episode" (time-specific event) or "note"
 * (stable belief/preference/decision).
 *
 * @param content   - The memory's text content
 * @param tags      - Tags from extraction (checked for episode/note signals)
 * @param category  - Category from extraction
 * @returns "episode" | "note"
 */
export function classifyMemoryKind(
  content: string,
  tags: string[],
  category: string,
): MemoryKind {
  const lowerContent = content.toLowerCase();
  const lowerCategory = category.toLowerCase();

  // Temporal episode signals take top priority — explicit time refs override category
  for (const re of EPISODE_SIGNALS) {
    if (re.test(lowerContent)) return "episode";
  }

  // Tag-level episode signals (e.g. "bug", "deploy", "merge")
  for (const tag of tags) {
    if (EPISODE_TAGS.has(tag.toLowerCase())) return "episode";
  }

  // Category-level override (strong signals, but below temporal content markers)
  if (NOTE_CATEGORIES.has(lowerCategory)) return "note";
  if (EPISODE_CATEGORIES.has(lowerCategory)) return "episode";

  // Tag-level note signals (e.g. "preference", "goal")
  for (const tag of tags) {
    if (NOTE_TAGS.has(tag.toLowerCase())) return "note";
  }

  // Non-temporal note signals in content
  for (const re of NOTE_SIGNALS) {
    if (re.test(lowerContent)) return "note";
  }

  // Default: episode (preserves fidelity, safer to not promote to stable note)
  return "episode";
}

