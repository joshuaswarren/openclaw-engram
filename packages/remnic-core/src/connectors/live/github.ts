/**
 * @remnic/core — GitHub live connector (issue #683 PR 5/6)
 *
 * Concrete `LiveConnector` implementation that incrementally imports notes
 * from a user's GitHub activity into Remnic. Fetches via the GitHub REST
 * API using raw `fetch` with a personal access token — no octokit dep,
 * per à-la-carte packaging rules (CLAUDE.md gotcha #57).
 *
 * What is imported:
 *   - Issue comments authored by `userLogin` on watched repos.
 *   - PR review comments authored by `userLogin` on watched repos.
 *   - Discussion comments authored by `userLogin` (optional, off by default).
 *
 * Design notes:
 *
 *   - **Auth.** GitHub personal access token via `connectors.github.token`.
 *     The token is accepted at config-parse time but never logged. Operators
 *     must populate it from a secret store; no real value may appear in
 *     tests, fixtures, or comments.
 *
 *   - **Cursor semantics.** The cursor encodes a per-repo, per-resource-type
 *     watermark (latest `updated_at` ISO 8601 string seen). On the very first
 *     sync (cursor=null) we seed the watermark from the current latest
 *     comment timestamp WITHOUT importing any content — mirrors Drive's
 *     `getStartPageToken` bootstrap pattern. Subsequent passes only import
 *     items created/updated after the stored watermark.
 *
 *   - **Watermark field.** All three GitHub resource types expose
 *     `updated_at` at the comment level. We always use `updated_at` (not
 *     `created_at`) so edits re-trigger ingestion.
 *
 *   - **Raw `fetch`.** We call `https://api.github.com/…` directly.
 *     `Authorization: Bearer <token>` + `User-Agent: remnic-connector` headers
 *     on every request. The `fetchFn` parameter is the test injection point —
 *     production callers omit it and the connector uses the global `fetch`.
 *
 *   - **Idempotency.** `ConnectorDocument.source.externalId` is
 *     `{repo}/{kind}/{commentId}` and `externalRevision` is `updated_at`, so
 *     downstream dedup (CLAUDE.md gotcha #44) can recognise repeat fetches.
 *
 *   - **Filtering by userLogin.** GitHub's `/issues/comments` endpoint does
 *     not support server-side author filtering in the public API. We filter
 *     client-side by comparing `comment.user.login` to the configured
 *     `userLogin`. This keeps the implementation free from authenticated
 *     user lookups and avoids an extra round-trip on first run.
 *
 *   - **Privacy.** No comment body is ever logged. Repo names and counts
 *     may be logged. The token is never exposed in logs, state, or errors.
 *
 *   - **Read-only.** This connector only reads. It never posts, edits,
 *     reacts to, or otherwise mutates any GitHub resource.
 *
 *   - **Error classification.** 429/5xx → transient (re-throw, cursor
 *     does NOT advance). 404/403/410 → terminal (skip repo/resource,
 *     continue). Network errors → transient.
 */

import type {
  ConnectorConfig,
  ConnectorCursor,
  ConnectorDocument,
  LiveConnector,
  SyncIncrementalArgs,
  SyncIncrementalResult,
} from "./framework.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Stable connector id. */
export const GITHUB_CONNECTOR_ID = "github";

/** Cursor `kind` emitted by this connector. */
export const GITHUB_CURSOR_KIND = "githubWatermark";

/** Default poll interval: 5 minutes. */
export const GITHUB_DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Hard cap on poll interval: 24 hours. */
const GITHUB_MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Hard cap on body text we'll accept for a single comment. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Maximum number of items (across all repos and resource types) per pass. */
const MAX_ITEMS_PER_PASS = 200;

/** Page size for GitHub list requests. Maximum allowed by the API. */
const GITHUB_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/**
 * Validated, frozen view of `connectors.github.*`.
 */
export interface GitHubConnectorConfig {
  /** Personal access token. Populate from a secret store; never commit. */
  readonly token: string;
  /** Only import comments authored by this GitHub login. Required. */
  readonly userLogin: string;
  /** Repos to poll, in `owner/repo` format. */
  readonly repos: readonly string[];
  /** Poll interval in ms. */
  readonly pollIntervalMs: number;
  /** Whether to import Discussion comments. Default false. */
  readonly includeDiscussions: boolean;
}

