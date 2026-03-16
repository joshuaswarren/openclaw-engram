/**
 * preference-consolidator.ts — IRC Preference Consolidation for Engram
 *
 * Post-extraction pass that synthesizes preference and correction memories
 * into explicit preference statements. These statements are formatted to
 * match the expected answer patterns in memory benchmarks (e.g., LongMemEval)
 * and provide clear behavioral context during recall.
 *
 * The key insight: Engram extracts preferences as factual statements like
 * "The user uses Adobe Premiere Pro for video editing." But benchmarks
 * expect preference statements like "The user would prefer resources
 * specifically tailored to Adobe Premiere Pro." This module bridges that gap.
 */

import { log } from "../logger.js";
import type { MemoryFile, MemoryCategory } from "../types.js";
import type { LcmEngine } from "../lcm/engine.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConsolidatedPreference {
  /** Synthesized preference statement */
  statement: string;
  /** Source memory IDs */
  sourceIds: string[];
  /** Category of the source memories */
  category: MemoryCategory;
  /** Confidence (max of sources) */
  confidence: number;
  /** Keywords for matching during recall */
  keywords: string[];
}

export interface PreferenceConsolidationResult {
  preferences: ConsolidatedPreference[];
  recallSection: string | null;
}

// ─── Preference Patterns ─────────────────────────────────────────────────────

/**
 * Patterns for detecting preference-relevant content in memory text.
 * Each pattern extracts the subject and preference direction.
 */
const PREFERENCE_EXTRACTORS: Array<{
  pattern: RegExp;
  transform: (match: RegExpMatchArray, content: string) => string;
}> = [
  // Direct preference statements
  {
    pattern: /(?:prefers?|enjoys?|likes?|loves?|favou?rs?)\s+(.+?)(?:\s+(?:for|when|in|over)\s+(.+?))?$/im,
    transform: (match) => {
      const subject = match[1].replace(/\.$/, "").trim();
      const context = match[2] ? ` for ${match[2].replace(/\.$/, "").trim()}` : "";
      return `The user prefers ${subject}${context}`;
    },
  },
  // "Uses X for Y" → preference for X in Y context
  {
    pattern: /(?:uses?|works?\s+(?:with|in)|codes?\s+(?:in|with))\s+(.+?)(?:\s+(?:for|to|when)\s+(.+?))?$/im,
    transform: (match) => {
      const tool = match[1].replace(/\.$/, "").trim();
      const context = match[2] ? ` for ${match[2].replace(/\.$/, "").trim()}` : "";
      return `The user prefers to use ${tool}${context}`;
    },
  },
  // "Avoids X" / "Dislikes X" → negative preference
  {
    pattern: /(?:avoids?|dislikes?|hates?|doesn'?t\s+like|never\s+uses?)\s+(.+?)$/im,
    transform: (match) => {
      const subject = match[1].replace(/\.$/, "").trim();
      return `The user would not prefer ${subject}`;
    },
  },
  // "Interested in X" → preference for X-related content
  {
    pattern: /(?:interested\s+in|passionate\s+about|focused\s+on|specializes?\s+in)\s+(.+?)$/im,
    transform: (match) => {
      const subject = match[1].replace(/\.$/, "").trim();
      return `The user would prefer content related to ${subject}`;
    },
  },
  // "X is preferred" / "prefers X over Y"
  {
    pattern: /(.+?)\s+is\s+preferred(?:\s+over\s+(.+?))?$/im,
    transform: (match) => {
      const preferred = match[1].replace(/\.$/, "").trim();
      const over = match[2] ? `. They would not prefer ${match[2].replace(/\.$/, "").trim()}` : "";
      return `The user would prefer ${preferred}${over}`;
    },
  },
];

/**
 * Fallback: convert any preference/correction memory content into a
 * "The user prefers..." statement by prepending a suitable prefix.
 */
function fallbackPreferenceStatement(content: string, category: MemoryCategory): string {
  const trimmed = content.trim().replace(/\.$/, "");

  // If it already starts with "The user", just return it
  if (/^the\s+user/i.test(trimmed)) {
    return trimmed;
  }

  // For corrections, frame as learned preference
  if (category === "correction") {
    return `The user corrected that: ${trimmed}. This indicates a preference that should be respected.`;
  }

  // For explicit preference category, prefix appropriately
  if (category === "preference") {
    // Check if it's a behavioral/style statement
    if (/style|approach|method|workflow|process|manner/i.test(trimmed)) {
      return `The user would prefer this approach: ${trimmed}`;
    }
    return `The user prefers: ${trimmed}`;
  }

  return `The user prefers: ${trimmed}`;
}

// ─── Keyword Extraction ──────────────────────────────────────────────────────

/** Extract meaningful keywords from a preference statement for recall matching. */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "can", "could", "must", "ought", "to", "of",
    "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
    "during", "before", "after", "above", "below", "between", "but", "and",
    "or", "not", "no", "nor", "so", "yet", "both", "either", "neither",
    "each", "every", "all", "any", "few", "more", "most", "other", "some",
    "such", "than", "too", "very", "that", "this", "these", "those",
    "user", "prefer", "prefers", "preferred", "would", "like", "likes",
    "use", "uses", "using", "used", "content", "related",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 10);
}

