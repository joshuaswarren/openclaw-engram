/**
 * Renderers for RecallTierExplain (issue #518).
 *
 * Pure functions that format a `LastRecallSnapshot` and its
 * optional `tierExplain` field for human text and machine JSON
 * consumption.  CLI / HTTP / MCP surfaces consume these — they do
 * not format explain output themselves, so rendering is tested in
 * one place.
 */

import type { LastRecallSnapshot } from "./recall-state.js";
import type { RecallTierExplain, RetrievalTier } from "./types.js";

const KNOWN_RETRIEVAL_TIERS: readonly RetrievalTier[] = [
  "exact-cache",
  "fuzzy-cache",
  "direct-answer",
  "hybrid",
  "rerank-graph",
  "agentic",
];

function isRetrievalTier(v: unknown): v is RetrievalTier {
  return typeof v === "string" && (KNOWN_RETRIEVAL_TIERS as readonly string[]).includes(v);
}

/**
 * Narrow an arbitrary persisted field to a non-empty string, or null.  Used
 * for the top-level snapshot fields the renderer advertises as
 * `string | null` in its JSON schema: `sessionKey`, `recordedAt`,
 * `namespace`, `source`.  `LastRecallStore.load()` ingests `last_recall.json`
 * via unvalidated `JSON.parse`, so stale/corrupt state could return numbers,
 * objects, or empty strings for these fields.  Empty strings are coerced to
 * null so downstream `?? "(unknown)"` fallbacks work as intended; `"" ??
 * "(unknown)"` would otherwise still be `""`.
 */
function sanitizeString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Narrow an arbitrary persisted numeric field to a finite number or null.
 * `typeof NaN === "number"`, so a plain `typeof` check lets corrupt state
 * through.  `JSON.stringify(NaN)` silently emits `null`, so the JSON payload
 * ends up contradicting its own `number` schema; the text renderer would
 * print literal `NaN`.  Use `Number.isFinite` to match other defensive
 * parsers in the codebase (recall-state.ts, access-mcp.ts).
 */
function sanitizeFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export type RecallExplainFormat = "text" | "json";

export interface RecallExplainJsonPayload {
  hasExplain: boolean;
  snapshotFound: boolean;
  sessionKey: string | null;
  recordedAt: string | null;
  namespace: string | null;
  memoryIds: string[];
  source: string | null;
  sourcesUsed: string[] | null;
  latencyMs: number | null;
  tierExplain: RecallTierExplain | null;
}

/**
 * Defensively validate and normalize a tierExplain value.  Returns a fresh,
 * well-shaped `RecallTierExplain` if the input is usable, otherwise null.
 *
 * `LastRecallStore.load()` ingests `last_recall.json` via unvalidated
 * `JSON.parse`, so the runtime value may be null, undefined, a non-object, or
 * an object with malformed fields (e.g., `filteredBy: null`, `tier: 0`).
 * Without this guard the renderer can crash (`TypeError` from spreading a
 * non-iterable) and produce an internally inconsistent payload (hasExplain
 * true while the serialized tierExplain is null).  All rendering paths and
 * `hasExplain` derive from this single predicate so the payload is coherent.
 */
function normalizeTierExplain(value: unknown): RecallTierExplain | null {
  // Plain-object check: reject null/undefined/primitive, and also arrays
  // (typeof [] === "object").  An array tierExplain from a corrupt snapshot
  // would otherwise be coerced into a synthetic explain with all-zero
  // defaults, which falsely sets hasExplain=true and misleads consumers.
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const filteredBy = Array.isArray(raw.filteredBy)
    ? raw.filteredBy.filter((x): x is string => typeof x === "string")
    : [];
  const sourceAnchors = Array.isArray(raw.sourceAnchors)
    ? raw.sourceAnchors
        .filter(
          (a): a is { path: string; lineRange?: unknown } =>
            !!a && typeof a === "object" && typeof (a as { path?: unknown }).path === "string",
        )
        .map((a) => {
          const lr = (a as { lineRange?: unknown }).lineRange;
          // Require both entries to be finite numbers — NaN/Infinity from a
          // corrupt snapshot would otherwise pass a plain typeof check.
          const lineRange =
            Array.isArray(lr) &&
            lr.length === 2 &&
            Number.isFinite(lr[0]) &&
            Number.isFinite(lr[1])
              ? ([lr[0] as number, lr[1] as number] as [number, number])
              : undefined;
          return lineRange
            ? { path: (a as { path: string }).path, lineRange }
            : { path: (a as { path: string }).path };
        })
    : undefined;
  // A malformed/unknown tier is preserved as a string so operators can still
  // see what was written, but we coerce to `hybrid` (the generic fallback)
  // when it does not match the closed union so downstream consumers stay
  // well-typed.  Reject the whole explain only when structural invariants
  // fail (non-object); string/number mismatches degrade gracefully.
  return {
    tier: isRetrievalTier(raw.tier) ? raw.tier : "hybrid",
    tierReason: typeof raw.tierReason === "string" ? raw.tierReason : "",
    filteredBy,
    candidatesConsidered: sanitizeFiniteNumber(raw.candidatesConsidered) ?? 0,
    latencyMs: sanitizeFiniteNumber(raw.latencyMs) ?? 0,
    ...(sourceAnchors !== undefined ? { sourceAnchors } : {}),
  };
}

