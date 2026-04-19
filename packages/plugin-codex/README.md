# @remnic/plugin-codex

Native [OpenAI Codex CLI](https://github.com/openai/codex) plugin for [Remnic](https://github.com/joshuaswarren/remnic) memory. Wires Codex's session hooks, MCP server, skills, and memory-extension into a running Remnic daemon so every Codex session gets persistent long-term memory automatically.

## Install

```bash
# Recommended: the Remnic CLI installs + configures the plugin for you,
# mints an MCP token, and materializes it into ~/.codex/.
remnic connectors install codex
```

Or install the package and wire Codex to it manually:

```bash
npm install -g @remnic/plugin-codex
```

The package ships a `materialize.cjs` helper that copies the plugin tree into `~/.codex/` on demand (invoked by `remnic connectors install codex`).

## What ships

The package is **data + one small materializer** (no runtime JS beyond the installer):

| File / dir | Purpose |
|---|---|
| `.codex-plugin/plugin.json` | Plugin manifest |
| `hooks/hooks.json` + `hooks/bin/*.sh` | Codex session-lifecycle hooks (recall, observe, session-end) |
| `skills/` | `remnic-recall`, `remnic-remember`, `remnic-search`, `remnic-status`, `remnic-entities`, `remnic-memory-workflow` — invocable from Codex chats |
| `memories_extensions/remnic/` | Codex memory extension that surfaces recall + observe without a separate MCP round trip on hot paths |
| `.mcp.json` | MCP server config pointing Codex at `http://localhost:4318/mcp` |
| `bin/materialize.cjs` | Installer used by `remnic connectors install codex` |

## What you get at runtime

Once installed and a Remnic daemon is running (`remnic daemon start`):

- **Auto-recall** on session start — relevant memories are injected before Codex's first turn.
- **Auto-observe** on tool use and prompt submission — new facts, decisions, and entities are buffered for extraction automatically.
- **Memory skills** — invoke `/remnic-recall`, `/remnic-search`, `/remnic-remember`, `/remnic-entities`, `/remnic-status` directly in Codex chats.
- **Cross-agent sharing** — the same memory store is shared with every other Remnic-connected agent (Claude Code, OpenClaw, Replit, Hermes, etc.), so what one agent learns is available to all.

## MCP setup

The plugin expects a Remnic daemon reachable at `http://localhost:4318/mcp` with a bearer token. `remnic connectors install codex` handles this automatically. The template is:

```json
{
  "mcpServers": {
    "remnic": {
      "type": "http",
      "url": "http://localhost:4318/mcp",
      "headers": {
        "Authorization": "Bearer {{REMNIC_TOKEN}}",
        "X-Engram-Client-Id": "codex"
      }
    }
  }
}
```

Replace `{{REMNIC_TOKEN}}` with a token minted via `remnic token create`.

## Agent note

If you're an AI agent scaffolding a Codex integration: **do not** hand-edit `~/.codex/` directly — run `remnic connectors install codex` (which shells out to `materialize.cjs` in this package) so upgrades stay in sync and the token rotation flow works. The materializer treats `~/.codex/` as its source of truth for the installed copy and cleanly re-applies on reinstall.

## Related

- [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) — daemon lifecycle + installer
- [`@remnic/plugin-claude-code`](https://www.npmjs.com/package/@remnic/plugin-claude-code) — same idea, for Anthropic Claude Code
- [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw) — OpenClaw memory-slot plugin
- Connector guide: [docs/integration/connector-setup.md](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) in the repo
- Source + issues: <https://github.com/joshuaswarren/remnic>

## License

MIT. See the root [LICENSE](https://github.com/joshuaswarren/remnic/blob/main/LICENSE) file.