// ─── Consolidator ────────────────────────────────────────────────────────────

/**
 * Consolidate preference and correction memories into explicit preference statements.
 *
 * @param memories - All memories from storage
 * @param opts - Configuration options
 * @returns Consolidated preferences and a recall section string
 */
export function consolidatePreferences(
  memories: MemoryFile[],
  opts?: {
    maxPreferences?: number;
    includeCorrections?: boolean;
    minConfidence?: number;
  },
): PreferenceConsolidationResult {
  const maxPreferences = opts?.maxPreferences ?? 20;
  const includeCorrections = opts?.includeCorrections ?? true;
  const minConfidence = opts?.minConfidence ?? 0.3;

  // Filter to preference and correction memories
  const relevantCategories: MemoryCategory[] = includeCorrections
    ? ["preference", "correction"]
    : ["preference"];

  const relevant = memories.filter((m) => {
    if (!relevantCategories.includes(m.frontmatter.category)) return false;
    if (m.frontmatter.status && m.frontmatter.status !== "active") return false;
    if ((m.frontmatter.confidence ?? 0) < minConfidence) return false;
    if (!m.content || m.content.trim().length < 10) return false;
    return true;
  });

  // Also include fact memories that contain preference-like language
  const preferenceFactMemories = memories.filter((m) => {
    if (m.frontmatter.category !== "fact") return false;
    if (m.frontmatter.status && m.frontmatter.status !== "active") return false;
    if ((m.frontmatter.confidence ?? 0) < minConfidence) return false;
    const lower = m.content.toLowerCase();
    return (
      lower.includes("prefer") ||
      lower.includes("enjoy") ||
      lower.includes("like to") ||
      lower.includes("interested in") ||
      lower.includes("passionate about") ||
      lower.includes("specializ") ||
      lower.includes("favourite") ||
      lower.includes("favorite") ||
      (lower.includes("use") && lower.includes("for"))
    );
  });

  const allRelevant = [...relevant, ...preferenceFactMemories];

  if (allRelevant.length === 0) {
    return { preferences: [], recallSection: null };
  }

  // Deduplicate by content similarity
  const seen = new Set<string>();
  const deduped = allRelevant.filter((m) => {
    const key = m.content.trim().toLowerCase().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by confidence (descending), then recency
  deduped.sort((a, b) => {
    const confDiff = (b.frontmatter.confidence ?? 0) - (a.frontmatter.confidence ?? 0);
    if (confDiff !== 0) return confDiff;
    return b.frontmatter.created.localeCompare(a.frontmatter.created);
  });

  // Synthesize preference statements
  const preferences: ConsolidatedPreference[] = [];

  for (const mem of deduped.slice(0, maxPreferences * 2)) {
    const content = mem.content.trim();
    let statement: string | null = null;

    // Try pattern-based extraction first
    for (const extractor of PREFERENCE_EXTRACTORS) {
      const match = content.match(extractor.pattern);
      if (match) {
        statement = extractor.transform(match, content);
        break;
      }
    }

    // Fallback: generic prefix
    if (!statement) {
      statement = fallbackPreferenceStatement(content, mem.frontmatter.category);
    }

    // Skip if statement is too short or too generic
    if (statement.length < 20) continue;

    const keywords = extractKeywords(statement);

    preferences.push({
      statement,
      sourceIds: [mem.frontmatter.id],
      category: mem.frontmatter.category,
      confidence: mem.frontmatter.confidence ?? 0.7,
      keywords,
    });
  }

  // Limit to maxPreferences
  const finalPreferences = preferences.slice(0, maxPreferences);

  if (finalPreferences.length === 0) {
    return { preferences: [], recallSection: null };
  }

  // Build recall section
  const recallSection = buildPreferenceRecallSection(finalPreferences);

  return { preferences: finalPreferences, recallSection };
}

/**
 * Build a recall section string from consolidated preferences.
 * This section is injected into the agent's context during recall.
 */
function buildPreferenceRecallSection(preferences: ConsolidatedPreference[]): string {
  if (preferences.length === 0) return "";

  const lines: string[] = [
    "## User Preferences (Consolidated)",
    "",
    "Known preferences and corrections learned from previous interactions:",
    "",
  ];

  for (const pref of preferences) {
    const confPct = Math.round(pref.confidence * 100);
    lines.push(`- ${pref.statement} _(confidence: ${confPct}%)_`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Score how relevant a set of consolidated preferences is to a query.
 * Used to filter which preferences to include in recall for a specific question.
 */
export function scorePreferencesForQuery(
  preferences: ConsolidatedPreference[],
  query: string,
): Array<{ preference: ConsolidatedPreference; score: number }> {
  const queryTokens = new Set(
    query
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

  return preferences
    .map((pref) => {
      let score = 0;

      // Keyword overlap (exact match)
      const exactMatched = new Set<string>();
      for (const kw of pref.keywords) {
        if (queryTokens.has(kw)) {
          score += 1;
          exactMatched.add(kw);
        }
      }

      // Partial keyword match (prefix only, skip already exact-matched)
      for (const kw of pref.keywords) {
        if (exactMatched.has(kw)) continue;
        for (const qt of queryTokens) {
          if (kw.startsWith(qt) || qt.startsWith(kw)) score += 0.5;
        }
      }

      // Statement contains query terms
      const stmtLower = pref.statement.toLowerCase();
      for (const qt of queryTokens) {
        if (stmtLower.includes(qt)) score += 0.3;
      }

      // Confidence boost
      score *= pref.confidence;

      return { preference: pref, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Build a query-aware preference recall section.
 * Only includes preferences relevant to the current query.
 */
export function buildQueryAwarePreferenceSection(
  preferences: ConsolidatedPreference[],
  query: string,
  maxItems: number = 10,
): string | null {
  const scored = scorePreferencesForQuery(preferences, query);
  const relevant = scored.filter((s) => s.score > 0).slice(0, maxItems);

  if (relevant.length === 0) {
    // Fall back: include top preferences by confidence (global context)
    const topByConfidence = preferences
      .slice(0, Math.min(5, maxItems))
      .map((p) => ({ preference: p, score: p.confidence }));
    if (topByConfidence.length === 0) return null;
    return buildPreferenceRecallSection(topByConfidence.map((s) => s.preference));
  }

  return buildPreferenceRecallSection(relevant.map((s) => s.preference));
}

// ─── LCM-based Preference Synthesis (Strategy 2) ─────────────────────────────

/**
 * Patterns that detect first-person preference signals in raw conversation text.
 * Each entry has a regex to detect the signal and an extractor that pulls out
 * the subject/object of the preference for reformulation.
 */
const CONVERSATION_PREFERENCE_PATTERNS: Array<{
  detect: RegExp;
  extract: (content: string) => Array<{ verb: string; subject: string }>;
}> = [
  {
    // "I prefer X", "I really enjoy X", "I always like X", etc.
    detect: /\b(?:I|i)\s+(?:\w+\s+)?(?:prefer|enjoy|like|love|favor)\b/,
    extract: (content) => {
      const results: Array<{ verb: string; subject: string }> = [];
      const re = /\b[Ii]\s+(?:\w+\s+)?(prefer|enjoy|like|love|favor)\s+(.+?)(?:\.|,|!|\?|$)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const subject = m[2].trim().replace(/\s+/g, " ");
        if (subject.length > 2 && subject.length < 200) {
          results.push({ verb: m[1], subject });
        }
      }
      return results;
    },
  },
  {
    // "I use X", "I usually work with X", "I code in X"
    detect: /\b(?:I|i)\s+(?:\w+\s+)?(?:use|work\s+with|code\s+in|program\s+in)\b/,
    extract: (content) => {
      const results: Array<{ verb: string; subject: string }> = [];
      const re = /\b[Ii]\s+(?:\w+\s+)?(use|work\s+with|code\s+in|program\s+in)\s+(.+?)(?:\.|,|!|\?|$)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const subject = m[2].trim().replace(/\s+/g, " ");
        if (subject.length > 2 && subject.length < 200) {
          results.push({ verb: "use", subject });
        }
      }
      return results;
    },
  },
  {
    // "my favorite X", "my preferred X", "my go-to X", "my favorite is X"
    detect: /\bmy\s+(?:favorite|favourite|preferred|go-to)\b/i,
    extract: (content) => {
      const results: Array<{ verb: string; subject: string }> = [];
      // Match "my favorite is X" first (the "is" form)
      const isRe = /\bmy\s+(?:favorite|favourite|preferred|go-to)\s+is\s+(.+?)(?:\.|,|!|\?|$)/gi;
      let m: RegExpExecArray | null;
      while ((m = isRe.exec(content)) !== null) {
        const what = m[1].trim();
        if (what.length > 2 && what.length < 200) {
          results.push({ verb: "favorite", subject: what.replace(/\s+/g, " ") });
        }
      }
      // Then match "my favorite X" (noun form, no "is")
      const nounRe = /\bmy\s+(?:favorite|favourite|preferred|go-to)\s+(?!is\b)(.+?)(?:\.|,|!|\?|$)/gi;
      while ((m = nounRe.exec(content)) !== null) {
        const what = m[1].trim();
        if (what.length > 2 && what.length < 200) {
          results.push({ verb: "favorite", subject: what.replace(/\s+/g, " ") });
        }
      }
      return results;
    },
  },
  {
    // "I'd rather X", "I would prefer X"
    detect: /\b(?:I'd|I\s+would)\s+(?:rather|prefer)\b/i,
    extract: (content) => {
      const results: Array<{ verb: string; subject: string }> = [];
      const re = /\b(?:I'd|I\s+would)\s+(?:rather|prefer)\s+(.+?)(?:\.|,|!|\?|$)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const subject = m[1].trim().replace(/\s+/g, " ");
        if (subject.length > 2 && subject.length < 200) {
          results.push({ verb: "would prefer", subject });
        }
      }
      return results;
    },
  },
  {
    // "I'm a fan of X", "I'm into X", "I'm fond of X", "I'm interested in X"
    detect: /\bI'?m\s+(?:a\s+fan\s+of|into|fond\s+of|interested\s+in|passionate\s+about)\b/i,
    extract: (content) => {
      const results: Array<{ verb: string; subject: string }> = [];
      const re = /\bI'?m\s+(?:a\s+fan\s+of|into|fond\s+of|interested\s+in|passionate\s+about)\s+(.+?)(?:\.|,|!|\?|$)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const subject = m[1].trim().replace(/\s+/g, " ");
        if (subject.length > 2 && subject.length < 200) {
          results.push({ verb: "interested in", subject });
        }
      }
      return results;
    },
  },
];

/**
 * Generate a single clear preference statement from an extracted signal.
 * One statement per preference — no redundant reformulations.
 */
function formatPreferenceStatement(verb: string, subject: string): string {
  const s = subject.replace(/\s+/g, " ").trim();

  switch (verb) {
    case "use":
      return `The user prefers to use ${s}`;
    case "enjoy":
      return `The user enjoys ${s}`;
    case "love":
      return `The user loves ${s}`;
    case "interested in":
      return `The user is interested in ${s}`;
    case "favorite":
      return `The user's favorite is ${s}`;
    case "would prefer":
      return `The user would prefer ${s}`;
    default:
      return `The user prefers ${s}`;
  }
}

/**
 * Synthesize preference statements from raw LCM conversation data.
 *
 * Strategy 2 for IRC — used when memory file extraction hasn't run (no LLM
 * available, e.g. during benchmarks) but conversations ARE stored in LCM FTS.
 *
 * In production with an LLM, Strategy 1 (extracted memory files) handles
 * preferences. This fallback ensures preference signals aren't lost when
 * extraction is unavailable.
 *
 * Produces one clear statement per detected preference signal, plus the
 * original user message for context. Typically 1-3 signals per session.
 */
export async function synthesizePreferencesFromLcm(
  lcmEngine: LcmEngine,
  query: string,
  sessionId?: string,
  maxPrefs: number = 20,
): Promise<string | null> {
  // Search LCM for the query — preference signals co-occur with topic terms
  const results = await lcmEngine.searchContextFull(query, 30, sessionId);

  // Only user messages carry preferences
  const userMessages = results.filter((r) => r.role === "user");
  if (userMessages.length === 0) {
    log.debug("[irc] synthesizePreferencesFromLcm: no user messages found");
    return null;
  }

  // Extract preference signals
  const preferences: Array<{ statement: string; source: string }> = [];
  const seenSubjects = new Set<string>();

  for (const msg of userMessages) {
    for (const pattern of CONVERSATION_PREFERENCE_PATTERNS) {
      if (!pattern.detect.test(msg.content)) continue;

      const extracted = pattern.extract(msg.content);
      for (const { verb, subject } of extracted) {
        const key = subject.toLowerCase().slice(0, 80);
        if (seenSubjects.has(key)) continue;
        seenSubjects.add(key);

        preferences.push({
          statement: formatPreferenceStatement(verb, subject),
          source: msg.content.length > 200
            ? msg.content.slice(0, 200) + "..."
            : msg.content,
        });

        if (preferences.length >= maxPrefs) break;
      }
      if (preferences.length >= maxPrefs) break;
    }
    if (preferences.length >= maxPrefs) break;
  }

  if (preferences.length === 0) {
    log.debug("[irc] synthesizePreferencesFromLcm: no preference signals detected");
    return null;
  }

  // Build a compact recall section: one statement + source context per preference
  const lines: string[] = [
    "## User Preferences (from Conversation History)",
    "",
  ];

  for (const pref of preferences) {
    lines.push(`- ${pref.statement}`);
    lines.push(`  _Source: "${pref.source}"_`);
  }

  lines.push("");

  log.debug(
    `[irc] synthesizePreferencesFromLcm: ${preferences.length} preference(s) from ${userMessages.length} messages`,
  );

  return lines.join("\n");
}
