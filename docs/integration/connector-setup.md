# Connector Setup Guide

Connect Engram memory to your coding tools. All connectors use the same Engram HTTP/MCP server — you just need to point your tool at it.

## Prerequisites

Start the Engram server (one of these):

```bash
# Option A: OpenClaw plugin mode (if already using OpenClaw)
openclaw engram access http-serve --port 4318 --token "$ENGRAM_AUTH_TOKEN"

# Option B: Standalone daemon
engram daemon start
```

Verify it's running:

```bash
curl -H "Authorization: Bearer $ENGRAM_AUTH_TOKEN" http://localhost:4318/engram/v1/health
```

---

## Claude Code

Add to `~/.claude.json` (or project `.claude.json`):

```jsonc
{
  "mcpServers": {
    "engram": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${ENGRAM_AUTH_TOKEN}"
      }
    }
  }
}
```

Restart Claude Code. Verify with: `What MCP tools do you have?`

**Capabilities:** observe, recall, store, search, entities, real-time sync

---

## Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.engram]
url = "http://127.0.0.1:4318/mcp"
bearer_token_env_var = "ENGRAM_AUTH_TOKEN"
```

See the [full Codex CLI guide](../guides/codex-cli.md) for session-start hooks and automatic recall.

**Capabilities:** observe, recall, store, batch

---

## Cursor

Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` globally):

```jsonc
{
  "mcpServers": {
    "engram": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${ENGRAM_AUTH_TOKEN}"
      }
    }
  }
}
```

Restart Cursor. Open the MCP panel to verify the connection.

**Capabilities:** recall, search

---

## GitHub Copilot

GitHub Copilot supports MCP servers in VS Code. Add to your VS Code `settings.json`:

```jsonc
{
  "github.copilot.chat.experimental.mcpServers": {
    "engram": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${ENGRAM_AUTH_TOKEN}"
      }
    }
  }
}
```

**Capabilities:** recall, search

---

## Cline

Add to your Cline MCP settings (VS Code Settings > Cline > MCP Servers):

```jsonc
{
  "engram": {
    "url": "http://localhost:4318/mcp",
    "headers": {
      "Authorization": "Bearer ${ENGRAM_AUTH_TOKEN}"
    }
  }
}
```

**Capabilities:** observe, recall, store, batch

---

## Roo Code

Add to your Roo Code MCP settings:

```jsonc
{
  "mcpServers": {
    "engram": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${ENGRAM_AUTH_TOKEN}"
      }
    }
  }
}
```

**Capabilities:** observe, recall, store, batch

---

## Windsurf

Add to your Windsurf MCP settings (Settings > MCP):

```jsonc
{
  "mcpServers": {
    "engram": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${ENGRAM_AUTH_TOKEN}"
      }
    }
  }
}
```

**Capabilities:** observe, recall, store, search

---

## Amp

Add to your Amp configuration:

```jsonc
{
  "mcpServers": {
    "engram": {
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer ${ENGRAM_AUTH_TOKEN}"
      }
    }
  }
}
```

**Capabilities:** observe, recall, store, search

---

## Replit Agent

Replit uses HTTP API instead of MCP. Configure via environment variables in your Replit project:

```bash
ENGRAM_API_URL=http://your-server:4318/engram/v1
ENGRAM_AUTH_TOKEN=your-token-here
```

Then use the HTTP API directly in your agent code:

```typescript
// Recall memories
const response = await fetch(`${ENGRAM_API_URL}/recall`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${ENGRAM_AUTH_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: "what do I know about this project?" }),
});

// Store a memory
await fetch(`${ENGRAM_API_URL}/memories`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${ENGRAM_AUTH_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    content: "The API uses REST with bearer auth",
    category: "fact",
  }),
});
```

**Capabilities:** observe, recall, store (via HTTP)

---

## Generic MCP Client

Any tool that supports the [Model Context Protocol](https://modelcontextprotocol.io/) can connect to Engram. Point your client at:

- **MCP endpoint:** `http://localhost:4318/mcp`
- **Auth:** `Authorization: Bearer <token>` header
- **Transport:** HTTP (SSE for streaming)

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `engram.recall` | Query memories with semantic search |
| `engram.recall_explain` | Return the last recall snapshot for a session |
| `engram.observe` | Store conversation context |
| `engram.memory_store` | Store a memory directly |
| `engram.memory_get` | Get a specific memory by ID |
| `engram.memory_timeline` | Browse memory timeline |
| `engram.entity_get` | Get details for a specific entity |
| `engram.lcm_search` | Search using Lossless Context Management |
| `engram.suggestion_submit` | Submit a memory suggestion for review |
| `engram.review_queue_list` | List items in the review queue |
| `engram.day_summary` | Generate end-of-day summary |
| `engram.memory_governance_run` | Run memory governance pass |
| `engram.continuity_audit_generate` | Generate identity continuity audit report |
| `engram.continuity_incident_open` | Open a continuity incident record |
| `engram.continuity_incident_close` | Close an open continuity incident |
| `engram.continuity_incident_list` | List continuity incidents by state |
| `engram.continuity_loop_add_or_update` | Add/update a continuity improvement loop |
| `engram.continuity_loop_review` | Review a continuity improvement loop |
| `engram.identity_anchor_get` | Read identity continuity anchor document |
| `engram.identity_anchor_update` | Update identity anchor sections |
| `engram.memory_identity` | Read agent identity reflections |
| `engram.memory_search` | Direct semantic search over memory files |
| `engram.memory_profile` | Read user behavioral profile |
| `engram.memory_entities_list` | List all tracked entities |
| `engram.memory_questions` | List open questions from conversations |
| `engram.memory_last_recall` | Debug: last recall snapshot |
| `engram.memory_intent_debug` | Debug: intent classification |
| `engram.memory_qmd_debug` | Debug: QMD search index |
| `engram.memory_graph_explain` | Debug: entity graph recall explanation |
| `engram.memory_feedback` | Record relevance feedback for a memory |
| `engram.memory_promote` | Promote a memory's lifecycle state |
| `engram.context_checkpoint` | Save session context checkpoint to disk |

---

## Managing Connectors

Use the `engram connectors` CLI to manage connector installations:

```bash
# List all available connectors
engram connectors list

# Install a connector (creates config file)
engram connectors install claude-code

# Check connector health
engram connectors doctor claude-code

# Remove a connector
engram connectors remove claude-code
```

---

## Troubleshooting

### Connection refused

The Engram server isn't running. Start it:

```bash
engram daemon start    # standalone
# or
openclaw engram access http-serve --port 4318 --token "$ENGRAM_AUTH_TOKEN"  # OpenClaw
```

### 401 Unauthorized

Token mismatch. Verify `ENGRAM_AUTH_TOKEN` matches between server and client config.

### MCP tools not showing up

1. Restart your tool after config changes
2. Check the MCP endpoint responds: `curl -H "Authorization: Bearer $ENGRAM_AUTH_TOKEN" -X POST http://localhost:4318/mcp -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'`
3. Some tools require explicit MCP enable in settings

### Slow recall

If queries are slow, enable QMD for hybrid search:

```bash
engram doctor    # checks search backend status
```

See [Getting Started](../getting-started.md) for QMD setup.
