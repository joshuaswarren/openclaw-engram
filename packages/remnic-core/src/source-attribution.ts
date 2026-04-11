/**
 * Inline Source Attribution Protocol (issue #369)
 *
 * Extracted facts carry provenance inline inside the fact body, so the
 * citation survives prompt injection, copy/paste, and LLM quoting. This
 * complements — never replaces — the YAML frontmatter provenance stored on
 * disk.
 *
 * Default format (matches issue #369 proposal):
 *
 *   The foo service uses Redis for rate limiting. [Source: agent=planner, session=abc123, ts=2026-04-10T14:25:07Z]
 *
 * Key properties:
 *   - Inline (part of the body, not metadata).
 *   - Compact (typically <80 chars of overhead per fact).
 *   - Machine-parseable by a single regex.
 *   - Opt-in via `inlineSourceAttributionEnabled` config flag (default off
 *     for backwards compatibility with existing downstream consumers).
 *   - Legacy facts without a citation remain fully readable.
 *
 * The format template is configurable via `inlineSourceAttributionFormat`
 * with supported placeholders:
 *
 *   {agent}     — principal / agent identifier
 *   {session}   — full session key (colon-delimited)
 *   {sessionId} — short stable session id (trailing component)
 *   {ts}        — extraction timestamp (ISO 8601)
 *   {date}      — extraction date (YYYY-MM-DD)
 *
 * Any privacy-sensitive identifiers should be normalized before being passed
 * to `formatCitation` — the helper treats them as opaque strings.
 */

/** Default citation format template (matches issue #369). */
export const DEFAULT_CITATION_FORMAT =
  "[Source: agent={agent}, session={sessionId}, ts={ts}]";

/** Sentinel value used when a provenance field is missing. */
export const CITATION_UNKNOWN = "unknown";

export interface CitationContext {
  /** Principal / agent identifier (e.g. resolved via resolvePrincipal). */
  agent?: string;
  /** Full session key (e.g. "agent:planner:main"). */
  session?: string;
  /**
   * Opaque short session id. Derived from the trailing component of the
   * session key when not provided explicitly. Use this for compact formats
   * that do not need the full colon-delimited session key.
   */
  sessionId?: string;
  /** Extraction timestamp as an ISO 8601 string. */
  ts?: string;
}

export interface ParsedCitation {
  /** Agent identifier parsed from the citation (never crashes on malformed input). */
  agent?: string;
  /** Session identifier parsed from the citation. */
  session?: string;
  /** Extraction timestamp parsed from the citation. */
  ts?: string;
  /** The full matched citation substring. */
  raw: string;
}

/**
 * Regex that matches the default `[Source: agent=X, session=Y, ts=Z]` shape
 * as well as human-edited variants (extra whitespace, reordered fields,
 * subset of fields). Matches non-greedily so it can be anchored anywhere in
 * the text. Kept as a getter factory so callers do not share regex state.
 */
function defaultCitationMatcher(): RegExp {
  return /\[Source:\s*([^\]\n]+?)\]/gi;
}

/**
 * Derive a short session id from a full session key.
 * Falls back to the raw session string if no colon is present.
 */
export function deriveSessionId(session: string | undefined): string | undefined {
  if (!session) return undefined;
  const trimmed = session.trim();
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split(":").filter((p) => p.length > 0);
  if (parts.length === 0) return trimmed;
  return parts[parts.length - 1];
}

/**
 * Format an inline citation tag using the provided template.
 *
 * Missing context fields fall back to {@link CITATION_UNKNOWN} — the caller
 * should always get a non-empty, parseable tag.
 */
export function formatCitation(
  ctx: CitationContext,
  template: string = DEFAULT_CITATION_FORMAT,
): string {
  const session = ctx.session ?? "";
  const sessionId = ctx.sessionId ?? deriveSessionId(session) ?? CITATION_UNKNOWN;
  const ts = ctx.ts ?? CITATION_UNKNOWN;
  const agent = ctx.agent && ctx.agent.trim().length > 0 ? ctx.agent : CITATION_UNKNOWN;
  const date = ts && ts !== CITATION_UNKNOWN ? ts.slice(0, 10) : CITATION_UNKNOWN;
  const sessionForTemplate = session.trim().length > 0 ? session : CITATION_UNKNOWN;

  return template
    .replace(/\{agent\}/g, agent)
    .replace(/\{session\}/g, sessionForTemplate)
    .replace(/\{sessionId\}/g, sessionId)
    .replace(/\{ts\}/g, ts)
    .replace(/\{date\}/g, date);
}

/**
 * Returns true if the text already carries at least one citation marker.
 * Safe to call on any string — never throws.
 */
export function hasCitation(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return defaultCitationMatcher().test(text);
}

/**
 * Attach an inline citation to fact text.
 *
 * If the text already has a citation, it is returned unchanged — existing
 * provenance is respected and never overwritten. Otherwise the citation is
 * appended to the trimmed text with a single space separator, which keeps
 * the marker visually adjacent to the fact body.
 */
export function attachCitation(
  text: string,
  ctx: CitationContext,
  template: string = DEFAULT_CITATION_FORMAT,
): string {
  if (typeof text !== "string") return text as unknown as string;
  if (hasCitation(text)) return text;
  const trimmedEnd = text.replace(/\s+$/u, "");
  if (trimmedEnd.length === 0) return text;
  const citation = formatCitation(ctx, template);
  // Preserve any trailing newline that callers rely on for markdown rendering.
  const trailing = text.slice(trimmedEnd.length);
  return `${trimmedEnd} ${citation}${trailing}`;
}

/**
 * Parse a single inline citation from a piece of text. Returns the first
 * citation encountered or `null` when none is present. Malformed citations
 * do not throw — fields that cannot be parsed simply remain `undefined`.
 */
export function parseCitation(text: string): ParsedCitation | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const matcher = defaultCitationMatcher();
  const match = matcher.exec(text);
  if (!match) return null;

  const body = match[1] ?? "";
  const raw = match[0] ?? "";
  const parsed: ParsedCitation = { raw };

  const fields = body
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  for (const field of fields) {
    const eqIdx = field.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = field.slice(0, eqIdx).trim().toLowerCase();
    const value = field.slice(eqIdx + 1).trim();
    if (value.length === 0) continue;
    switch (key) {
      case "agent":
        parsed.agent = value;
        break;
      case "session":
      case "sessionid":
        parsed.session = value;
        break;
      case "ts":
      case "timestamp":
        parsed.ts = value;
        break;
      default:
        // Unknown fields are ignored defensively so human edits never crash.
        break;
    }
  }

  return parsed;
}

/**
 * Parse every citation embedded in the text. Always returns an array; empty
 * when none are present.
 */
export function parseAllCitations(text: string): ParsedCitation[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const matcher = defaultCitationMatcher();
  const results: ParsedCitation[] = [];
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const parsed = parseCitation(match[0]);
    if (parsed) results.push(parsed);
  }
  return results;
}

/**
 * Remove all inline citations from a piece of text.
 *
 * Callers that want the raw fact body (for dedup hashing, display, or
 * comparison) should use this helper instead of hand-rolled regexes so the
 * whole codebase agrees on the citation syntax.
 */
export function stripCitation(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const cleaned = text.replace(defaultCitationMatcher(), "");
  // Collapse whitespace left behind by the stripped marker and trim tail
  // whitespace so round-trip attach → strip is idempotent.
  return cleaned.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+(\n|$)/g, "$1").trimEnd();
}