// ---------------------------------------------------------------------------
// Cursor payload
// ---------------------------------------------------------------------------

/**
 * JSON payload encoded into `ConnectorCursor.value`.
 *
 * Watermarks are stored per repo per resource kind. We use ISO 8601 strings
 * (which sort lexicographically) for all comparisons — no epoch math needed.
 */
interface GitHubCursorPayload {
  /**
   * Maps `{repo}/{kind}` → latest `updated_at` ISO string already ingested.
   * `kind` is one of `"issue-comment"`, `"pr-review-comment"`, `"discussion"`.
   */
  watermarks: Record<string, string>;
}

// ---------------------------------------------------------------------------
// GitHub API response shapes (only the fields we consume)
// ---------------------------------------------------------------------------

export interface GitHubComment {
  readonly id: number;
  readonly body?: string | null;
  readonly user?: { readonly login?: string | null } | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_url?: string | null;
  /** Present on PR review comments. */
  readonly pull_request_url?: string | null;
  /** Present on issue comments. */
  readonly issue_url?: string | null;
}

export interface GitHubDiscussionComment {
  readonly id: number;
  readonly body?: string | null;
  readonly author?: { readonly login?: string | null } | null;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly url?: string | null;
}

// ---------------------------------------------------------------------------
// Fetch abstraction (test hook)
// ---------------------------------------------------------------------------

/**
 * Minimal fetch-compatible surface used by the connector. Tests inject a
 * stub; production delegates to global `fetch`.
 */
export type GitHubFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/** Pattern for `owner/repo`. Both segments allow alphanumeric + `-` + `_` + `.`. */
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Validate and normalise raw config. Throws with a concrete message on any
 * malformed input — never silently defaults (CLAUDE.md gotcha #51).
 */
export function validateGitHubConfig(raw: unknown): GitHubConnectorConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(
      `github: config must be an object, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  const r = raw as Record<string, unknown>;

  // token
  if (typeof r.token !== "string") {
    throw new TypeError(`github: token must be a string (got ${typeof r.token})`);
  }
  const token = r.token.trim();
  if (token.length === 0) {
    throw new RangeError("github: token must be non-empty");
  }

  // userLogin
  if (typeof r.userLogin !== "string") {
    throw new TypeError(`github: userLogin must be a string (got ${typeof r.userLogin})`);
  }
  const userLogin = r.userLogin.trim();
  if (userLogin.length === 0) {
    throw new RangeError("github: userLogin must be non-empty");
  }

  // pollIntervalMs
  let pollIntervalMs: number;
  if (r.pollIntervalMs === undefined) {
    pollIntervalMs = GITHUB_DEFAULT_POLL_INTERVAL_MS;
  } else if (typeof r.pollIntervalMs !== "number" || !Number.isFinite(r.pollIntervalMs)) {
    throw new TypeError(
      `github: pollIntervalMs must be a finite number (got ${JSON.stringify(r.pollIntervalMs)})`,
    );
  } else if (!Number.isInteger(r.pollIntervalMs)) {
    throw new TypeError(`github: pollIntervalMs must be an integer (got ${r.pollIntervalMs})`);
  } else if (r.pollIntervalMs < 1_000) {
    throw new RangeError(`github: pollIntervalMs must be ≥1000ms; got ${r.pollIntervalMs}`);
  } else if (r.pollIntervalMs > GITHUB_MAX_POLL_INTERVAL_MS) {
    throw new RangeError(
      `github: pollIntervalMs must be ≤${GITHUB_MAX_POLL_INTERVAL_MS} (24h); got ${r.pollIntervalMs}`,
    );
  } else {
    pollIntervalMs = r.pollIntervalMs;
  }

  // repos
  let repos: readonly string[] = [];
  if (r.repos !== undefined) {
    if (!Array.isArray(r.repos)) {
      throw new TypeError(
        `github: repos must be an array of strings (got ${typeof r.repos})`,
      );
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of r.repos) {
      if (typeof value !== "string") {
        throw new TypeError(
          `github: repos entries must be strings; found ${typeof value}`,
        );
      }
      const trimmed = value.trim();
      if (!REPO_SLUG_PATTERN.test(trimmed)) {
        throw new RangeError(
          `github: repos entry ${JSON.stringify(value)} is not a valid "owner/repo" slug`,
        );
      }
      // Dedupe per CLAUDE.md gotcha #49.
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    repos = Object.freeze(out);
  }

  // includeDiscussions (optional, default false)
  let includeDiscussions = false;
  if (r.includeDiscussions !== undefined) {
    if (typeof r.includeDiscussions !== "boolean") {
      throw new TypeError(
        `github: includeDiscussions must be a boolean (got ${typeof r.includeDiscussions})`,
      );
    }
    includeDiscussions = r.includeDiscussions;
  }

  return Object.freeze({
    token,
    userLogin,
    repos,
    pollIntervalMs,
    includeDiscussions,
  });
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

function makeCursor(payload: GitHubCursorPayload): ConnectorCursor {
  return {
    kind: GITHUB_CURSOR_KIND,
    value: JSON.stringify(payload),
    updatedAt: new Date().toISOString(),
  };
}

function parseCursorPayload(cursor: ConnectorCursor): GitHubCursorPayload {
  if (cursor.kind !== GITHUB_CURSOR_KIND) {
    throw new Error(
      `github: unexpected cursor kind ${JSON.stringify(cursor.kind)}; expected ${GITHUB_CURSOR_KIND}`,
    );
  }
  // CLAUDE.md gotcha #18: validate after parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor.value);
  } catch {
    throw new Error(`github: cursor value is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`github: cursor value does not match GitHubCursorPayload shape`);
  }
  const p = parsed as Record<string, unknown>;
  const watermarks =
    typeof p.watermarks === "object" && p.watermarks !== null && !Array.isArray(p.watermarks)
      ? (p.watermarks as Record<string, string>)
      : {};
  return { watermarks };
}

