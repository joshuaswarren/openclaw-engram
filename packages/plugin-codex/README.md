# @remnic/plugin-codex

Native [OpenAI Codex CLI](https://github.com/openai/codex) plugin for [Remnic](https://github.com/joshuaswarren/remnic) memory. Wires Codex's session hooks, MCP server, skills, and memory-extension into a running Remnic daemon so every Codex session gets persistent long-term memory automatically.

## Install

Installation is a two-step flow — `remnic connectors install codex-cli` sets up the MCP connection and the phase-2 consolidation extension, and Codex's own plugin system is what loads the hook/skill tree.

1. **Wire up the MCP connection, token, and consolidation extension:**

    ```bash
    remnic connectors install codex-cli
    ```

    This writes `~/.codex/config.toml` entries for the Remnic MCP server, mints a bearer token, and calls `@remnic/core`'s `installCodexMemoryExtension`, which materializes `~/.codex/memories_extensions/remnic/instructions.md` — the phase-2 local-filesystem consolidation guide (see the file-table row below). It does NOT copy `.codex-plugin/`, `hooks/`, or `skills/` — those live in this package and are loaded through Codex's plugin discovery path, not through `remnic connectors`.

2. **Load the plugin tree in Codex.** Install the package and point Codex's plugin loader at it:

    ```bash
    npm install -g @remnic/plugin-codex
    ```

    Consult Codex's plugin docs for the exact mechanism (symlink into `~/.codex/plugins/`, marketplace install, etc.) — until this step runs, the session hooks and skills aren't active and you won't get auto-recall / auto-observe.

## What ships

The package is **data + one small runtime materializer** (no runtime JS beyond the memory-materializer helper; the actual plugin install is driven by `@remnic/core`):

| File / dir | Purpose |
|---|---|
| `.codex-plugin/plugin.json` | Plugin manifest |
| `hooks/hooks.json` + `hooks/bin/*.sh` | Codex session-lifecycle hooks (recall, observe, session-end) |
| `skills/` | `remnic-recall`, `remnic-remember`, `remnic-search`, `remnic-status`, `remnic-entities`, `remnic-memory-workflow` — invocable from Codex chats |
| `memories_extensions/remnic/` | Codex phase-2 consolidation instructions — tells the Codex compactor sub-agent to treat Remnic's on-disk Markdown as an authoritative local memory source when it builds `MEMORY.md`. Local-only (no MCP, no network); runtime recall/observe still flow through the hooks above. |
| `.mcp.json` | MCP server config pointing Codex at `http://localhost:4318/mcp` |
| `bin/materialize.cjs` | Runtime entrypoint invoked exclusively by the Codex `Stop` hook (`hooks/bin/session-end.sh`) to refresh `~/.codex/memories` from the Remnic store at the end of a session. Not an installer, and not wired into any `remnic` CLI command. |

## What you get at runtime

Once installed and a Remnic daemon is running (`remnic daemon start`):

- **Auto-recall** on `SessionStart` and on every `UserPromptSubmit` — relevant memories are injected before Codex's first turn and before each subsequent user turn.
- **Auto-observe** on `PostToolUse` for the `Bash` tool and on `Stop` (session end) — new facts, decisions, and entities touched by shell work (or accumulated through the session) are buffered for extraction automatically.
- **Memory skills** — invoke `/remnic-recall`, `/remnic-search`, `/remnic-remember`, `/remnic-entities`, `/remnic-status` directly in Codex chats.
- **Cross-agent sharing** — the same memory store is shared with every other Remnic-connected agent (Claude Code, OpenClaw, Replit, Hermes, etc.), so what one agent learns is available to all.

## MCP setup

The plugin expects a Remnic daemon reachable at `http://localhost:4318/mcp` with a bearer token. `remnic connectors install codex-cli` handles this automatically. The template is:

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

Replace `{{REMNIC_TOKEN}}` with a token minted via `remnic token generate <connector-id>`.

## Agent note

If you're an AI agent scaffolding a Codex integration: **do not** hand-edit `~/.codex/` directly. The full setup has two components:

1. `remnic connectors install codex-cli` (drives `@remnic/core`'s `installCodexMemoryExtension`) handles the MCP config, token rotation, and writes `memories_extensions/remnic/instructions.md`. It does NOT deploy `.codex-plugin/`, `hooks/`, or `skills/`.
2. Load this package into Codex via Codex's own plugin loader to activate the hooks and skills.

`bin/materialize.cjs` is a runtime helper called only by the Codex `Stop` hook to refresh `~/.codex/memories` from the live Remnic store at session end; it's not an installer and not wired into any `remnic` CLI command, so re-running it manually won't recover a broken plugin install.

## Related

- [`@remnic/cli`](https://www.npmjs.com/package/@remnic/cli) — daemon lifecycle + installer
- [`@remnic/plugin-claude-code`](https://www.npmjs.com/package/@remnic/plugin-claude-code) — same idea, for Anthropic Claude Code
- [`@remnic/plugin-openclaw`](https://www.npmjs.com/package/@remnic/plugin-openclaw) — OpenClaw memory-slot plugin
- Connector guide: [docs/integration/connector-setup.md](https://github.com/joshuaswarren/remnic/blob/main/docs/integration/connector-setup.md) in the repo
- Source + issues: <https://github.com/joshuaswarren/remnic>

## License

MIT. See the root [LICENSE](https://github.com/joshuaswarren/remnic/blob/main/LICENSE) file.
