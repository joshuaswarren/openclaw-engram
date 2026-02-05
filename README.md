# openclaw-engram

Local-first memory plugin for OpenClaw. Uses GPT-5.2 via OpenAI Responses API for intelligent extraction/consolidation and QMD for storage/retrieval.

## Architecture

All memories are stored as markdown files on disk. The system:

1. **Scans** each conversation turn for signals (regex, free, <10ms)
2. **Buffers** turns until a trigger fires (high signal, turn count, or time)
3. **Extracts** facts, preferences, corrections, entities, and decisions via GPT-5.2
4. **Stores** memories as markdown files with YAML frontmatter
5. **Consolidates** periodically to merge duplicates and update the behavioral profile
6. **Retrieves** via QMD semantic search and direct file reads

## Storage Layout

```
~/.openclaw/workspace/memory/local/
├── profile.md            # Living behavioral profile
├── entities/             # One file per entity
├── facts/YYYY-MM-DD/     # Daily memory files
├── corrections/          # High-weight corrections
└── state/                # Buffer and meta state
```

## OpenAI API Key Configuration

The plugin needs an OpenAI API key for memory extraction and consolidation. Without a key, retrieval still works (profile + QMD search) but no new memories are created.

### Option 1: Plugin-specific key (recommended for multi-key setups)

Set a dedicated key in `openclaw.json` using environment variable syntax:

```json
"openclaw-engram": {
  "enabled": true,
  "config": {
    "openaiApiKey": "${OPENCLAW_ENGRAM_OPENAI_KEY}"
  }
}
```

Then set the variable in your environment (`.bashrc`, `.zshrc`, launchd plist, etc.):

```bash
export OPENCLAW_ENGRAM_OPENAI_KEY="sk-proj-your-key-here"
```

This lets you use a separate key from your system-wide `OPENAI_API_KEY`, which is useful for:
- Tracking costs per-plugin
- Using different billing accounts
- Using a restricted-scope key just for engram

### Option 2: Reference the system-wide key

If you're fine using your system-wide key, reference it explicitly:

```json
"openclaw-engram": {
  "enabled": true,
  "config": {
    "openaiApiKey": "${OPENAI_API_KEY}"
  }
}
```

### Option 3: Implicit fallback

If no `openaiApiKey` is set in the plugin config at all, the plugin falls back to `process.env.OPENAI_API_KEY` automatically. This is the simplest setup but gives you no control over which key is used.

### Option 4: Literal key in config

You can put the key directly in the config (not recommended for shared/versioned configs):

```json
"openclaw-engram": {
  "enabled": true,
  "config": {
    "openaiApiKey": "sk-proj-your-key-here"
  }
}
```

### Resolution order

1. `config.openaiApiKey` with `${VAR}` syntax → resolved from environment
2. `config.openaiApiKey` as literal string → used directly
3. `process.env.OPENAI_API_KEY` → implicit fallback
4. None → extraction disabled, retrieval-only mode (plugin still loads)

### Gateway environment

The OpenClaw gateway runs as a launchd service (`ai.openclaw.gateway`) with its own environment variables defined in `~/Library/LaunchAgents/ai.openclaw.gateway.plist`. If you use `${VAR}` syntax, make sure the variable is available in the gateway's environment, not just your interactive shell.

To add a variable to the gateway's environment, add it to the `EnvironmentVariables` dict in the plist and reload:

```bash
launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

## Configuration

Set in `openclaw.json` under `plugins.entries.openclaw-engram.config`:

| Setting | Default | Description |
|---------|---------|-------------|
| `openaiApiKey` | `(env fallback)` | OpenAI API key or `${ENV_VAR}` reference |
| `model` | `gpt-5.2` | OpenAI model for extraction |
| `reasoningEffort` | `low` | `none\|low\|medium\|high` |
| `triggerMode` | `smart` | `smart\|every_n\|time_based` |
| `bufferMaxTurns` | `5` | Max buffered turns before extraction |
| `bufferMaxMinutes` | `15` | Max minutes before extraction |
| `consolidateEveryN` | `3` | Consolidate every N extractions |
| `highSignalPatterns` | `[]` | Custom regex patterns for immediate extraction |
| `maxMemoryTokens` | `2000` | Max tokens injected per turn |
| `qmdEnabled` | `true` | Use QMD for search |
| `qmdCollection` | `openclaw-engram` | QMD collection name |
| `qmdMaxResults` | `8` | Max QMD results per search |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | Memory storage directory |
| `debug` | `false` | Enable debug logging |

### Trigger Modes

- **`smart`** (default): Extracts immediately on high-signal turns (corrections, preferences, identity statements), batches on buffer-full or time elapsed.
- **`every_n`**: Extracts every N turns (set via `bufferMaxTurns`). Simple and predictable.
- **`time_based`**: Extracts when `bufferMaxMinutes` elapsed since last extraction.

## Tools

- `memory_search` — Search memories via QMD
- `memory_store` — Explicitly store a memory
- `memory_profile` — View user profile
- `memory_entities` — List tracked entities

## CLI

```bash
openclaw engram stats      # Show memory statistics
openclaw engram search Q   # Search memories
openclaw engram profile    # Show user profile
openclaw engram entities   # List entities
```

## Migration

Import memories from existing systems:

```bash
cd ~/.openclaw/extensions/openclaw-engram

# Full migration (context files + Supermemory + Honcho)
npx tsx scripts/migrate.ts

# Preview only
npx tsx scripts/migrate.ts --dry-run

# Specific sources
npx tsx scripts/migrate.ts --source=context        # Context files only
npx tsx scripts/migrate.ts --source=supermemory     # Supermemory daily logs
npx tsx scripts/migrate.ts --source=honcho          # Honcho conclusions
```

After migration, re-index QMD:

```bash
qmd update && qmd embed
```