function watermarkKey(repo: string, kind: string): string {
  return `${repo}/${kind}`;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a fetch error as transient (re-throw — cursor does NOT advance,
 * next poll retries) vs. terminal (skip this repo/resource and continue).
 *
 * Transient:
 *   - 429 (rate-limit — retry after backoff)
 *   - 5xx (GitHub backend error)
 *   - AbortError / network-layer errors
 *
 * Terminal (skip-and-continue):
 *   - 404 (repo deleted, comment gone, or no access)
 *   - 403 (permission denied)
 *   - 410 (gone)
 *   - any other 4xx that isn't 429
 */
export function isTransientGitHubError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    githubStatus?: unknown;
    message?: unknown;
  };

  // AbortError
  if (typeof e.name === "string" && e.name === "AbortError") return true;

  // HTTP status attached by our own error-throwing code.
  const status = pickNumericGitHubStatus(e);
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    // Any classified 4xx that isn't 429 is terminal.
    return false;
  }

  // Network-layer error codes.
  const codeStr = typeof e.code === "string" ? e.code : undefined;
  if (codeStr !== undefined) {
    const transientCodes = new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "ECONNABORTED",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENETDOWN",
      "ERR_NETWORK",
      "ERR_NETWORK_CHANGED",
    ]);
    if (transientCodes.has(codeStr)) return true;
    return false;
  }

  // No status, no code — treat as transient (plain network failures).
  return true;
}

function pickNumericGitHubStatus(e: {
  status?: unknown;
  githubStatus?: unknown;
  code?: unknown;
}): number | undefined {
  if (typeof e.githubStatus === "number" && Number.isFinite(e.githubStatus)) {
    return e.githubStatus;
  }
  if (typeof e.status === "number" && Number.isFinite(e.status)) {
    return e.status;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GitHub API client helpers
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("github: sync aborted");
    err.name = "AbortError";
    throw err;
  }
}

function makeGitHubApiError(status: number, message: string): Error & { githubStatus: number } {
  const err = new Error(`github: HTTP ${status}: ${message}`) as Error & {
    githubStatus: number;
  };
  err.githubStatus = status;
  return err;
}

