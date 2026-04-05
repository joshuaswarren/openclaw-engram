import type { AdapterContext, EngramAdapter, ResolvedIdentity } from "./types.js";

/**
 * Replit Agent adapter.
 *
 * Detects Replit connections via the X-Replit-Project-Id header or
 * X-Replit-User-Id header. Replit uses HTTP REST, not MCP stdio,
 * so detection relies entirely on headers.
 */
export class ReplitAdapter implements EngramAdapter {
  readonly id = "replit";

  matches(context: AdapterContext): boolean {
    if (headerValue(context.headers, "x-replit-project-id")) return true;
    if (headerValue(context.headers, "x-replit-user-id")) return true;
    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    const projectId = headerValue(context.headers, "x-replit-project-id");
    const userId = headerValue(context.headers, "x-replit-user-id");

    const namespace = projectId
      ? `replit-${sanitizeId(projectId)}`
      : "replit";

    const principal = headerValue(context.headers, "x-engram-principal")
      || (userId ? `replit-user-${sanitizeId(userId)}` : "replit-agent");

    return {
      namespace,
      principal,
      sessionKey: context.sessionKey,
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

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}
