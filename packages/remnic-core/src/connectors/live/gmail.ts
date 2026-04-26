/**
 * @remnic/core — Gmail live connector (issue #683 PR 4/6)
 *
 * Concrete `LiveConnector` implementation that incrementally imports new
 * inbox messages from Gmail into Remnic. Built on top of the framework
 * shipped in PR 1/N (`framework.ts` / `registry.ts` / `state-store.ts`)
 * and mirrors the structure of the Drive connector (PR 2/N) and the Notion
 * connector (PR 3/N).
 *
 * Design notes:
 *
 *   - **Auth.** OAuth2 refresh-token from config (`connectors.gmail.*`).
 *     Tokens are accepted at config-parse time but never logged. Operators
 *     must populate them from a secret store; per the repo-wide privacy
 *     policy no real value may appear in tests, fixtures, or comments.
 *
 *   - **Transport.** Raw `fetch` against
 *     `https://gmail.googleapis.com/gmail/v1/...` with a bearer token
 *     obtained from the OAuth2 token endpoint using the refresh token.
 *     We do NOT depend on `googleapis` — there is no optional-peer-dep
 *     machinery needed and the API surface we consume is tiny. The
 *     `fetchFn` argument is the test hook allowing stubbing without
 *     network access.
 *
 *   - **Cursor semantics.** High-water mark is the highest `internalDate`
 *     (Unix epoch milliseconds as a string) seen across all successfully
 *     processed messages. Stored as a single ISO 8601 string in the cursor
 *     value. On first sync (cursor=null) we record "now" as the watermark
 *     WITHOUT importing anything — mirrors Drive's getStartPageToken
 *     bootstrap and keeps "first install" from re-ingesting history.
 *
 *   - **Polling.** `users.messages.list` with `q: "after:<internalDate/1000>
 *     <userQuery>"` retrieves message ids newer than the watermark. We then
 *     fetch each message with `users.messages.get?format=full`.
 *
 *   - **Content extraction.** Plaintext body (`text/plain` part first;
 *     `text/html` as fallback, stripped to text). Attachment parts are
 *     ignored — bytes belong in the binary-lifecycle pipeline.
 *
 *   - **Idempotency.** `ConnectorDocument.source.externalId` is the message
 *     id and `externalRevision` is `internalDate` (epoch ms string), so
 *     downstream dedup can recognise repeat fetches if the cursor is rewound.
 *
 *   - **Watermark advancement.** The high-water mark advances only when a
 *     message is SUCCESSFULLY processed. If a transient error stops the
 *     pass mid-batch, the cursor is NOT advanced so the next poll retries
 *     the same batch. This mirrors Drive's contract (CLAUDE.md gotcha: never
 *     advance cursor past unprocessed transient failures).
 *
 *   - **Privacy.** No message content, subject, or headers are ever logged.
 *     Message counts and ids may be logged. OAuth credentials are never
 *     exposed in logs, state, or error messages.
 *
 *   - **Read-only.** This connector only reads. It never marks messages as
 *     read, modifies labels, or mutates any Gmail resource.
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

/** Stable connector id. Lives in the registry under this exact string. */
export const GMAIL_CONNECTOR_ID = "gmail";

/**
 * Cursor `kind` we emit. Opaque to the framework; documented here so
 * tests can assert on it.
 */
export const GMAIL_CURSOR_KIND = "gmailWatermark";

/**
 * Default poll interval (5 minutes). Gmail has no push capability in the
 * connector model; polling sub-minute wastes quota for a personal memory
 * layer.
 */
export const GMAIL_DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Hard cap on poll interval: 24 hours. */
const GMAIL_MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on individual message text size. Gmail messages can be large;
 * we skip rather than blow the importer's heap.
 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * Maximum number of messages we process in a single `syncIncremental` pass.
 * Prevents one runaway pass from monopolising the scheduler.
 */
const MAX_MESSAGES_PER_PASS = 200;

/**
 * Maximum page size for `users.messages.list`. Gmail API maximum is 500.
 */
const LIST_PAGE_SIZE = 100;

/** Gmail API base URL. */
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

/** OAuth2 token endpoint. */
const OAUTH2_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/**
 * Validated, frozen view of `connectors.gmail.*`.
 */
