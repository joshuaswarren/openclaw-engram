import type { AdapterContext, EngramAdapter, ResolvedIdentity } from "./types.js";

/**
 * Codex CLI adapter.
 *
 * Detects Codex connections via MCP client info (name contains "codex")
 * or the X-Codex-Agent-Name header. Maps the agent name and project
 * directory to Engram namespace.
 */
export class CodexAdapter implements EngramAdapter {
  readonly id = "codex";

  matches(context: AdapterContext): boolean {
    const clientName = context.clientInfo?.name?.toLowerCase() ?? "";
    if (clientName.includes("codex")) return true;

    const agentHeader = headerValue(context.headers, "x-codex-agent-name");
    if (agentHeader) return true;

    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    const agentName = headerValue(context.headers, "x-codex-agent-name");
    const projectDir = headerValue(context.headers, "x-codex-project-dir");

    const namespace = projectDir
      ? slugify(projectDir)
      : "codex";

    const principal = headerValue(context.headers, "x-engram-principal")
      || agentName
      || context.clientInfo?.name
      || "codex";

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

function slugify(s: string): string {
  let slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  while (start < slug.length && slug[start] === "-") start++;
  let end = slug.length;
  while (end > start && slug[end - 1] === "-") end--;
  return slug.slice(start, end).slice(0, 80) || "codex";
}
