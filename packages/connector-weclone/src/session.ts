/**
 * Session mapping strategies.
 *
 * Maps caller identity to Remnic session keys so memory is scoped
 * appropriately per user or shared across all callers.
 */

export interface ChatCompletionRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  user?: string;
  [key: string]: unknown;
}

export interface SessionMapper {
  resolve(
    headers: Record<string, string | string[] | undefined>,
    body: ChatCompletionRequest
  ): string;
}

/**
 * Returns a fixed session key for single-user setups.
 */
export class SingleSessionMapper implements SessionMapper {
  private readonly key: string;

  constructor(key = "weclone-default") {
    this.key = key;
  }

  resolve(
    _headers: Record<string, string | string[] | undefined>,
    _body: ChatCompletionRequest
  ): string {
    return this.key;
  }
}

/**
 * Extracts caller identity from request metadata.
 *
 * Resolution order:
 * 1. `X-Caller-Id` header
 * 2. `user` field in the request body
 * 3. Falls back to "default"
 */
export class CallerIdSessionMapper implements SessionMapper {
  private readonly fallback: string;

  constructor(fallback = "default") {
    this.fallback = fallback;
  }

  resolve(
    headers: Record<string, string | string[] | undefined>,
    body: ChatCompletionRequest
  ): string {
    const headerValue = headers["x-caller-id"];
    if (typeof headerValue === "string" && headerValue.length > 0) {
      return headerValue;
    }

    if (typeof body.user === "string" && body.user.length > 0) {
      return body.user;
    }

    return this.fallback;
  }
}
