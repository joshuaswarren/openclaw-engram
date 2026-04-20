// ---------------------------------------------------------------------------
// Mem0 REST client (issue #568 slice 5)
// ---------------------------------------------------------------------------
//
// mem0.ai exposes a paginated memories list endpoint. A production user will
// typically hit the hosted service at `https://api.mem0.ai/v1/memories/`,
// supply a Bearer API key, and pull down their account's memories page by
// page. Some users self-host and need a configurable base URL.
//
// This client is intentionally tiny:
//   - fetch-based; no SDK dependency.
//   - Injectable `fetch` impl so tests can replay a record/replay fixture.
//   - Abort-signal aware for clean cancellation.
//   - Rate-limit aware (sleeps between page requests when `rateLimit` is set
//     on `RunImportOptions`).
//
// The adapter calls `fetchAllMem0Memories()` once; it walks pagination and
// returns a flat array. The transform layer then maps each raw record to an
// `ImportedMemory`.

export interface Mem0Memory {
  /** Stable memory id. */
  id: string;
  /** Memory body. API older responses nest this in `memory`. */
  memory?: string;
  content?: string;
  text?: string;
  user_id?: string;
  agent_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
  categories?: string[];
  score?: number;
}

/**
 * Shape returned by the paginated memories endpoint. The real API uses
 * `results` + `next` (cursor URL) on v1 and `memories` + `page` + `total`
 * on v0; the client accepts either so tests can replay both.
 */
export interface Mem0ListResponse {
  results?: Mem0Memory[];
  memories?: Mem0Memory[];
  next?: string | null;
  total?: number;
  page?: number;
  per_page?: number;
}

export interface Mem0ClientOptions {
  apiKey: string;
  /** Default: `https://api.mem0.ai`. Trailing slash tolerated. */
  baseUrl?: string;
  /** Injected for tests. Falls back to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Requests per second limiter. Applied between pages. */
  rateLimit?: number;
  /** Abort signal wired through to fetch. */
  signal?: AbortSignal;
  /** Sleep function for rate limiting; injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = "https://api.mem0.ai";

/**
 * Fetch all mem0 memories across pagination. Returns a flat array; the
 * caller is responsible for deduplication (the orchestrator does this
 * naturally via content hashing).
 */
export async function fetchAllMem0Memories(
  options: Mem0ClientOptions,
): Promise<Mem0Memory[]> {
  if (!options.apiKey || typeof options.apiKey !== "string") {
    throw new Error("mem0 import requires a non-empty apiKey");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "No fetch implementation available. Provide `fetchImpl` or run on Node 18+.",
    );
  }
  const sleep = options.sleep ?? defaultSleep;
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const intervalMs =
    options.rateLimit && options.rateLimit > 0 ? 1000 / options.rateLimit : 0;

  const all: Mem0Memory[] = [];
  const firstUrl = `${base}/v1/memories/`;
  let nextUrl: string | null = firstUrl;
  let pageIndex = 0;
  while (nextUrl) {
    throwIfAborted(options.signal);
    if (pageIndex > 0 && intervalMs > 0) {
      await sleep(intervalMs);
    }
    const response = await fetchImpl(nextUrl, {
      method: "GET",
      headers: {
        Authorization: `Token ${options.apiKey}`,
        Accept: "application/json",
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      const body = await safeText(response);
      throw new Error(
        `mem0 API request to ${nextUrl} failed with ${response.status}: ${body}`,
      );
    }
    const json = (await response.json()) as Mem0ListResponse;
    const page = json.results ?? json.memories ?? [];
    for (const entry of page) {
      if (entry && typeof entry === "object" && typeof entry.id === "string") {
        all.push(entry);
      }
    }
    nextUrl = resolveNextUrl(json, firstUrl, pageIndex, page.length);
    pageIndex += 1;
  }
  return all;
}

/**
 * Decide the next URL to request.
 *
 * Preferred: the `next` cursor the server returns (v1 shape).
 *
 * Fallback: when `next` is absent but the response exposes numeric
 * pagination fields (`page` / `total` / `per_page`, the older v0 shape),
 * synthesize a `?page=<N>` request for the next page. Cursor review on
 * PR #602 flagged that mem0 servers returning only numeric pagination
 * were silently truncated after page 1 under the original code.
 */
function resolveNextUrl(
  json: Mem0ListResponse,
  firstUrl: string,
  currentPageIndex: number,
  pageSize: number,
): string | null {
  if (typeof json.next === "string" && json.next.length > 0) return json.next;

  // Numeric-pagination fallback. `page` is 1-based in the real API.
  const responsePage = typeof json.page === "number" && Number.isFinite(json.page)
    ? json.page
    : currentPageIndex + 1;
  const perPage = typeof json.per_page === "number" && Number.isFinite(json.per_page)
    ? json.per_page
    : pageSize;
  const total = typeof json.total === "number" && Number.isFinite(json.total)
    ? json.total
    : undefined;
  if (total === undefined || perPage <= 0) return null;
  const fetchedSoFar = responsePage * perPage;
  if (fetchedSoFar >= total) return null;
  const nextPage = responsePage + 1;
  // Preserve any existing query string on firstUrl by using URL.
  try {
    const u = new URL(firstUrl);
    u.searchParams.set("page", String(nextPage));
    return u.toString();
  } catch {
    return null;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("mem0 import aborted");
    (err as Error & { name: string }).name = "AbortError";
    throw err;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "(failed to read response body)";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
