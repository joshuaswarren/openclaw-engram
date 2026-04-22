/**
 * Fetch wrapper with retry for transient failures.
 * Retries on ECONNREFUSED, ECONNRESET, ETIMEDOUT, HTTP 429 (rate limit),
 * and HTTP 5xx. 429 pauses according to the Retry-After header (or a
 * default backoff) before retrying, up to maxAttempts total.
 */

export interface RetryFetchOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  timeoutMs?: number;
}

const DEFAULTS: Required<RetryFetchOptions> = {
  maxAttempts: 3,
  baseBackoffMs: 1000,
  timeoutMs: 120_000,
};

/** Maximum time to wait on a single Retry-After value (seconds). */
const MAX_RETRY_AFTER_S = 600;

async function readBodyPreview(response: Response, maxBytes: number): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, maxBytes);
  } catch {
    return "";
  }
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnaborted") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    err.name === "AbortError"
  );
}

/**
 * Parse a Retry-After header value into milliseconds.
 * Accepts either an integer number of seconds or an HTTP-date.
 * Returns `undefined` when the header is absent or unparseable.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || value.length === 0) return undefined;

  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return Math.min(asNumber, MAX_RETRY_AFTER_S) * 1000;
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_S * 1000) : undefined;
  }

  return undefined;
}

export async function retryFetch(
  url: string,
  init: RequestInit,
  options?: RetryFetchOptions,
): Promise<Response> {
  const opts = { ...DEFAULTS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if ((init.signal as AbortSignal | undefined)?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const controller = new AbortController();
    const callerSignal = init.signal as AbortSignal | undefined;
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      const { signal: _callerSignal, ...initWithoutSignal } = init;
      const response = await fetch(url, { ...initWithoutSignal, signal: controller.signal });
      clearTimeout(timeout);

      if (response.ok) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        return response;
      }

      // 429 Too Many Requests — pause and retry.
      if (response.status === 429 && attempt < opts.maxAttempts) {
        // Drain the body so the connection can be reused.
        await readBodyPreview(response, 0);
        const waitMs =
          parseRetryAfterMs(response.headers.get("retry-after")) ??
          opts.baseBackoffMs * Math.pow(2, attempt - 1);
        console.error(
          `[rate-limit] 429 received (attempt ${attempt}/${opts.maxAttempts}), ` +
            `pausing ${Math.round(waitMs / 1000)}s before retry…`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      // 4xx (other than 429) — return immediately, no retry.
      if (response.status >= 400 && response.status < 500) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        return response;
      }

      // 5xx — retry with exponential backoff.
      const bodyPreview = await readBodyPreview(response, 512);
      lastError = new Error(
        `HTTP ${response.status} ${response.statusText} (attempt ${attempt}/${opts.maxAttempts}): ${bodyPreview}`,
      );
    } catch (err) {
      clearTimeout(timeout);
      if (callerSignal?.aborted) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        throw err;
      }
      if (!isTransientError(err)) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < opts.maxAttempts) {
      const backoffMs = opts.baseBackoffMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError ?? new Error("retryFetch: all attempts exhausted");
}
