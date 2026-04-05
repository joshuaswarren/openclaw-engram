# Authentication Model

## Per-Plugin Tokens

Each plugin/connector gets its own auth token. Tokens are stored at `~/.engram/tokens.json`:

```json
{
  "openclaw": "engram_oc_a1b2c3d4e5f6...",
  "claude-code": "engram_cc_f6e5d4c3b2a1...",
  "codex": "engram_cx_1a2b3c4d5e6f...",
  "hermes": "engram_hm_6f5e4d3c2b1a...",
  "replit": "engram_rl_b1c2d3e4f5a6..."
}
```

### Token Format

```
engram_<prefix>_<32-char-random-hex>
```

| Prefix | Platform |
|--------|----------|
| `oc` | OpenClaw |
| `cc` | Claude Code |
| `cx` | Codex CLI |
| `hm` | Hermes Agent |
| `rl` | Replit Agent |
| `uk` | Unknown / generic |

### Token Lifecycle

```bash
engram token generate claude-code   # creates and stores token
engram token list                   # shows all tokens (masked)
engram token revoke claude-code     # removes token
```

Tokens are generated automatically during `engram connectors install <platform>`.

## How Tokens Are Used

### HTTP Requests

```
Authorization: Bearer engram_cc_f6e5d4c3b2a1...
```

### MCP Connections

Tokens are configured in each platform's MCP settings (`.mcp.json`, `config.toml`, etc.) and sent as the `Authorization` header on the HTTP transport.

### OpenClaw Embedded Mode

In embedded mode, OEO talks to the Orchestrator in-process — no HTTP, no token needed for the OEO→EMO path. External agents connecting to `:4318` still need tokens.

## Token Validation

EMO validates tokens using `crypto.timingSafeEqual` to prevent timing attacks. Invalid tokens return `401 Unauthorized`.

## Audit Trail

Each memory operation is attributed to the token's platform:

```yaml
---
id: mem_abc123
source: extraction
extractedBy: claude-code    # ← from token prefix
created: 2026-04-05T10:30:00Z
---
```

This enables:
- Per-platform memory statistics
- Debugging which agent stored incorrect information
- Future per-platform permissions (read-only vs read-write)

## Future: Multi-User Support

The token model is designed to extend to multi-user scenarios:

```json
{
  "tokens": {
    "engram_cc_...": { "user": "joshua", "platform": "claude-code", "scopes": ["read", "write"] },
    "engram_cx_...": { "user": "joshua", "platform": "codex", "scopes": ["read", "write"] },
    "engram_cc_...": { "user": "teammate", "platform": "claude-code", "scopes": ["read"] }
  }
}
```

Each user's memories would be stored in separate directories, with optional cross-user sharing for team knowledge.

## Security Considerations

- Tokens are stored in `~/.engram/tokens.json` with `0600` permissions (owner-only read/write)
- Tokens are never logged in full — only the prefix is shown in logs
- The file is not committed to git (`.gitignore`)
- EMO binds to `127.0.0.1` by default (localhost only) — external access requires explicit configuration