export interface GmailConnectorConfig {
  /** OAuth2 client id. */
  readonly clientId: string;
  /** OAuth2 client secret. */
  readonly clientSecret: string;
  /** OAuth2 refresh token issued for the Gmail scope. */
  readonly refreshToken: string;
  /** Gmail userId (almost always "me"). */
  readonly userId: string;
  /** Gmail search query applied in addition to the watermark filter. */
  readonly query: string;
  /** Poll interval surfaced to the scheduler (ms). */
  readonly pollIntervalMs: number;
}

// ---------------------------------------------------------------------------
// Gmail API response shapes (only the fields we consume)
// ---------------------------------------------------------------------------

/** Minimal message-list entry from `users.messages.list`. */
export interface GmailMessageRef {
  readonly id: string;
  readonly threadId?: string;
}

/** Minimal message response from `users.messages.get`. */
export interface GmailMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly internalDate?: string;
  readonly snippet?: string;
  readonly payload?: GmailMessagePart;
}

/** Minimal MIME part shape. */
export interface GmailMessagePart {
  readonly mimeType?: string;
  readonly body?: { readonly data?: string; readonly size?: number };
  readonly parts?: readonly GmailMessagePart[];
  readonly headers?: readonly GmailHeader[];
}

/** Message header. */
export interface GmailHeader {
  readonly name?: string;
  readonly value?: string;
}

// ---------------------------------------------------------------------------
// Fetch abstraction (test hook)
// ---------------------------------------------------------------------------

/**
 * Minimal fetch-compatible surface we use. The real connector delegates to
 * the global `fetch`; tests inject a stub factory.
 */
export type GmailFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Validate and normalise raw config. Throws with a concrete message on any
 * malformed input — never silently defaults (CLAUDE.md gotcha #51).
 */
export function validateGmailConfig(raw: unknown): GmailConnectorConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(
      `gmail: config must be an object, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  const r = raw as Record<string, unknown>;

  const clientId = requireNonEmptyString(r.clientId, "clientId");
  const clientSecret = requireNonEmptyString(r.clientSecret, "clientSecret");
  const refreshToken = requireNonEmptyString(r.refreshToken, "refreshToken");

  // userId defaults to "me"
  let userId = "me";
  if (r.userId !== undefined) {
    if (typeof r.userId !== "string") {
      throw new TypeError(`gmail: userId must be a string (got ${typeof r.userId})`);
    }
    const trimmed = r.userId.trim();
    if (trimmed.length === 0) {
      throw new RangeError("gmail: userId must be non-empty");
    }
    userId = trimmed;
  }

  // query defaults to "in:inbox"
  let query = "in:inbox";
  if (r.query !== undefined) {
    if (typeof r.query !== "string") {
      throw new TypeError(`gmail: query must be a string (got ${typeof r.query})`);
    }
    // Allow empty query (user wants all mail)
    query = r.query;
  }

  // pollIntervalMs
  let pollIntervalMs: number;
  if (r.pollIntervalMs === undefined) {
    pollIntervalMs = GMAIL_DEFAULT_POLL_INTERVAL_MS;
  } else if (typeof r.pollIntervalMs !== "number" || !Number.isFinite(r.pollIntervalMs)) {
    throw new TypeError(
      `gmail: pollIntervalMs must be a finite number (got ${JSON.stringify(r.pollIntervalMs)})`,
    );
  } else if (!Number.isInteger(r.pollIntervalMs)) {
    throw new TypeError(
      `gmail: pollIntervalMs must be an integer (got ${r.pollIntervalMs})`,
    );
  } else if (r.pollIntervalMs < 1_000) {
    throw new RangeError(
      `gmail: pollIntervalMs must be ≥1000ms; got ${r.pollIntervalMs}`,
    );
  } else if (r.pollIntervalMs > GMAIL_MAX_POLL_INTERVAL_MS) {
    throw new RangeError(
      `gmail: pollIntervalMs must be ≤${GMAIL_MAX_POLL_INTERVAL_MS} (24h); got ${r.pollIntervalMs}`,
    );
  } else {
    pollIntervalMs = r.pollIntervalMs;
  }

  return Object.freeze({
    clientId,
    clientSecret,
    refreshToken,
    userId,
    query,
    pollIntervalMs,
  });
}

function requireNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`gmail: ${key} must be a string (got ${typeof value})`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RangeError(`gmail: ${key} must be non-empty`);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a fetch error as transient (re-throw to stop the pass without
 * advancing the cursor) or terminal (skip-and-continue for per-message
 * errors).
 *
 * Transient:
 *   - 429 (rate-limit — retry after backoff)
 *   - 5xx (Gmail backend error)
 *   - AbortError / network errors (ECONNRESET, ETIMEDOUT, …)
 *
 * Terminal (skip-and-continue):
 *   - 404 (message deleted or not accessible)
 *   - 403 (permission denied)
 *   - 400 (bad request — won't be fixed by retrying)
 *   - any other 4xx that isn't 429
 *
 * Mirrors Drive's `isTransientDriveError` pattern (CLAUDE.md architecture).
 */
export function isTransientGmailError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    gmailStatus?: unknown;
    response?: { status?: unknown } | null;
    message?: unknown;
  };

  // AbortError
  if (typeof e.name === "string" && e.name === "AbortError") return true;

  // HTTP status attached by our own error-throwing code (see `gmailFetch`),
  // or by fetch-layer libraries.
  const status = pickHttpStatus(e);
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

function pickHttpStatus(e: {
  code?: unknown;
  status?: unknown;
  gmailStatus?: unknown;
  response?: { status?: unknown } | null;
}): number | undefined {
  // Our own `gmailStatus` property set in `gmailFetch`.
  if (typeof e.gmailStatus === "number" && Number.isFinite(e.gmailStatus)) {
    return e.gmailStatus;
  }
  // `response.status` (fetch-compatible error shapes).
  const responseStatus = e.response?.status;
  if (typeof responseStatus === "number" && Number.isFinite(responseStatus)) {
    return responseStatus;
  }
  // Top-level `status`.
  if (typeof e.status === "number" && Number.isFinite(e.status)) {
    return e.status;
  }
  // Numeric `code`.
  if (typeof e.code === "number" && Number.isFinite(e.code)) {
    return e.code;
  }
  // String-numeric codes ("429" / "503").
  if (typeof e.code === "string" && /^\d+$/.test(e.code)) {
    const n = Number(e.code);
    if (Number.isFinite(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/**
 * Cursor payload. A single ISO 8601 watermark — the `internalDate` (converted
 * from epoch-ms to Date) of the most recently processed message.
 */
interface GmailCursorPayload {
  /** ISO 8601 timestamp of the highest internalDate seen. */
  watermarkIso: string;
}

function makeCursor(payload: GmailCursorPayload): ConnectorCursor {
  return {
    kind: GMAIL_CURSOR_KIND,
    value: JSON.stringify(payload),
    updatedAt: new Date().toISOString(),
  };
}

function parseCursorPayload(cursor: ConnectorCursor): GmailCursorPayload {
  if (cursor.kind !== GMAIL_CURSOR_KIND) {
    throw new Error(
      `gmail: unexpected cursor kind ${JSON.stringify(cursor.kind)}; expected ${GMAIL_CURSOR_KIND}`,
    );
  }
  // CLAUDE.md gotcha #18: validate after parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor.value);
  } catch {
    throw new Error(`gmail: cursor value is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`gmail: cursor value does not match GmailCursorPayload shape`);
  }
  const p = parsed as Record<string, unknown>;
  const watermarkIso = typeof p.watermarkIso === "string" ? p.watermarkIso : "";
  return { watermarkIso };
}

