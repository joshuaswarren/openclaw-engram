# openclaw-engram

**Long-term memory for AI agents.** Engram gives your [OpenClaw](https://github.com/openclaw/openclaw) agents persistent, searchable memory that survives across conversations. Every interaction builds a richer understanding of your world — decisions, preferences, facts, relationships, and more — so your agents remember what matters.

[![npm version](https://img.shields.io/npm/v/@joshuaswarren/openclaw-engram)](https://www.npmjs.com/package/@joshuaswarren/openclaw-engram)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why Engram?

AI agents forget everything between conversations. Engram fixes that.

- **Automatic extraction** — Engram watches conversations and extracts facts, decisions, preferences, corrections, and more. No manual tagging required.
- **Smart recall** — Before each conversation, Engram injects the most relevant memories into the agent's context. Your agents remember what they need, when they need it.
- **Local-first** — All memory data stays on your filesystem as plain markdown files. No cloud dependency, no vendor lock-in, fully portable.
- **Pluggable search** — Choose from six search backends: QMD (hybrid BM25+vector+reranking), LanceDB, Meilisearch, Orama, remote HTTP, or bring your own.
- **Zero-config start** — Install, add an API key, restart. Engram works out of the box with sensible defaults and progressively unlocks advanced features as you enable them.

## Quick Start

```bash
openclaw plugins install @joshuaswarren/openclaw-engram --pin
```

Add to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-engram"],
    "slots": { "memory": "openclaw-engram" },
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

Restart the gateway:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

That's it. Start a conversation — Engram begins learning immediately.

## Verify Installation

```bash
openclaw engram compat --strict   # Should exit 0
openclaw engram stats             # Shows memory counts and search status
```

## How It Works

Engram operates in three phases, running automatically in the background:

```
 Recall    Before each conversation, inject relevant memories
 Buffer    After each turn, accumulate content until a trigger fires
 Extract   Periodically, use an LLM to extract structured memories
```

Memories are stored as markdown files with YAML frontmatter:

```yaml
---
id: decision-1738789200000-a1b2
category: decision
confidence: 0.92
tags: ["architecture", "search"]
---
Decided to use the port/adapter pattern for search backends
so alternative engines can replace QMD without changing core logic.
```

Categories include: `fact`, `decision`, `preference`, `correction`, `relationship`, `principle`, `commitment`, `moment`, `skill`, and more.

## Search Backends

Engram v9 introduces a pluggable search architecture. Set `searchBackend` in your config to switch engines:

| Backend | Type | Best For | Config |
|---------|------|----------|--------|
| **QMD** (default) | Hybrid BM25+vector+reranking | Best recall quality, production use | `"qmd"` |
| **Orama** | Embedded, pure JS | Zero native deps, quick setup | `"orama"` |
| **LanceDB** | Embedded, native Arrow | Large collections, fast vector search | `"lancedb"` |
| **Meilisearch** | Server-based | Shared search across services | `"meilisearch"` |
| **Remote** | HTTP REST | Custom search service integration | `"remote"` |
| **Noop** | No-op | Disable search (extraction only) | `"noop"` |

Example — switch to Orama (zero setup, no external dependencies):

```jsonc
{
  "searchBackend": "orama"
}
```

See the [Search Backends Guide](docs/search-backends.md) for detailed configuration and tradeoffs.

Want to build your own? See [Writing a Search Backend](docs/writing-a-search-backend.md).

## Feature Highlights

Engram's capabilities are organized into feature families that you can enable progressively:

| Feature | What It Does |
|---------|-------------|
| **Recall Planner** | Lightweight gating that decides whether to retrieve memories or skip recall |
| **Memory Boxes** | Groups related memories into topic-windowed episodes with trace linking |
| **Episode/Note Model** | Classifies memories as time-specific events or stable beliefs |
| **Graph Recall** | Entity-relationship graph for causal and timeline queries |
| **Lifecycle Policy** | Automatic memory aging: active, validated, stale, archived |
| **Identity Continuity** | Maintains consistent agent personality across sessions |
| **Shared Context** | Cross-agent memory sharing for multi-agent setups |
| **Compounding** | Weekly synthesis that surfaces patterns and recurring mistakes |
| **Hot/Cold Tiering** | Automatic migration of aging memories to cold storage |
| **Behavior Loop Tuning** | Runtime self-tuning of extraction and recall parameters |

Start with defaults, then enable features as needed. See [Enable All Features](docs/enable-all-v8.md) for a full-feature config profile.

## Agent & Operator Commands

```bash
openclaw engram stats                        # Memory counts, search status, health
openclaw engram search "your query"          # Search memories from CLI
openclaw engram compat --strict              # Compatibility check
openclaw engram conversation-index-health    # Conversation index status
openclaw engram graph-health                 # Entity graph status
openclaw engram tier-status                  # Hot/cold tier metrics
openclaw engram policy-status                # Lifecycle policy snapshot
```

## Configuration

All settings live in `openclaw.json` under `plugins.entries.openclaw-engram.config`. Only `openaiApiKey` is required — everything else has sensible defaults.

Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `openaiApiKey` | `(env fallback)` | OpenAI API key or `${ENV_VAR}` reference |
| `model` | `gpt-5.2` | LLM model for extraction |
| `searchBackend` | `"qmd"` | Search engine: `qmd`, `orama`, `lancedb`, `meilisearch`, `remote`, `noop` |
| `qmdEnabled` | `true` | Enable QMD hybrid search |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | Memory storage root |

Full reference: [Config Reference](docs/config-reference.md)

## Documentation

- [Getting Started](docs/getting-started.md) — Installation, setup, first-run verification
- [Search Backends](docs/search-backends.md) — Choosing and configuring search engines
- [Writing a Search Backend](docs/writing-a-search-backend.md) — Build your own adapter
- [Config Reference](docs/config-reference.md) — Every setting with defaults
- [Architecture Overview](docs/architecture/overview.md) — System design and storage layout
- [Retrieval Pipeline](docs/architecture/retrieval-pipeline.md) — How recall works
- [Memory Lifecycle](docs/architecture/memory-lifecycle.md) — Write, consolidation, expiry
- [Enable All Features](docs/enable-all-v8.md) — Full-feature config profile
- [Operations](docs/operations.md) — Backup, export, maintenance
- [Namespaces](docs/namespaces.md) — Multi-agent memory isolation
- [Shared Context](docs/shared-context.md) — Cross-agent intelligence
- [Identity Continuity](docs/identity-continuity.md) — Consistent agent personality

## Developer Install

```bash
git clone https://github.com/joshuaswarren/openclaw-engram.git \
  ~/.openclaw/extensions/openclaw-engram
cd ~/.openclaw/extensions/openclaw-engram
npm ci && npm run build
```

Run tests:

```bash
npm test              # Full suite (672 tests)
npm run check-types   # TypeScript type checking
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests for new functionality
4. Ensure `npm test` and `npm run check-types` pass
5. Submit a pull request

## License

[MIT](LICENSE)
