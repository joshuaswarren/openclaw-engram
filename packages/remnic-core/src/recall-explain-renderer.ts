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
import type { RecallTierExplain } from "./types.js";

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
  return {
    // Consistent null/undefined guard with the tierExplain field below
    // (truthiness): hasExplain must never be true while tierExplain is null.
    // Cursor Bugbot flagged the prior `!== undefined` check as inconsistent
    // because `LastRecallStore.load()` can produce a null tierExplain.
    hasExplain: snapshot.tierExplain != null,
    snapshotFound: true,
    sessionKey: snapshot.sessionKey,
    recordedAt: snapshot.recordedAt,
    namespace: snapshot.namespace ?? null,
    memoryIds: [...snapshot.memoryIds],
    source: snapshot.source ?? null,
    sourcesUsed: snapshot.sourcesUsed ? [...snapshot.sourcesUsed] : null,
    latencyMs: snapshot.latencyMs ?? null,
    tierExplain: snapshot.tierExplain
      ? {
          ...snapshot.tierExplain,
          filteredBy: [...snapshot.tierExplain.filteredBy],
          sourceAnchors: snapshot.tierExplain.sourceAnchors
            ? snapshot.tierExplain.sourceAnchors.map((a) => ({
                path: a.path,
                lineRange: a.lineRange
                  ? ([a.lineRange[0], a.lineRange[1]] as [number, number])
                  : undefined,
              }))
            : undefined,
        }
      : null,
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
  if (snapshot.sourcesUsed && snapshot.sourcesUsed.length > 0) {
    lines.push(`sources-used: ${snapshot.sourcesUsed.join(", ")}`);
  }
  if (typeof snapshot.latencyMs === "number") {
    lines.push(`latency-ms: ${snapshot.latencyMs}`);
  }
  if (snapshot.memoryIds.length > 0) {
    lines.push(`memories: ${snapshot.memoryIds.join(", ")}`);
  }

  if (!snapshot.tierExplain) {
    lines.push("");
    lines.push(
      "tier-explain: (not populated — direct-answer tier disabled or did not fire)",
    );
    return lines.join("\n");
  }

  const ex = snapshot.tierExplain;
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
