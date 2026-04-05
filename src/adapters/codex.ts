import type { AdapterContext, EngramAdapter, ResolvedIdentity } from "./types.js";

/**
 * Codex CLI adapter.
 *
 * Detection: Codex CLI sends clientInfo.name = "codex-mcp-client" and
 * clientInfo.title = "Codex" in the MCP initialize handshake. It does
 * NOT send agent names, session IDs, or project context automatically.
 *
 * For Streamable HTTP transport, Codex supports custom headers via
 * http_headers in ~/.codex/config.toml:
 *   [mcp_servers.engram]
 *   url = "http://localhost:4318/mcp"
 *   http_headers = { "X-Engram-Namespace" = "my-project", "X-Engram-Principal" = "codex-agent" }
 *
 * Codex also sends a custom "sandbox_state" RPC notification after
 * init with sandbox policy info (read-only/writable paths).
 */
export class CodexAdapter implements EngramAdapter {
  readonly id = "codex";

  matches(context: AdapterContext): boolean {
    // Primary: MCP clientInfo from initialize handshake (exact match)
    if (context.clientInfo?.name === "codex-mcp-client") return true;

    // Also match on clientInfo name containing "codex" for forward compat
    const clientName = context.clientInfo?.name?.toLowerCase() ?? "";
    if (clientName.includes("codex") && clientName !== "codex-mcp-client") return true;

    // Fallback: user-configured client identifier header
    const clientId = headerValue(context.headers, "x-engram-client-id");
    if (clientId?.toLowerCase() === "codex") return true;

    return false;
  }

  resolveIdentity(context: AdapterContext): ResolvedIdentity {
    // MCP session ID (standard MCP header, server-assigned)
    const mcpSessionId = headerValue(context.headers, "mcp-session-id");

    // Principal: explicit header > default
    const principal = headerValue(context.headers, "x-engram-principal")
      || "codex";

    // Namespace: explicit header > default
    const namespace = headerValue(context.headers, "x-engram-namespace")
      || "codex";

    return {
      namespace,
      principal,
      sessionKey: mcpSessionId ?? context.sessionKey,
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
