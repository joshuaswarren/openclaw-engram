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
import { isRetrievalTier } from "./retrieval-tiers.js";

function sanitizeString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

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

function normalizeTierExplain(value: unknown): RecallTierExplain | null {
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
  const normalizedExplain = normalizeTierExplain(snapshot.tierExplain);
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

export function toRecallExplainText(
  snapshot: LastRecallSnapshot | null,
): string {
  const lines: string[] = ["=== Recall Explain ==="];

  if (!snapshot) {
    lines.push("No recall snapshot recorded yet.");
    return lines.join("\n");
  }

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
