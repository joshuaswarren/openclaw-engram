# openclaw-engram

A local-first memory plugin for [OpenClaw](https://github.com/openclaw/openclaw) that gives AI agents persistent, searchable long-term memory across conversations.

Engram uses **LLM-powered extraction** (OpenAI Responses API) to intelligently identify what's worth remembering from each conversation, stores memories as plain **markdown files** on disk, and retrieves relevant context via **[QMD](https://github.com/tobi/qmd)** hybrid search (BM25 + vector + reranking).

## Why Engram?

Most AI memory systems are either too noisy (store everything) or too lossy (store nothing useful). Engram takes a different approach:

- **Signal detection first** -- A fast local regex scan classifies each turn before any API call happens. High-signal turns (corrections, preferences, identity statements) trigger immediate extraction; low-signal turns are batched.
- **Structured extraction** -- An LLM analyzes buffered turns and extracts typed memories (facts, preferences, corrections, entities, decisions, relationships, principles, commitments, moments, skills) with confidence scores.
- **Automatic consolidation** -- Periodic consolidation passes merge duplicates, update entity profiles, refresh the behavioral profile, and expire stale memories.
- **Local-first storage** -- All memories are plain markdown files with YAML frontmatter. No database, no vendor lock-in. Grep them, version them, back them up however you like.
- **Privacy by default** -- Memories never leave your machine unless you choose to sync them. The LLM extraction call is the only external API call.

## Features

- **10 memory categories**: fact, preference, correction, entity, decision, relationship, principle, commitment, moment, skill
- **Confidence tiers**: explicit (0.95-1.0), implied (0.70-0.94), inferred (0.40-0.69), speculative (0.00-0.39)
- **TTL on speculative memories**: Auto-expire after 30 days if unconfirmed
- **Lineage tracking**: Memories track their parent IDs through consolidation merges and updates
- **Entity profiles**: Accumulates facts about people, projects, tools, and companies into per-entity files
- **Behavioral profile**: A living `profile.md` that evolves as the system learns about the user
- **Identity reflection**: Optional self-reflection that helps the agent improve over sessions
- **Question generation**: Generates 1-3 curiosity questions per extraction to drive deeper engagement
- **Commitment lifecycle**: Tracks promises and deadlines with configurable decay (default 90 days)
- **Auto-consolidation**: IDENTITY.md reflections are automatically summarized when they exceed 8KB
- **Smart buffer**: Configurable trigger logic (signal-based, turn count, or time-based)
- **QMD integration**: Hybrid search with BM25, vector embeddings, and reranking
- **Graceful degradation**: Works without QMD (falls back to direct file reads) and without an API key (retrieval-only mode)
- **Migration tools**: Import memories from Honcho, Supermemory, and context files
- **CLI**: Search, inspect, and manage memories from the command line
- **Agent tools**: `memory_search`, `memory_store`, `memory_profile`, `memory_entities`

## Architecture

```
Conversation turn arrives
    |
    v
Signal scan (local regex, <10ms, free)
    |
    v
Append to smart buffer
    |
    v
Trigger check:
    HIGH signal? --> Extract NOW (single LLM call)
    Buffer >= N? --> Extract BATCH
    Time > T?   --> Extract BATCH
    else        --> Keep buffering
    |
    v
If extracted: write markdown files to disk
    |
    v
Every Nth extraction: Consolidation pass
    - Merge/dedup memories
    - Update entity profiles
    - Update behavioral profile
    - Clean expired commitments and TTL memories
    - Auto-consolidate identity reflections
    |
    v
Background: qmd update (re-index new files)
```

### Retrieval Flow

```
Agent session starts
    |
    v
Read profile.md directly (free, instant)
    |
    v
QMD search memory collection (relevant memories)
    |
    v
QMD search global collections (workspace context)
    |
    v
Optionally inject highest-priority open question
    |
    v
Combine and inject into system prompt
```

## Storage Layout

All memories are stored as markdown files with YAML frontmatter:

```
~/.openclaw/workspace/memory/local/
├── profile.md                  # Living behavioral profile (auto-updated)
├── entities/                   # One markdown file per tracked entity
│   ├── person-joshua-warren.md
│   ├── project-openclaw.md
│   └── tool-qmd.md
├── facts/                      # Memory entries organized by date
│   └── YYYY-MM-DD/
│       ├── fact-1738789200000-a1b2.md
│       └── preference-1738789200000-c3d4.md
├── corrections/                # High-weight correction memories
│   └── correction-1738789200000-e5f6.md
├── questions/                  # Generated curiosity questions
│   └── q-m1abc-xy.md
└── state/
    ├── buffer.json             # Current unbatched turns (survives restarts)
    └── meta.json               # Extraction count, timestamps, totals
```

### Memory File Format

Each memory file uses YAML frontmatter:

```yaml
---
id: fact-1738789200000-a1b2
category: fact
created: 2026-02-05T12:00:00.000Z
updated: 2026-02-05T12:00:00.000Z
source: extraction
confidence: 0.85
confidenceTier: implied
tags: ["tools", "preferences"]
entityRef: tool-qmd
---

QMD supports hybrid search combining BM25 and vector embeddings with reranking.
```

## Installation

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) gateway
- Node.js 20+
- An OpenAI API key (for extraction; retrieval works without one)
- [QMD](https://github.com/tobi/qmd) (optional, for hybrid search)

### Install

```bash
# Clone into the OpenClaw extensions directory
git clone https://github.com/joshuaswarren/openclaw-engram.git \
  ~/.openclaw/extensions/openclaw-engram

# Install dependencies and build
cd ~/.openclaw/extensions/openclaw-engram
npm install
npm run build
```

### Enable in OpenClaw

Add to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-engram"],
    "slots": {
      "memory": "openclaw-engram"
    },
    "entries": {
      "openclaw-engram": {
        "enabled": true,
        "config": {
          "openaiApiKey": "${OPENAI_API_KEY}"
        }
      }
    }
  }
}
```

### Set Up QMD Collection (Optional)

If you have QMD installed, add a collection pointing at the memory directory. Add to `~/.config/qmd/index.yml`:

```yaml
openclaw-engram:
  path: ~/.openclaw/workspace/memory/local
  extensions: [.md]
