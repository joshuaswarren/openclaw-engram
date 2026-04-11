# Codex CLI Plugin

Native Remnic plugin for OpenAI Codex CLI. Provides automatic memory recall, observation, and session-end learning capture.

## Installation

```bash
remnic connectors install codex-cli
```

This:
1. Starts the Remnic daemon if not running
2. Generates a dedicated auth token
3. Installs the plugin to `~/.codex/plugins/`
4. Enables hooks (`[features] codex_hooks = true` in `~/.codex/config.toml`)
5. Configures MCP server pointing to Remnic
6. Drops the Codex memory extension at `~/.codex/memories_extensions/remnic/instructions.md`
7. Runs a health check

## What It Does

### Automatic Memory (via hooks)

| Hook | When | What Happens |
|------|------|-------------|
| `SessionStart` | Session begins | Recalls project context + user preferences |
| `UserPromptSubmit` | Every user message | Recalls memories relevant to the prompt |
| `PostToolUse` | After Bash execution | Observes command results and file changes |
| `Stop` | Session ends | Flushes session learnings to EMO |

### Explicit Skills

| Skill | Description |
|-------|-------------|
| `memory-workflow` | Instructions for memory-aware coding workflows |

### MCP Tools

All 44 Remnic MCP tools are available via the `.mcp.json` configuration. The legacy `engram.*` aliases remain available during v1.x.

## Memory Extension

Codex ships a phase-2 memory consolidation sub-agent that looks for
extensions under a folder that is a **sibling** of `<codex_home>/memories/`.
From Codex's `memories` module:

- `MEMORIES_SUBDIR = "memories"`
- `EXTENSIONS_SUBDIR = "memories_extensions"`
- `memory_extensions_root()` is computed via Rust's
  `Path::with_file_name("memories_extensions")`, so the extensions live at
  `<codex_home>/memories_extensions/` — NOT inside `<codex_home>/memories/`.

`remnic connectors install codex-cli` copies the contents of
`packages/plugin-codex/memories_extensions/remnic/` (notably
`instructions.md`) into that sibling location atomically. The write goes
to a temporary folder first and is then renamed into place, so a concurrent
Codex consolidation run never observes a half-written extension.

When Codex phase-2 runs, its sandboxed consolidation sub-agent reads
`instructions.md` via filesystem tools — no MCP, no network, no `remnic`
CLI invocation. The instructions teach the sub-agent how to locate Remnic
memory files on disk (`~/.remnic/memories/<namespace>/…`), how to resolve
the namespace from the session's cwd, when to consult Remnic and when to
skip it, and how to cite Remnic sources with `<oai-mem-citation />` blocks.

### Install location

| Env                       | Location                                          |
|---------------------------|---------------------------------------------------|
| default                   | `~/.codex/memories_extensions/remnic/`            |
| `$CODEX_HOME=/foo`        | `/foo/memories_extensions/remnic/`                |
| `codex.codexHome` config  | `<codexHome>/memories_extensions/remnic/`         |

The extension directory is scoped to `remnic/`. Adjacent extensions under
`memories_extensions/` (from other vendors) are never read, overwritten,
or removed by `remnic connectors install|remove codex-cli`.

### Opting out

Users who self-manage Codex memory extensions can disable this behavior
via the `codex.installExtension` config flag:

```jsonc
{
  "remnic": {
    "codex": {
      "installExtension": false,
      "codexHome": null
    }
  }
}
```

When `installExtension` is `false`, `remnic connectors install codex-cli`
still installs MCP and hooks but does not touch `memories_extensions/`.

## How It Differs from Claude Code Plugin

- **Stop hook:** Codex has a `Stop` event that fires when the agent completes its turn. The plugin uses this to flush any remaining observations and store session learnings — ensuring nothing is lost even if the session ends abruptly.
- **PostToolUse matcher:** Matches `Bash` (Codex's primary tool) instead of `Write|Edit|MultiEdit`.
- **Hooks feature flag:** Codex hooks require `[features] codex_hooks = true` — the installer sets this automatically.
- **Config format:** TOML (`~/.codex/config.toml`) instead of JSON.

## Configuration

Token is read from `~/.remnic/tokens.json`, with `~/.engram/tokens.json` still accepted as a migration fallback. Server defaults to `127.0.0.1:4318`.

## Troubleshooting

Same as Claude Code plugin — see [claude-code.md](./claude-code.md#troubleshooting).

Additional Codex-specific issue:

### Hooks not firing

Verify hooks are enabled:

```bash
grep codex_hooks ~/.codex/config.toml
# Should show: codex_hooks = true
```

## Uninstall

```bash
remnic connectors remove codex-cli
```