/**
 * Convert an `internalDate` epoch-ms string to epoch seconds (for Gmail's
 * `after:` query operator which takes epoch seconds).
 */
function internalDateToEpochSeconds(internalDate: string): number {
  const ms = Number(internalDate);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 1000);
}

/**
 * Convert an `internalDate` epoch-ms string to an ISO 8601 string.
 */
function internalDateToIso(internalDate: string): string {
  const ms = Number(internalDate);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Cooperative cancellation
// ---------------------------------------------------------------------------

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("gmail: sync aborted");
    err.name = "AbortError";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Gmail API client helpers
// ---------------------------------------------------------------------------

/**
 * Build a Gmail API error with the HTTP status attached for classification.
 */
function makeGmailApiError(
  status: number,
  message: string,
): Error & { gmailStatus: number } {
  const err = new Error(`gmail: API error ${status}: ${message}`) as Error & {
    gmailStatus: number;
  };
  err.gmailStatus = status;
  return err;
}

/**
 * Helper to call a Gmail API endpoint via GET. Throws a structured error on
 * non-2xx responses and propagates network errors unchanged.
 */
async function gmailGet(
  fetchFn: GmailFetchFn,
  accessToken: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const url = `${GMAIL_API_BASE}${path}`;
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal,
  });

  const data = await res.json();
  if (!res.ok) {
    const msg = extractApiErrorMessage(data);
    throw makeGmailApiError(res.status, msg);
  }
  return data;
}

