import type { AdapterContext, EngramAdapter, ResolvedIdentity } from "./types.js";

/**
 * Claude Code adapter.
 *
 * Detects Claude Code connections via MCP client info (name contains
 * "claude") or the X-Claude-Session-Id header. Maps the project path
 * or session ID to an Engram namespace.
 */
export class ClaudeCodeAdapter implements EngramAdapter {
  readonly id = "claude-code";

  matches(context: AdapterContext): boolean {
    const clientName = context.clientInfo?.name?.toLowerCase() ?? "";
    if (clientName.includes("claude")) return true;

    const sessionHeader = headerValue(context.headers, "x-claude-session-id");
    if (sessionHeader) return true;

    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    const sessionId = headerValue(context.headers, "x-claude-session-id");
    const projectPath = headerValue(context.headers, "x-claude-project-path");

    const namespace = projectPath
      ? slugify(projectPath)
      : "claude-code";

    const principal = headerValue(context.headers, "x-engram-principal")
      || context.clientInfo?.name
      || "claude-code";

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
  return slug.slice(start, end).slice(0, 80) || "claude-code";
}
