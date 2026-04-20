/**
 * Recall X-ray snapshot schema (issue #570, PR 1).
 *
 * The X-ray surface is the unified, per-result attribution document that
 * merges the tier that served each memory, its score decomposition, any
 * graph path, an audit entry id, and the exact filter/eligibility ladder
 * that either admitted or rejected each candidate.  This file defines the
 * schema and an in-memory builder + builder-state helper.
 *
 * Scope for PR 1 (this slice):
 *   - Types only + pure builder functions (no IO, no rendering).
 *   - Orchestrator plumbing captures a snapshot when the caller passes
 *     `xrayCapture: true`.  No behavior change when the flag is absent.
 *   - NO new public surfaces here — CLI/HTTP/MCP land in later slices.
 *
 * The shared renderer lands in PR 2 at `recall-xray-renderer.ts`.  Do not
 * fork formatting logic into other surfaces; extend the renderer.
 */

import { randomUUID } from "node:crypto";

import type { RecallTierExplain } from "./types.js";

/**
 * Which retrieval source produced a given result.  This is the X-ray
 * tier ladder called out in issue #570 and is *distinct* from the
 * `RetrievalTier` enum (which describes issue #518's tier-explain
 * block).  Keeping the sets separate lets the two observability
 * surfaces evolve without conflating their vocabularies:
 *
 *   - `RetrievalTier`     — direct-answer eligibility ladder.
 *   - `RecallXrayServedBy` — which source materialized each result.
 */
export type RecallXrayServedBy =
  | "direct-answer"
  | "hybrid"
  | "graph"
  | "recent-scan"
  | "procedural"
  | "review-context";

export const RECALL_XRAY_SERVED_BY_VALUES: readonly RecallXrayServedBy[] = [
  "direct-answer",
  "hybrid",
  "graph",
  "recent-scan",
  "procedural",
  "review-context",
] as const;