function extractApiErrorMessage(data: unknown): string {
  if (
    typeof data === "object" &&
    data !== null &&
    typeof (data as Record<string, unknown>).error === "object"
  ) {
    const errObj = (data as Record<string, unknown>).error as Record<string, unknown>;
    if (typeof errObj.message === "string") return errObj.message;
  }
  return "unknown error";
}

// ---------------------------------------------------------------------------
// Access token exchange
// ---------------------------------------------------------------------------

/**
 * Exchange the refresh token for a short-lived access token via the OAuth2
 * token endpoint. We never cache the access token — each pass gets a fresh
 * one to avoid partial-session token expiry.
 *
 * Credentials are NEVER logged (CLAUDE.md privacy policy).
 */
async function exchangeRefreshToken(
  fetchFn: GmailFetchFn,
  config: GmailConnectorConfig,
  signal: AbortSignal | undefined,
): Promise<string> {
  throwIfAborted(signal);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetchFn(OAUTH2_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal,
  });

  const data = await res.json();
  if (!res.ok) {
    // Do NOT include any credential values in the error message.
    throw makeGmailApiError(
      res.status,
      `OAuth2 token exchange failed (HTTP ${res.status})`,
    );
  }

  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as Record<string, unknown>).access_token !== "string"
  ) {
    throw new Error("gmail: OAuth2 token exchange returned no access_token");
  }
  return (data as Record<string, unknown>).access_token as string;
}

// ---------------------------------------------------------------------------
// Message body extraction
// ---------------------------------------------------------------------------

/**
 * Recursively extract `text/plain` body from a MIME part tree. Falls back to
 * `text/html` (stripped) if no plain-text part exists. Returns an empty
 * string for binary / attachment parts.
 */
function extractBodyFromPart(part: GmailMessagePart): string {
  const mime = part.mimeType ?? "";

  // Plain text — decode base64url and return.
  if (mime === "text/plain") {
    return decodeBase64urlBody(part.body?.data ?? "");
  }

  // HTML — decode and strip tags.
  if (mime === "text/html") {
    const raw = decodeBase64urlBody(part.body?.data ?? "");
    return stripHtmlTags(raw);
  }

  // Multipart — recurse into parts, prefer text/plain over text/html.
  if (mime.startsWith("multipart/") && Array.isArray(part.parts)) {
    // First pass: look for text/plain (direct children only for efficiency).
    for (const child of part.parts) {
      if ((child.mimeType ?? "") === "text/plain") {
        const text = decodeBase64urlBody(child.body?.data ?? "");
        if (text.length > 0) return text;
      }
    }
    // Second pass: recurse into all children and take the first non-empty result.
    for (const child of part.parts) {
      const text = extractBodyFromPart(child);
      if (text.length > 0) return text;
    }
  }

  return "";
}

/**
 * Decode a base64url-encoded string (Gmail API encodes all message body data
 * in base64url). Returns empty string on any error rather than throwing.
 */
