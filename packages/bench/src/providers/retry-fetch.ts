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
  /**
   * Maximum wall-clock time (ms) to keep retrying 429 responses.
   * When set, 429s are retried with capped exponential backoff
   * until this budget expires, regardless of maxAttempts.
   * Useful for session-quota rate limits that take minutes to reset.
   * Set to 0 or undefined to disable (uses maxAttempts instead).
   */
  max429WaitMs?: number;
}

const DEFAULTS: Required<RetryFetchOptions> = {
  maxAttempts: 3,
  baseBackoffMs: 1000,
  timeoutMs: 120_000,
  max429WaitMs: 0,
};

/** Maximum time to wait on a single Retry-After value (seconds). */
const MAX_RETRY_AFTER_S = 600;

/** Maximum backoff for a single 429 retry when no Retry-After header (seconds). */
const MAX_429_BACKOFF_S = 120;

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
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.min(asNumber, MAX_RETRY_AFTER_S) * 1000;
  }

  // Only try HTTP-date parsing for non-numeric values.
  if (Number.isNaN(asNumber)) {
    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_S * 1000) : 0;
    }
  }

  return undefined;
}

function abortAwareSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryFetch(
  url: string,
  init: RequestInit,
  options?: RetryFetchOptions,
): Promise<Response> {
  const opts = { ...DEFAULTS, ...options };
  let lastError: Error | null = null;
  let last429Response: Response | null = null;
  let last429IsStale = false;
  const loopStartMs = Date.now();

  for (let attempt = 1; ; attempt++) {
    const callerSignal = init.signal as AbortSignal | undefined;
    if (callerSignal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // Non-429 errors (transient, 5xx) are always capped by maxAttempts.
    // The 429 budget only extends retries for 429 responses beyond maxAttempts.
    if (attempt > opts.maxAttempts) {
      const in429Budget = opts.max429WaitMs > 0 &&
        (Date.now() - loopStartMs) < opts.max429WaitMs;
      if (!in429Budget) {
        // Only return a saved 429 when the budget feature is active and
        // no non-429 failures have occurred since the last 429.
        // With max429WaitMs=0 (default), always break to throw lastError.
        if (opts.max429WaitMs > 0 && last429Response && !last429IsStale) return last429Response;
        break;
      }
      // Past maxAttempts but within 429 budget — only continue if we've
      // seen a 429. Otherwise transient/5xx errors would loop uncapped.
      if (!last429Response) {
        break;
      }
    }

    const controller = new AbortController();
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

      // 1xx informational / 3xx redirect — return immediately, no retry.
      if (response.status < 400) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        return response;
      }

      // 429 Too Many Requests — pause and retry.
      if (response.status === 429) {
        const inBudget = opts.max429WaitMs > 0 &&
          (Date.now() - loopStartMs) < opts.max429WaitMs;
        const underMaxAttempts = attempt < opts.maxAttempts;

        // Stop if past maxAttempts with no budget remaining.
        // Under maxAttempts, 429s always retry regardless of budget —
        // the budget only EXTENDS retries beyond maxAttempts.
        if (!underMaxAttempts && !inBudget) {
          // Return the response with a readable body for the caller.
          callerSignal?.removeEventListener("abort", onCallerAbort);
          return response;
        }

        // Only cancel the body when we're going to retry.
        await response.body?.cancel();
        last429Response = response;
        last429IsStale = false;

        let waitMs =
          parseRetryAfterMs(response.headers.get("retry-after")) ??
          Math.min(
            opts.baseBackoffMs * Math.pow(2, attempt - 1),
            MAX_429_BACKOFF_S * 1000,
          );

        // Clamp to remaining 429 budget so we don't overshoot.
        if (opts.max429WaitMs > 0) {
          const remaining = opts.max429WaitMs - (Date.now() - loopStartMs);
          waitMs = Math.min(waitMs, Math.max(remaining, 0));
        }

        const budgetTag = inBudget
          ? ` (${Math.round((Date.now() - loopStartMs) / 1000)}s/${Math.round(opts.max429WaitMs / 1000)}s budget)`
          : "";

        console.error(
          `[rate-limit] 429 received (attempt ${attempt}/${opts.maxAttempts})${budgetTag}, ` +
            `pausing ${Math.round(waitMs / 1000)}s before retry…`,
        );
        await abortAwareSleep(waitMs, callerSignal);

        callerSignal?.removeEventListener("abort", onCallerAbort);
        continue;
      }

      // 4xx (other than 429) — return immediately, no retry.
      if (response.status >= 400 && response.status < 500) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        return response;
      }

      // 5xx — retry with exponential backoff (bounded by maxAttempts only).
      if (attempt >= opts.maxAttempts) {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        const bodyPreview = await readBodyPreview(response, 512);
        throw new Error(
          `HTTP ${response.status} ${response.statusText} (attempt ${attempt}/${opts.maxAttempts}): ${bodyPreview}`,
        );
      }
      const bodyPreview = await readBodyPreview(response, 512);
      lastError = new Error(
        `HTTP ${response.status} ${response.statusText} (attempt ${attempt}/${opts.maxAttempts}): ${bodyPreview}`,
      );
      last429IsStale = true;
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
      last429IsStale = true;
    }

    // Backoff before next attempt. Capped at maxAttempts for non-429 errors.
    if (attempt < opts.maxAttempts) {
      const backoffMs = opts.baseBackoffMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError ?? new Error("retryFetch: all attempts exhausted");
}