export function toRecallExplainJson(
  snapshot: LastRecallSnapshot | null,
): RecallExplainJsonPayload {
  if (!snapshot) {
    return {
      hasExplain: false,
      snapshotFound: false,
      sessionKey: null,
      recordedAt: null,
      namespace: null,
      memoryIds: [],
      source: null,
      sourcesUsed: null,
      latencyMs: null,
      tierExplain: null,
    };
  }
  // Single predicate: derive both `hasExplain` and the serialized `tierExplain`
  // from the same normalized value so the payload is never internally
  // inconsistent, even against malformed persisted state.
  const normalizedExplain = normalizeTierExplain(snapshot.tierExplain);
  // Top-level fields are forwarded from LastRecallStore.load(), which casts a
  // raw JSON.parse result.  Sanitize each field to the schema the payload
  // advertises so downstream HTTP/MCP consumers can rely on `string | null`
  // and `string[]` invariants even against a stale/corrupt file.
  return {
    hasExplain: normalizedExplain !== null,
    snapshotFound: true,
    sessionKey: sanitizeString(snapshot.sessionKey),
    recordedAt: sanitizeString(snapshot.recordedAt),
    namespace: sanitizeString(snapshot.namespace),
    memoryIds: Array.isArray(snapshot.memoryIds)
      ? snapshot.memoryIds.filter((x): x is string => typeof x === "string")
      : [],
    source: sanitizeString(snapshot.source),
    sourcesUsed: Array.isArray(snapshot.sourcesUsed)
      ? snapshot.sourcesUsed.filter((x): x is string => typeof x === "string")
      : null,
    latencyMs: sanitizeFiniteNumber(snapshot.latencyMs),
    tierExplain: normalizedExplain,
  };
}

/**
 * Human-readable text rendering.  Fixed layout so the output is easy
 * to grep and diff; do not introduce locale-specific formatting.
 */
export function toRecallExplainText(
  snapshot: LastRecallSnapshot | null,
): string {
  const lines: string[] = ["=== Recall Explain ==="];

  if (!snapshot) {
    lines.push("No recall snapshot recorded yet.");
    return lines.join("\n");
  }

  // Sanitize the same top-level fields the JSON payload sanitizes so text
  // output is equally robust to a stale/corrupt last_recall.json.
  const sessionKey = sanitizeString(snapshot.sessionKey);
  const recordedAt = sanitizeString(snapshot.recordedAt);
  const namespace = sanitizeString(snapshot.namespace);
  const source = sanitizeString(snapshot.source);
  lines.push(`session: ${sessionKey ?? "(unknown)"}`);
  lines.push(`recorded: ${recordedAt ?? "(unknown)"}`);
  if (namespace) lines.push(`namespace: ${namespace}`);
  if (source) lines.push(`source: ${source}`);
  const sourcesUsed = Array.isArray(snapshot.sourcesUsed)
    ? snapshot.sourcesUsed.filter((x): x is string => typeof x === "string")
    : [];
  if (sourcesUsed.length > 0) {
    lines.push(`sources-used: ${sourcesUsed.join(", ")}`);
  }
  const latencyMs = sanitizeFiniteNumber(snapshot.latencyMs);
  if (latencyMs !== null) {
    lines.push(`latency-ms: ${latencyMs}`);
  }
  const memoryIds = Array.isArray(snapshot.memoryIds)
    ? snapshot.memoryIds.filter((x): x is string => typeof x === "string")
    : [];
  if (memoryIds.length > 0) {
    lines.push(`memories: ${memoryIds.join(", ")}`);
  }

  // Use the same validated/normalized explain as toRecallExplainJson so the
  // text and JSON renderers agree on when data is "present enough to show".
  const ex = normalizeTierExplain(snapshot.tierExplain);
  if (!ex) {
    lines.push("");
    lines.push(
      "tier-explain: (not populated — direct-answer tier disabled or did not fire)",
    );
    return lines.join("\n");
  }

  lines.push("");
  lines.push("--- tier explain ---");
  lines.push(`tier: ${ex.tier}`);
  lines.push(`reason: ${ex.tierReason}`);
  lines.push(`candidates-considered: ${ex.candidatesConsidered}`);
  lines.push(`latency-ms: ${ex.latencyMs}`);
  if (ex.filteredBy.length > 0) {
    lines.push(`filtered-by: ${ex.filteredBy.join(", ")}`);
  } else {
    lines.push("filtered-by: (none)");
  }
  if (ex.sourceAnchors && ex.sourceAnchors.length > 0) {
    lines.push("source-anchors:");
    for (const anchor of ex.sourceAnchors) {
      const range = anchor.lineRange
        ? `:${anchor.lineRange[0]}-${anchor.lineRange[1]}`
        : "";
      lines.push(`  - ${anchor.path}${range}`);
    }
  }
  return lines.join("\n");
}

export function renderRecallExplain(
  snapshot: LastRecallSnapshot | null,
  format: RecallExplainFormat,
): string {
  if (format === "json") {
    return JSON.stringify(toRecallExplainJson(snapshot), null, 2);
  }
  return toRecallExplainText(snapshot);
}

/**
 * Validate a user-supplied format flag.  Throws with a clear message
 * on invalid input rather than silently defaulting (CLAUDE.md rule 51).
 */
export function parseRecallExplainFormat(value: unknown): RecallExplainFormat {
  if (value === undefined || value === null) return "text";
  if (typeof value !== "string") {
    throw new Error(
      `--format expects "text" or "json", got ${typeof value}`,
    );
  }
  const v = value.trim().toLowerCase();
  if (v === "text" || v === "json") return v;
  throw new Error(
    `--format expects "text" or "json", got ${JSON.stringify(value)}`,
  );
}