function decodeBase64urlBody(encoded: string): string {
  if (!encoded) return "";
  try {
    // base64url → base64: replace URL-safe chars with standard chars.
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    // Add padding if needed.
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

/**
 * Minimal HTML tag stripper. Collapses all `<...>` spans and decodes common
 * HTML entities in a single pass to avoid double-unescaping (CodeQL finding:
 * chained replace calls can expand `&amp;lt;` → `&lt;` → `<`). The entity
 * map is applied in one `replace` with a callback, so each entity is decoded
 * exactly once and the output is never fed back through entity expansion.
 */
function stripHtmlTags(html: string): string {
  if (!html) return "";
  // Step 1: strip all HTML tags.
  const noTags = html.replace(/<[^>]*>/g, " ");
  // Step 2: decode HTML entities in a single pass via a lookup table.
  const HTML_ENTITIES: Readonly<Record<string, string>> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
  };
  const decoded = noTags.replace(/&(?:#39|nbsp|amp|lt|gt|quot|apos);/gi, (entity) => {
    return HTML_ENTITIES[entity.toLowerCase()] ?? entity;
  });
  // Step 3: collapse whitespace.
  return decoded.replace(/\s{2,}/g, " ").trim();
}

/**
 * Extract the `Subject` header value from a message. Returns undefined if
 * not present. Never logs the value.
 */
function extractSubject(message: GmailMessage): string | undefined {
  const headers = message.payload?.headers ?? [];
  for (const h of headers) {
    if (typeof h.name === "string" && h.name.toLowerCase() === "subject") {
      const v = h.value;
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sync result type
// ---------------------------------------------------------------------------

/**
 * Result of a single sync pass. Superset of `SyncIncrementalResult` for
 * richer test assertions.
 */
export interface GmailSyncResult extends SyncIncrementalResult {
  readonly skippedInaccessible: number;
  readonly skippedEmpty: number;
  readonly skippedTooLarge: number;
}

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

/**
 * Construct the connector. The `fetchFn` argument is the test hook —
 * production callers omit it and the connector uses the global `fetch`.
 */
export function createGmailConnector(
  options: { fetchFn?: GmailFetchFn } = {},
): LiveConnector {
  const fetchFn: GmailFetchFn =
    options.fetchFn ??
    (globalThis.fetch as unknown as GmailFetchFn);

  return {
    id: GMAIL_CONNECTOR_ID,
    displayName: "Gmail",
    description:
      "Imports new inbox messages from Gmail into Remnic on a poll schedule.",

    validateConfig(raw: unknown): ConnectorConfig {
      return validateGmailConfig(raw) as unknown as ConnectorConfig;
    },

    async syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult> {
      const config = validateGmailConfig(args.config);
      throwIfAborted(args.abortSignal);

      // Exchange credentials for a short-lived access token.
      const accessToken = await exchangeRefreshToken(fetchFn, config, args.abortSignal);
      throwIfAborted(args.abortSignal);

      // First-sync bootstrap: record "now" as the watermark and return
      // without importing anything. Mirrors Drive's getStartPageToken pattern.
      if (args.cursor === null) {
        const nowIso = new Date().toISOString();
        const bootstrapResult: GmailSyncResult = {
          newDocs: [],
          nextCursor: makeCursor({ watermarkIso: nowIso }),
          skippedInaccessible: 0,
          skippedEmpty: 0,
          skippedTooLarge: 0,
        };
        return bootstrapResult;
      }

      const cursorPayload = parseCursorPayload(args.cursor);
      return await incrementalSync(
        fetchFn,
        accessToken,
        config,
        cursorPayload,
        args.abortSignal,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Incremental sync
// ---------------------------------------------------------------------------

async function incrementalSync(
  fetchFn: GmailFetchFn,
  accessToken: string,
  config: GmailConnectorConfig,
  cursorPayload: GmailCursorPayload,
  signal: AbortSignal | undefined,
): Promise<GmailSyncResult> {
  const fetchedAt = new Date().toISOString();
  const newDocs: ConnectorDocument[] = [];
  let skippedInaccessible = 0;
  let skippedEmpty = 0;
  let skippedTooLarge = 0;
  let totalConsumed = 0;

  // Convert ISO watermark to epoch-seconds for the Gmail `after:` operator.
  let afterEpochSec = 0;
  if (cursorPayload.watermarkIso.length > 0) {
    const ms = new Date(cursorPayload.watermarkIso).getTime();
    if (Number.isFinite(ms) && ms > 0) {
      afterEpochSec = Math.floor(ms / 1000);
    }
  }

  // Build the Gmail search query: combine watermark filter with user query.
  const listQuery = buildListQuery(afterEpochSec, config.query);

  // Track the highest internalDate seen across successfully processed messages.
  let highWaterMs = afterEpochSec > 0 ? afterEpochSec * 1000 : 0;

  let pageToken: string | undefined = undefined;

  // Whether we exhausted the full message list without hitting the per-pass
  // cap. Mirrors Notion's `databaseFullyDrained` pattern (Codex P1 review):
  // only advance the watermark when we fully drained the list. If the cap was
  // hit mid-pass, the next poll must re-query the same `after:` window to pick
  // up the remaining messages — advancing the watermark would permanently skip
  // them (especially with newest-first list ordering).
  let listFullyDrained = false;
  let capHit = false;

  // Page through messages.list until exhausted, aborted, or per-pass cap hit.
  outer: while (true) {
    throwIfAborted(signal);

    // Build the list URL.
    let listPath = `/users/${encodeURIComponent(config.userId)}/messages?maxResults=${LIST_PAGE_SIZE}&q=${encodeURIComponent(listQuery)}`;
    if (pageToken) {
      listPath += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    const listData = await gmailGet(fetchFn, accessToken, listPath, signal);
    throwIfAborted(signal);

    const listPage = listData as {
      messages?: GmailMessageRef[];
      nextPageToken?: string;
    };

    const messages = listPage.messages ?? [];

    for (const ref of messages) {
      throwIfAborted(signal);

      if (totalConsumed >= MAX_MESSAGES_PER_PASS) {
        // Hit the per-pass cap mid-page. Do NOT advance the watermark — the
        // remaining messages in this window must be retried on the next poll.
        capHit = true;
        break outer;
      }
      totalConsumed++;

      const doc = await fetchMessageDocument(
        fetchFn,
        accessToken,
        config,
        ref.id,
        fetchedAt,
        signal,
      );

      if (doc === "inaccessible") {
        skippedInaccessible++;
        // Terminal: don't re-fetch. Do NOT advance watermark based on this
        // message since we don't know its internalDate.
      } else if (doc === "empty") {
        skippedEmpty++;
      } else if (doc === "too-large") {
        skippedTooLarge++;
      } else if (doc !== null) {
        newDocs.push(doc);
        // Track highest internalDate to advance watermark when fully drained.
        if (doc.source.externalRevision) {
          const msgMs = Number(doc.source.externalRevision);
          if (Number.isFinite(msgMs) && msgMs > highWaterMs) {
            highWaterMs = msgMs;
          }
        }
      }
    }

    // Continue to the next page if Gmail signals more results.
    if (typeof listPage.nextPageToken === "string" && listPage.nextPageToken.length > 0) {
      pageToken = listPage.nextPageToken;
      continue;
    }

    // No nextPageToken — the list is fully drained for this `after:` window.
    listFullyDrained = true;
    break;
  }

  // Only advance the watermark when we fully drained the list (no cap hit, no
  // premature abort). If we stopped early, preserve the existing watermark so
  // the next poll re-queries the same `after:` window and processes the
  // remaining messages. This mirrors Notion's databaseFullyDrained contract.
  const nextWatermarkIso =
    listFullyDrained && !capHit && highWaterMs > (afterEpochSec * 1000)
      ? new Date(highWaterMs).toISOString()
      : cursorPayload.watermarkIso;

  const nextCursor = makeCursor({ watermarkIso: nextWatermarkIso });

  return {
    newDocs,
    nextCursor,
    skippedInaccessible,
    skippedEmpty,
    skippedTooLarge,
  };
}

/**
 * Build the Gmail query string combining the `after:` watermark filter with
 * the operator-configured `query`. The `after:` operator takes epoch seconds.
 */
function buildListQuery(afterEpochSec: number, userQuery: string): string {
  const parts: string[] = [];
  if (afterEpochSec > 0) {
    parts.push(`after:${afterEpochSec}`);
  }
  const trimmedUser = userQuery.trim();
  if (trimmedUser.length > 0) {
    parts.push(trimmedUser);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Per-message document fetch
// ---------------------------------------------------------------------------

async function fetchMessageDocument(
  fetchFn: GmailFetchFn,
  accessToken: string,
  config: GmailConnectorConfig,
  messageId: string,
  fetchedAt: string,
  signal: AbortSignal | undefined,
): Promise<ConnectorDocument | "inaccessible" | "empty" | "too-large" | null> {
  throwIfAborted(signal);

  let message: GmailMessage;
  try {
    const path = `/users/${encodeURIComponent(config.userId)}/messages/${encodeURIComponent(messageId)}?format=full`;
    const data = await gmailGet(fetchFn, accessToken, path, signal);
    message = data as GmailMessage;
  } catch (err) {
    if (isTransientGmailError(err)) {
      // Transient: re-throw to stop the pass without advancing the cursor.
      throw err;
    }
    // Terminal (404 / 403 / 400): skip this message.
    return "inaccessible";
  }

  // Extract body text.
  const body = message.payload ? extractBodyFromPart(message.payload) : "";

  if (typeof body !== "string" || body.trim().length === 0) return "empty";
  if (body.length > MAX_TEXT_BYTES) return "too-large";

  const subject = extractSubject(message);
  const internalDate = message.internalDate ?? "";

  return {
    id: messageId,
    title: subject,
    content: body,
    source: {
      connector: GMAIL_CONNECTOR_ID,
      externalId: messageId,
      // Store internalDate (epoch ms string) as the revision so downstream
      // dedup can identify repeat fetches after cursor rewind.
      externalRevision: internalDate.length > 0 ? internalDate : undefined,
      fetchedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Watermark helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Convert an `internalDate` epoch-ms string to an ISO 8601 timestamp.
 * Exported for test assertions.
 */
export { internalDateToIso, internalDateToEpochSeconds, buildListQuery };