```

Then index:

```bash
qmd update && qmd embed
```

### Restart the Gateway

```bash
kill -USR1 $(pgrep openclaw-gateway)
```

Check the logs to confirm:

```bash
tail -f ~/.openclaw/logs/gateway.log
# Should see: [gateway] openclaw-engram: started
```

## Configuration

All settings are defined in `openclaw.json` under `plugins.entries.openclaw-engram.config`:

### Core Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `openaiApiKey` | `(env fallback)` | OpenAI API key or `${ENV_VAR}` reference |
| `model` | `gpt-5.2` | OpenAI model for extraction/consolidation |
| `reasoningEffort` | `low` | Reasoning effort: `none`, `low`, `medium`, `high` |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | Memory storage directory |
| `workspaceDir` | `~/.openclaw/workspace` | Workspace directory (for IDENTITY.md) |
| `debug` | `false` | Enable debug logging |

### Buffer & Trigger Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `triggerMode` | `smart` | `smart`, `every_n`, or `time_based` |
| `bufferMaxTurns` | `5` | Max buffered turns before forced extraction |
| `bufferMaxMinutes` | `15` | Max minutes before forced extraction |
| `highSignalPatterns` | `[]` | Custom regex patterns for immediate extraction |
| `consolidateEveryN` | `3` | Run consolidation every N extractions |

### Retrieval Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `maxMemoryTokens` | `2000` | Max tokens injected into system prompt |
| `qmdEnabled` | `true` | Use QMD for hybrid search |
| `qmdCollection` | `openclaw-engram` | QMD collection name |
| `qmdMaxResults` | `8` | Max QMD results per search |

### V2 Feature Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `identityEnabled` | `true` | Enable agent identity reflections |
| `injectQuestions` | `false` | Inject open questions into the system prompt |
| `commitmentDecayDays` | `90` | Days before fulfilled/expired commitments are removed |

### Trigger Modes

- **`smart`** (default): Extracts immediately on high-signal turns (corrections, preferences, identity statements). Batches low-signal turns until buffer-full or time-elapsed.
- **`every_n`**: Extracts every N turns. Simple and predictable.
- **`time_based`**: Extracts when `bufferMaxMinutes` elapsed since last extraction.

### API Key Configuration

The plugin resolves the OpenAI API key in this order:

1. `config.openaiApiKey` with `${VAR}` syntax -- resolved from environment
2. `config.openaiApiKey` as literal string -- used directly
3. `process.env.OPENAI_API_KEY` -- implicit fallback
4. None -- extraction disabled, retrieval-only mode (plugin still loads and serves memories)

**Gateway note:** The OpenClaw gateway runs as a launchd service with its own environment. If you use `${VAR}` syntax, make sure the variable is in the gateway's launchd plist `EnvironmentVariables`, not just your shell profile.

## Agent Tools

The plugin registers four tools that agents can call during conversations:

| Tool | Description |
|------|-------------|
| `memory_search` | Search memories by query string via QMD hybrid search |
| `memory_store` | Explicitly store a memory with category, confidence, and tags |
| `memory_profile` | View the current behavioral profile |
| `memory_entities` | List all tracked entities or view a specific entity's facts |

## CLI Commands

```bash
openclaw engram stats                 # Memory statistics (counts, last extraction, etc.)
openclaw engram search "query"        # Search memories via QMD
openclaw engram profile               # Display the behavioral profile
openclaw engram entities              # List all tracked entities
openclaw engram entities person-name  # View specific entity details
openclaw engram questions             # List open curiosity questions
```

## Migration

Import memories from existing OpenClaw memory systems:

```bash
cd ~/.openclaw/extensions/openclaw-engram