export function isRecallXrayServedBy(
  value: unknown,
): value is RecallXrayServedBy {
  return (
    typeof value === "string" &&
    (RECALL_XRAY_SERVED_BY_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Score decomposition for a single X-ray result.
 *
 * All fields are optional because different tiers populate different
 * terms: `hybrid` reports vector + bm25 + mmr penalty, `direct-answer`
 * reports importance + tier prior, etc.  The only guaranteed field is
 * `final`, which is the post-combination score used for ordering.
 */
export interface RecallXrayScoreDecomposition {
  vector?: number;
  bm25?: number;
  importance?: number;
  mmrPenalty?: number;
  tierPrior?: number;
  final: number;
}

/**
 * Per-result breakdown inside an X-ray snapshot.
 */
export interface RecallXrayResult {
  memoryId: string;
  path: string;
  servedBy: RecallXrayServedBy;
  scoreDecomposition: RecallXrayScoreDecomposition;
  graphPath?: string[];
  auditEntryId?: string;
  /** Human-readable list of filters the candidate *passed*. */
  admittedBy: string[];
  /**
   * First filter that *would have* rejected the candidate, or undefined
   * when the candidate was admitted without a rejection trace.  When
   * present, `admittedBy` may still contain filters the candidate passed
   * before the rejecting gate; consumers should render both.
   */
  rejectedBy?: string;
}

/**
 * Trace entry for a filter the orchestrator evaluated during recall.
 * Captures the name of the filter, how many candidates it saw, and how
 * many it let through.  Used by X-ray consumers to render the filter
 * ladder above the per-result breakdown.
 */
export interface RecallFilterTrace {
  name: string;
  considered: number;
  admitted: number;
  /** Optional human-readable reason for any rejections. */
  reason?: string;
}

/**
 * The unified X-ray snapshot.  CLI, HTTP, and MCP surfaces all render
 * this same shape through the shared renderer (CLAUDE.md rule 22).
 */
export interface RecallXraySnapshot {
  /** Stable v1 tag so downstream consumers can version-gate their parsers. */
  schemaVersion: "1";
  query: string;
  /** UUID minted per capture; unique across snapshots within a process. */
  snapshotId: string;
  /** Epoch milliseconds the snapshot was captured. */
  capturedAt: number;
  /**
   * Tier-explain block from issue #518, carried verbatim when present.
   * `null` means direct-answer tier did not run (disabled, or another
   * tier served the query).
   */
  tierExplain: RecallTierExplain | null;
  results: RecallXrayResult[];
  filters: RecallFilterTrace[];
  /**
   * Character budget accounting for the final assembled recall payload.
   * `used` is the rendered-context length; `chars` is the cap.  Both are
   * non-negative integers in `[0, 2**31)`.
   */
  budget: { chars: number; used: number };
  /** Optional session-scope fields carried for downstream filtering. */
  sessionKey?: string;
  namespace?: string;
  traceId?: string;
}

// ─── Builder ──────────────────────────────────────────────────────────────

export interface BuildXraySnapshotInput {
  query: string;
  tierExplain?: RecallTierExplain | null;
  results?: RecallXrayResult[];
  filters?: RecallFilterTrace[];
  budget?: { chars?: number; used?: number };
  sessionKey?: string;
  namespace?: string;
  traceId?: string;
  /** Optional injected timestamp for deterministic tests. */
  now?: () => number;
  /** Optional injected id generator for deterministic tests. */
  snapshotIdGenerator?: () => string;
}

/**
 * Build a `RecallXraySnapshot` from explicit input fields.  Pure
 * function; safe to call from anywhere.  All array/object inputs are
 * shallow-copied so caller mutation after build cannot tear the
 * returned snapshot.
 */
export function buildXraySnapshot(
  input: BuildXraySnapshotInput,
): RecallXraySnapshot {
  const now = input.now ?? Date.now;
  const snapshotIdGenerator = input.snapshotIdGenerator ?? randomUUID;

  const results = Array.isArray(input.results)
    ? input.results.map(cloneResult)
    : [];
  const filters = Array.isArray(input.filters)
    ? input.filters.map(cloneFilter)
    : [];

  const budgetChars = nonNegativeInt(input.budget?.chars);
  const budgetUsed = nonNegativeInt(input.budget?.used);

  const tierExplain =
    input.tierExplain && typeof input.tierExplain === "object"
      ? cloneTierExplain(input.tierExplain)
      : null;

  return {
    schemaVersion: "1",
    query: typeof input.query === "string" ? input.query : "",
    snapshotId: snapshotIdGenerator(),
    capturedAt: now(),
    tierExplain,
    results,
    filters,
    budget: { chars: budgetChars, used: budgetUsed },
    sessionKey: nonEmptyString(input.sessionKey),
    namespace: nonEmptyString(input.namespace),
    traceId: nonEmptyString(input.traceId),
  };
}

/**
 * Mutable builder used by the orchestrator to accumulate X-ray fields
 * as recall progresses.  Call `build()` to get the finalized
 * immutable-ish snapshot.  All inputs are validated at insert time so
 * a malformed entry cannot poison the snapshot later.
 */
export class RecallXrayBuilder {
  private readonly query: string;
  private readonly sessionKey: string | undefined;
  private namespace: string | undefined;
  private traceId: string | undefined;
  private tierExplain: RecallTierExplain | null = null;
  private readonly results: RecallXrayResult[] = [];
  private readonly filters: RecallFilterTrace[] = [];
  private budgetChars = 0;
  private budgetUsed = 0;

  constructor(opts: {
    query: string;
    sessionKey?: string;
    namespace?: string;
    traceId?: string;
  }) {
    this.query = typeof opts.query === "string" ? opts.query : "";
    this.sessionKey = nonEmptyString(opts.sessionKey);
    this.namespace = nonEmptyString(opts.namespace);
    this.traceId = nonEmptyString(opts.traceId);
  }

  setNamespace(namespace: string | undefined): void {
    this.namespace = nonEmptyString(namespace);
  }

  setTraceId(traceId: string | undefined): void {
    this.traceId = nonEmptyString(traceId);
  }

  setTierExplain(tierExplain: RecallTierExplain | null | undefined): void {
    this.tierExplain =
      tierExplain && typeof tierExplain === "object"
        ? cloneTierExplain(tierExplain)
        : null;
  }

  setBudget(budget: { chars?: number; used?: number }): void {
    this.budgetChars = nonNegativeInt(budget.chars);
    this.budgetUsed = nonNegativeInt(budget.used);
  }

  recordResult(result: RecallXrayResult): void {
    this.results.push(cloneResult(result));
  }

  recordFilter(filter: RecallFilterTrace): void {
    this.filters.push(cloneFilter(filter));
  }

  build(opts: {
    now?: () => number;
    snapshotIdGenerator?: () => string;
  } = {}): RecallXraySnapshot {
    return buildXraySnapshot({
      query: this.query,
      tierExplain: this.tierExplain,
      results: this.results,
      filters: this.filters,
      budget: { chars: this.budgetChars, used: this.budgetUsed },
      sessionKey: this.sessionKey,
      namespace: this.namespace,
      traceId: this.traceId,
      now: opts.now,
      snapshotIdGenerator: opts.snapshotIdGenerator,
    });
  }
}

// ─── Internals ────────────────────────────────────────────────────────────

function cloneResult(result: RecallXrayResult): RecallXrayResult {
  if (!result || typeof result !== "object") {
    throw new TypeError("RecallXrayResult must be an object");
  }
  if (!isRecallXrayServedBy(result.servedBy)) {
    throw new TypeError(
      `RecallXrayResult.servedBy must be one of ${RECALL_XRAY_SERVED_BY_VALUES.join(
        ", ",
      )}; got ${JSON.stringify(result.servedBy)}`,
    );
  }
  const memoryId = typeof result.memoryId === "string" ? result.memoryId : "";
  const path = typeof result.path === "string" ? result.path : "";
  const admittedBy = Array.isArray(result.admittedBy)
    ? result.admittedBy.filter((x): x is string => typeof x === "string")
    : [];
  const graphPath = Array.isArray(result.graphPath)
    ? result.graphPath.filter((x): x is string => typeof x === "string")
    : undefined;
  const auditEntryId = nonEmptyString(result.auditEntryId);
  const rejectedBy = nonEmptyString(result.rejectedBy);
  const scoreDecomposition = cloneScoreDecomposition(result.scoreDecomposition);
  const out: RecallXrayResult = {
    memoryId,
    path,
    servedBy: result.servedBy,
    scoreDecomposition,
    admittedBy,
  };
  if (graphPath !== undefined) out.graphPath = graphPath;
  if (auditEntryId !== undefined) out.auditEntryId = auditEntryId;
  if (rejectedBy !== undefined) out.rejectedBy = rejectedBy;
  return out;
}

function cloneFilter(filter: RecallFilterTrace): RecallFilterTrace {
  if (!filter || typeof filter !== "object") {
    throw new TypeError("RecallFilterTrace must be an object");
  }
  const out: RecallFilterTrace = {
    name: typeof filter.name === "string" ? filter.name : "",
    considered: nonNegativeInt(filter.considered),
    admitted: nonNegativeInt(filter.admitted),
  };
  const reason = nonEmptyString(filter.reason);
  if (reason !== undefined) out.reason = reason;
  return out;
}

function cloneScoreDecomposition(
  value: RecallXrayScoreDecomposition | undefined,
): RecallXrayScoreDecomposition {
  if (!value || typeof value !== "object") {
    return { final: 0 };
  }
  const out: RecallXrayScoreDecomposition = {
    final: finiteNumber(value.final) ?? 0,
  };
  const vector = finiteNumber(value.vector);
  if (vector !== undefined) out.vector = vector;
  const bm25 = finiteNumber(value.bm25);
  if (bm25 !== undefined) out.bm25 = bm25;
  const importance = finiteNumber(value.importance);
  if (importance !== undefined) out.importance = importance;
  const mmrPenalty = finiteNumber(value.mmrPenalty);
  if (mmrPenalty !== undefined) out.mmrPenalty = mmrPenalty;
  const tierPrior = finiteNumber(value.tierPrior);
  if (tierPrior !== undefined) out.tierPrior = tierPrior;
  return out;
}

function cloneTierExplain(tierExplain: RecallTierExplain): RecallTierExplain {
  // Use structuredClone so future RecallTierExplain additions do not
  // silently share references through hand-enumerated fields.  The
  // payload is JSON-shaped.
  return structuredClone(tierExplain);
}

function nonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.floor(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}
