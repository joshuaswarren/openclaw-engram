/**
 * Replit connector installer.
 *
 * Since Replit has no plugin system, this generates a token and
 * prints setup instructions for the Integrations pane.
 */

export interface ReplitInstallResult {
  token: string;
  instructions: string;
  mcpConfig: {
    url: string;
    headers: Record<string, string>;
  };
}

export function generateReplitInstructions(token: string, host = "localhost", port = 4318): ReplitInstallResult {
  const url = `http://${host}:${port}/mcp`;

  const instructions = `
Replit Agent MCP Setup
======================

1. In your Replit workspace, open Integrations > Add MCP server
2. Enter URL: ${url}
3. Add headers:
   - Authorization: Bearer ${token}
   - X-Engram-Client-Id: replit
4. Click Test & Save

Note: For cloud Replit, EMO must be publicly reachable (via tunnel, public IP, or reverse proxy).

Limitations:
- Replit has no hook system, so memory recall/observe is manual
- The agent must explicitly call engram tools (recall, observe, store, search)
- All 44 MCP tools are available
`.trim();

  return {
    token,
    instructions,
    mcpConfig: {
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Engram-Client-Id": "replit",
      },
    },
  };
}
