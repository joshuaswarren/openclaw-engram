/**
 * Fetch wrapper with retry for transient failures.
 * Retries on ECONNREFUSED, ECONNRESET, ETIMEDOUT, and HTTP 5xx.
 * Does NOT retry on 4xx (client errors) or auth errors.
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
    callerSignal?.addEventListener("abort", () => controller.abort(), { once: true });
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      const { signal: _callerSignal, ...initWithoutSignal } = init;
      const response = await fetch(url, { ...initWithoutSignal, signal: controller.signal });
      clearTimeout(timeout);

      if (response.ok || response.status < 500) {
        return response;
      }

      await response.body?.cancel().catch(() => {});
      lastError = new Error(
        `HTTP ${response.status} ${response.statusText} (attempt ${attempt}/${opts.maxAttempts})`,
      );
    } catch (err) {
      clearTimeout(timeout);
      if (callerSignal?.aborted) throw err;
      if (!isTransientError(err)) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < opts.maxAttempts) {
      const backoffMs = opts.baseBackoffMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError ?? new Error("retryFetch: all attempts exhausted");
}