/**
 * Execute a GET request against the GitHub REST API. Returns the parsed JSON
 * body on success. Throws a structured error on non-2xx responses.
 */
async function githubGet(
  fetchFn: GitHubFetchFn,
  token: string,
  url: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "remnic-connector",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal,
  });

  const data = await res.json();
  if (!res.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      typeof (data as Record<string, unknown>).message === "string"
        ? ((data as Record<string, unknown>).message as string)
        : `HTTP ${res.status}`;
    throw makeGitHubApiError(res.status, message);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Sync result type
// ---------------------------------------------------------------------------

/**
 * Result of a single sync pass. Superset of `SyncIncrementalResult` for
 * richer test assertions.
 */
export interface GitHubSyncResult extends SyncIncrementalResult {
  readonly skippedOtherAuthor: number;
  readonly skippedEmpty: number;
  readonly skippedTooLarge: number;
}

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

/**
 * Construct the GitHub connector. `fetchFn` is the test hook — production
 * callers omit it and the connector delegates to global `fetch`.
 */
export function createGitHubConnector(
  options: { fetchFn?: GitHubFetchFn } = {},
): LiveConnector {
  const fetchFn: GitHubFetchFn =
    options.fetchFn ??
    (globalThis.fetch as unknown as GitHubFetchFn);

  return {
    id: GITHUB_CONNECTOR_ID,
    displayName: "GitHub",
    description:
      "Imports issue comments, PR review comments, and discussion posts authored by the configured user from watched repos into Remnic.",

    validateConfig(raw: unknown): ConnectorConfig {
      return validateGitHubConfig(raw) as unknown as ConnectorConfig;
    },

    async syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult> {
      const config = validateGitHubConfig(args.config);
      throwIfAborted(args.abortSignal);

      // Short-circuit: nothing to do if no repos are configured.
      if (config.repos.length === 0) {
        const emptyPayload: GitHubCursorPayload = { watermarks: {} };
        const result: GitHubSyncResult = {
          newDocs: [],
          nextCursor: makeCursor(emptyPayload),
          skippedOtherAuthor: 0,
          skippedEmpty: 0,
          skippedTooLarge: 0,
        };
        return result;
      }

      // Parse or seed cursor.
      const isFirstSync = args.cursor === null;
      const payload: GitHubCursorPayload = isFirstSync
        ? { watermarks: {} }
        : parseCursorPayload(args.cursor);

      if (isFirstSync) {
        const seededPayload = await seedWatermarks(fetchFn, config, payload, args.abortSignal);
        return {
          newDocs: [],
          nextCursor: makeCursor(seededPayload),
          skippedOtherAuthor: 0,
          skippedEmpty: 0,
          skippedTooLarge: 0,
        } as GitHubSyncResult;
      }

      return await incrementalSync(fetchFn, config, payload, args.abortSignal);
    },
  };
}

// ---------------------------------------------------------------------------
// First-sync: seed watermarks without importing
// ---------------------------------------------------------------------------

/**
 * For each configured repo and resource type, query the current latest
 * item timestamp and record it as the starting watermark. Returns without
 * emitting any documents, mirroring Drive's `getStartPageToken` pattern.
 */
async function seedWatermarks(
  fetchFn: GitHubFetchFn,
  config: GitHubConnectorConfig,
  initial: GitHubCursorPayload,
  signal: AbortSignal | undefined,
): Promise<GitHubCursorPayload> {
  const watermarks = { ...initial.watermarks };

  for (const repo of config.repos) {
    throwIfAborted(signal);

    // Issue comments
    try {
      const latest = await fetchLatestTimestamp(
        fetchFn,
        config.token,
        `${GITHUB_API_BASE}/repos/${repo}/issues/comments?sort=updated&direction=desc&per_page=1`,
        "updated_at",
        signal,
      );
      if (latest) watermarks[watermarkKey(repo, "issue-comment")] = latest;
    } catch (err) {
      if (isTransientGitHubError(err)) throw err;
      // 404/403 → repo inaccessible, skip silently.
    }

    throwIfAborted(signal);

    // PR review comments
    try {
      const latest = await fetchLatestTimestamp(
        fetchFn,
        config.token,
        `${GITHUB_API_BASE}/repos/${repo}/pulls/comments?sort=updated&direction=desc&per_page=1`,
        "updated_at",
        signal,
      );
      if (latest) watermarks[watermarkKey(repo, "pr-review-comment")] = latest;
    } catch (err) {
      if (isTransientGitHubError(err)) throw err;
    }

    // Discussions (GraphQL not used; we use the REST search endpoint for simplicity)
    if (config.includeDiscussions) {
      throwIfAborted(signal);
      try {
        const latest = await fetchLatestTimestamp(
          fetchFn,
          config.token,
          `${GITHUB_API_BASE}/repos/${repo}/discussions?sort=updated&direction=desc&per_page=1`,
          "updated_at",
          signal,
        );
        if (latest) watermarks[watermarkKey(repo, "discussion")] = latest;
      } catch (err) {
        if (isTransientGitHubError(err)) throw err;
      }
    }
  }

  return { watermarks };
}

/**
 * Fetch the first page of a sorted list and return the `updated_at` field of
 * the first item, or `undefined` if the list is empty.
 */
async function fetchLatestTimestamp(
  fetchFn: GitHubFetchFn,
  token: string,
  url: string,
  field: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const data = await githubGet(fetchFn, token, url, signal);
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (typeof first !== "object" || first === null) return undefined;
  const ts = (first as Record<string, unknown>)[field];
  return typeof ts === "string" && ts.length > 0 ? ts : undefined;
}

// ---------------------------------------------------------------------------
// Incremental sync
// ---------------------------------------------------------------------------

async function incrementalSync(
  fetchFn: GitHubFetchFn,
  config: GitHubConnectorConfig,
  payload: GitHubCursorPayload,
  signal: AbortSignal | undefined,
): Promise<GitHubSyncResult> {
  const fetchedAt = new Date().toISOString();
  const newDocs: ConnectorDocument[] = [];
  const updatedWatermarks = { ...payload.watermarks };
  let skippedOtherAuthor = 0;
  let skippedEmpty = 0;
  let skippedTooLarge = 0;
  let totalConsumed = 0;

  for (const repo of config.repos) {
    if (totalConsumed >= MAX_ITEMS_PER_PASS) break;
    throwIfAborted(signal);

    // --- Issue comments ---
    {
      const wmKey = watermarkKey(repo, "issue-comment");
      const since = payload.watermarks[wmKey];
      try {
        const result = await fetchAndFilterComments(
          fetchFn,
          config.token,
          buildIssueCommentsUrl(repo, since),
          repo,
          "issue-comment",
          config.userLogin,
          since,
          fetchedAt,
          MAX_ITEMS_PER_PASS - totalConsumed,
          signal,
        );
        for (const doc of result.docs) newDocs.push(doc);
        skippedOtherAuthor += result.skippedOtherAuthor;
        skippedEmpty += result.skippedEmpty;
        skippedTooLarge += result.skippedTooLarge;
        totalConsumed += result.consumed;
        if (result.latestWatermark) {
          updatedWatermarks[wmKey] = result.latestWatermark;
        }
      } catch (err) {
        if (isTransientGitHubError(err)) throw err;
        // Terminal (404/403): skip this resource for this repo.
      }
    }

    if (totalConsumed >= MAX_ITEMS_PER_PASS) break;
    throwIfAborted(signal);

    // --- PR review comments ---
    {
      const wmKey = watermarkKey(repo, "pr-review-comment");
      const since = payload.watermarks[wmKey];
      try {
        const result = await fetchAndFilterComments(
          fetchFn,
          config.token,
          buildPrReviewCommentsUrl(repo, since),
          repo,
          "pr-review-comment",
          config.userLogin,
          since,
          fetchedAt,
          MAX_ITEMS_PER_PASS - totalConsumed,
          signal,
        );
        for (const doc of result.docs) newDocs.push(doc);
        skippedOtherAuthor += result.skippedOtherAuthor;
        skippedEmpty += result.skippedEmpty;
        skippedTooLarge += result.skippedTooLarge;
        totalConsumed += result.consumed;
        if (result.latestWatermark) {
          updatedWatermarks[wmKey] = result.latestWatermark;
        }
      } catch (err) {
        if (isTransientGitHubError(err)) throw err;
      }
    }

    // --- Discussion comments (optional) ---
    if (config.includeDiscussions && totalConsumed < MAX_ITEMS_PER_PASS) {
      throwIfAborted(signal);
      const wmKey = watermarkKey(repo, "discussion");
      const since = payload.watermarks[wmKey];
      try {
        const result = await fetchAndFilterComments(
          fetchFn,
          config.token,
          buildDiscussionsUrl(repo, since),
          repo,
          "discussion",
          config.userLogin,
          since,
          fetchedAt,
          MAX_ITEMS_PER_PASS - totalConsumed,
          signal,
        );
        for (const doc of result.docs) newDocs.push(doc);
        skippedOtherAuthor += result.skippedOtherAuthor;
        skippedEmpty += result.skippedEmpty;
        skippedTooLarge += result.skippedTooLarge;
        totalConsumed += result.consumed;
        if (result.latestWatermark) {
          updatedWatermarks[wmKey] = result.latestWatermark;
        }
      } catch (err) {
        if (isTransientGitHubError(err)) throw err;
      }
    }
  }

  return {
    newDocs,
    nextCursor: makeCursor({ watermarks: updatedWatermarks }),
    skippedOtherAuthor,
    skippedEmpty,
    skippedTooLarge,
  };
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

function buildIssueCommentsUrl(repo: string, since?: string): string {
  const base = `${GITHUB_API_BASE}/repos/${repo}/issues/comments?sort=updated&direction=asc&per_page=${GITHUB_PAGE_SIZE}`;
  return since ? `${base}&since=${encodeURIComponent(since)}` : base;
}

function buildPrReviewCommentsUrl(repo: string, since?: string): string {
  const base = `${GITHUB_API_BASE}/repos/${repo}/pulls/comments?sort=updated&direction=asc&per_page=${GITHUB_PAGE_SIZE}`;
  return since ? `${base}&since=${encodeURIComponent(since)}` : base;
}

function buildDiscussionsUrl(repo: string, since?: string): string {
  // GitHub Discussions REST API (available for repos with discussions enabled).
  // No server-side `since` filter exists, so we page and filter client-side.
  const base = `${GITHUB_API_BASE}/repos/${repo}/discussions?sort=updated&direction=asc&per_page=${GITHUB_PAGE_SIZE}`;
  return since ? `${base}&since=${encodeURIComponent(since)}` : base;
}

// ---------------------------------------------------------------------------
// Comment fetching + filtering
// ---------------------------------------------------------------------------

interface FetchAndFilterResult {
  docs: ConnectorDocument[];
  skippedOtherAuthor: number;
  skippedEmpty: number;
  skippedTooLarge: number;
  consumed: number;
  /** Latest `updated_at` we saw in this batch (only from matching author). */
  latestWatermark: string | undefined;
}

/**
 * Page through the comments at `firstPageUrl`, filter to comments authored
 * by `userLogin`, and build `ConnectorDocument` instances. Respects the
 * per-pass cap via `remainingBudget`.
 *
 * Uses `since` as a client-side lower-bound filter in addition to the
 * server-side `?since=` param (the server may return items exactly at
 * the watermark that we already ingested).
 */
async function fetchAndFilterComments(
  fetchFn: GitHubFetchFn,
  token: string,
  firstPageUrl: string,
  repo: string,
  kind: string,
  userLogin: string,
  since: string | undefined,
  fetchedAt: string,
  remainingBudget: number,
  signal: AbortSignal | undefined,
): Promise<FetchAndFilterResult> {
  const docs: ConnectorDocument[] = [];
  let skippedOtherAuthor = 0;
  let skippedEmpty = 0;
  let skippedTooLarge = 0;
  let consumed = 0;
  let latestWatermark: string | undefined = undefined;
  let nextUrl: string | undefined = firstPageUrl;

  while (nextUrl && consumed < remainingBudget) {
    throwIfAborted(signal);

    const data = await githubGet(fetchFn, token, nextUrl, signal);
    if (!Array.isArray(data)) break;

    for (const item of data) {
      if (consumed >= remainingBudget) break;
      throwIfAborted(signal);

      const comment = item as GitHubComment;
      consumed++;

      // Skip items at or before the watermark (server returns inclusive).
      if (since && comment.updated_at <= since) {
        // Don't count toward skippedOtherAuthor — this is a cursor artifact.
        continue;
      }

      // Author filter (client-side).
      const authorLogin = comment.user?.login ?? null;
      if (authorLogin !== userLogin) {
        skippedOtherAuthor++;
        // Still track watermark for non-matching items to prevent re-fetching
        // them on every subsequent poll.
        if (!latestWatermark || comment.updated_at > latestWatermark) {
          latestWatermark = comment.updated_at;
        }
        continue;
      }

      // Body validation.
      const body = comment.body ?? "";
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        skippedEmpty++;
        if (!latestWatermark || comment.updated_at > latestWatermark) {
          latestWatermark = comment.updated_at;
        }
        continue;
      }
      if (trimmed.length > MAX_BODY_BYTES) {
        skippedTooLarge++;
        if (!latestWatermark || comment.updated_at > latestWatermark) {
          latestWatermark = comment.updated_at;
        }
        continue;
      }

      // Build document.
      const doc = buildDocument(comment, repo, kind, fetchedAt);
      docs.push(doc);

      if (!latestWatermark || comment.updated_at > latestWatermark) {
        latestWatermark = comment.updated_at;
      }
    }

    // Follow GitHub's `Link: <url>; rel="next"` header for pagination.
    // We don't have direct header access via the minimal fetch abstraction,
    // so pagination is signaled by a full page being returned. If the page
    // has fewer items than GITHUB_PAGE_SIZE we've reached the end.
    // This is conservative but correct — a short page always means "no more".
    if (data.length < GITHUB_PAGE_SIZE) {
      nextUrl = undefined;
    } else {
      // Full page received — there may be more. Advance via page parameter.
      nextUrl = advancePageUrl(nextUrl);
    }
  }

  return { docs, skippedOtherAuthor, skippedEmpty, skippedTooLarge, consumed, latestWatermark };
}

/**
 * Advance a paginated GitHub URL by incrementing the `page` query parameter.
 * GitHub uses 1-based page numbers; if no `page` param is present we assume
 * we're on page 1 and bump to page 2.
 */
function advancePageUrl(url: string): string {
  try {
    const u = new URL(url);
    const page = parseInt(u.searchParams.get("page") ?? "1", 10);
    u.searchParams.set("page", String(isNaN(page) ? 2 : page + 1));
    return u.toString();
  } catch {
    // If URL parsing fails, bail — don't loop infinitely.
    return "";
  }
}

// ---------------------------------------------------------------------------
// Document builder
// ---------------------------------------------------------------------------

function buildDocument(
  comment: GitHubComment,
  repo: string,
  kind: string,
  fetchedAt: string,
): ConnectorDocument {
  const externalId = `${repo}/${kind}/${comment.id}`;
  const externalUrl =
    typeof comment.html_url === "string" && comment.html_url.length > 0
      ? comment.html_url
      : undefined;
  const title = buildTitle(repo, kind, comment);

  return {
    id: externalId,
    title,
    content: (comment.body ?? "").trim(),
    source: {
      connector: GITHUB_CONNECTOR_ID,
      externalId,
      externalRevision: comment.updated_at,
      externalUrl,
      fetchedAt,
    },
  };
}

/**
 * Build a short human-readable title for the comment document.
 * We avoid fetching the issue/PR title to keep the connector read-light.
 */
function buildTitle(repo: string, kind: string, comment: GitHubComment): string {
  const kindLabel =
    kind === "issue-comment"
      ? "Issue comment"
      : kind === "pr-review-comment"
        ? "PR review comment"
        : "Discussion comment";
  return `${kindLabel} in ${repo} (#${comment.id})`;
}
