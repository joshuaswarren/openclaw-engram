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
  if (!value || typeof value !== "object") return null;
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
          const lineRange =
            Array.isArray(lr) &&
            lr.length === 2 &&
            typeof lr[0] === "number" &&
            typeof lr[1] === "number"
              ? ([lr[0], lr[1]] as [number, number])
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
    candidatesConsidered:
      typeof raw.candidatesConsidered === "number" ? raw.candidatesConsidered : 0,
    latencyMs: typeof raw.latencyMs === "number" ? raw.latencyMs : 0,
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
  return {
    hasExplain: normalizedExplain !== null,
    snapshotFound: true,
    sessionKey: snapshot.sessionKey,
    recordedAt: snapshot.recordedAt,
    namespace: snapshot.namespace ?? null,
    memoryIds: Array.isArray(snapshot.memoryIds) ? [...snapshot.memoryIds] : [],
    source: snapshot.source ?? null,
    sourcesUsed: Array.isArray(snapshot.sourcesUsed) ? [...snapshot.sourcesUsed] : null,
    latencyMs: typeof snapshot.latencyMs === "number" ? snapshot.latencyMs : null,
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

  lines.push(`session: ${snapshot.sessionKey}`);
  lines.push(`recorded: ${snapshot.recordedAt}`);
  if (snapshot.namespace) lines.push(`namespace: ${snapshot.namespace}`);
  if (snapshot.source) lines.push(`source: ${snapshot.source}`);
  if (Array.isArray(snapshot.sourcesUsed) && snapshot.sourcesUsed.length > 0) {
    lines.push(`sources-used: ${snapshot.sourcesUsed.join(", ")}`);
  }
  if (typeof snapshot.latencyMs === "number") {
    lines.push(`latency-ms: ${snapshot.latencyMs}`);
  }
  if (Array.isArray(snapshot.memoryIds) && snapshot.memoryIds.length > 0) {
    lines.push(`memories: ${snapshot.memoryIds.join(", ")}`);
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