# Full migration (context files + Supermemory + Honcho)
npx tsx scripts/migrate.ts

# Preview without writing anything
npx tsx scripts/migrate.ts --dry-run

# Migrate specific sources
npx tsx scripts/migrate.ts --source=context        # Context files only
npx tsx scripts/migrate.ts --source=supermemory     # Supermemory daily logs
npx tsx scripts/migrate.ts --source=honcho          # Honcho API conclusions
```

The migration script:
- Deduplicates against existing engram memories
- Categorizes each memory (fact, preference, correction, decision)
- Writes proper frontmatter with source attribution
- Seeds `profile.md` from context files (if it doesn't exist yet)
- Prints a detailed report with counts per source

After migration, re-index QMD:

```bash
qmd update && qmd embed
```

## How It Works

### Extraction

When a trigger fires, the buffered conversation turns are sent to the OpenAI Responses API with a structured output schema (Zod). The LLM returns:

- **Facts**: Typed memories with category, content, confidence score, tags, and optional entity reference
- **Entities**: Named entities with their type and newly learned facts
- **Profile updates**: Standalone behavioral statements about the user
- **Questions**: 1-3 curiosity questions the agent wants answered in future sessions
- **Identity reflection**: A brief self-reflection on the agent's own behavior

### Consolidation

Every N extractions, a consolidation pass:

1. Compares recent memories against older ones
2. For each memory, decides: ADD, MERGE, UPDATE, INVALIDATE, or SKIP
3. MERGE and UPDATE actions track lineage (parent memory IDs)
4. Updates entity profiles and the behavioral profile
5. Cleans expired commitments (fulfilled/expired + past decay period)
6. Removes TTL-expired speculative memories
7. Auto-consolidates IDENTITY.md if it exceeds 8KB

### Confidence Tiers

| Tier | Range | Meaning | TTL |
|------|-------|---------|-----|
| Explicit | 0.95-1.0 | Direct user statement ("I prefer X") | None |
| Implied | 0.70-0.94 | Strong contextual inference | None |
| Inferred | 0.40-0.69 | Pattern recognition from limited evidence | None |
| Speculative | 0.00-0.39 | Tentative hypothesis, needs confirmation | 30 days |

## Development

```bash
# Watch mode (rebuilds on file changes)
npm run dev

# Type checking
npm run check-types

# Build for production
npm run build
```

### Project Structure

```
src/
├── index.ts          # Plugin entry point (hooks, tools, CLI registration)
├── orchestrator.ts   # Central coordinator (extraction, consolidation, retrieval)
├── extraction.ts     # OpenAI Responses API client
├── storage.ts        # File-based storage manager (markdown + YAML frontmatter)
├── buffer.ts         # Smart buffer with configurable trigger logic
├── signal.ts         # Local signal detection (regex, zero cost)
├── schemas.ts        # Zod schemas for structured LLM output
├── types.ts          # TypeScript type definitions
├── config.ts         # Config parser with env var resolution
├── qmd.ts            # QMD CLI client (search, update, collection management)
├── tools.ts          # Agent tool definitions
├── cli.ts            # CLI subcommand definitions
└── logger.ts         # Logging utilities
scripts/
└── migrate.ts        # Migration from Honcho, Supermemory, context files
```

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

**Important:** This is a public repository. Never commit personal data, API keys, memory content, or user-specific configuration. See [CLAUDE.md](CLAUDE.md) for the full privacy policy.

## License

MIT
