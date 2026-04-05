import type { AdapterContext, EngramAdapter, ResolvedIdentity } from "./types.js";

/**
 * Hermes Agent adapter.
 *
 * Detects Hermes connections via the X-Hermes-Session-Id header or
 * X-Hermes-Profile header. Hermes profiles isolate agents, so the
 * profile name maps to the Engram namespace.
 */
export class HermesAdapter implements EngramAdapter {
  readonly id = "hermes";

  matches(context: AdapterContext): boolean {
    if (headerValue(context.headers, "x-hermes-session-id")) return true;
    if (headerValue(context.headers, "x-hermes-profile")) return true;
    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    const sessionId = headerValue(context.headers, "x-hermes-session-id");
    const profile = headerValue(context.headers, "x-hermes-profile");

    const namespace = profile
      ? slugify(profile)
      : "hermes";

    const principal = headerValue(context.headers, "x-engram-principal")
      || profile
      || "hermes-agent";

    return {
      namespace,
      principal,
      sessionKey: sessionId ?? context.sessionKey,
      adapterId: this.id,
    };
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = headers[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function slugify(s: string): string {
  let slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  while (start < slug.length && slug[start] === "-") start++;
  let end = slug.length;
  while (end > start && slug[end - 1] === "-") end--;
  return slug.slice(start, end).slice(0, 80) || "hermes";
}
