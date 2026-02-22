# openclaw-engram

A local-first memory plugin for [OpenClaw](https://github.com/openclaw/openclaw) that gives AI agents persistent, searchable long-term memory across conversations.

Engram uses **LLM-powered extraction** to identify what's worth remembering, stores memories as plain **markdown files** on disk, and retrieves relevant context via **[QMD](https://github.com/tobi/qmd)** hybrid search (BM25 + vector + reranking).

## Quick Install

```bash
openclaw plugins install @joshuaswarren/openclaw-engram --pin
```

Enable in `openclaw.json`:

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

Reload:

```bash
kill -USR1 $(pgrep openclaw-gateway)
```

→ **[Getting Started](docs/getting-started.md)** for QMD setup, first-time config, and verification.

## How It Works

1. **Signal scan** — Fast local regex classifies each turn (<10 ms, no API call).
2. **Smart buffer** — High-signal turns extract immediately; others batch.
3. **Extraction** — One LLM call produces typed memories with confidence scores.
4. **Storage** — Plain markdown + YAML frontmatter files; no database.
5. **Retrieval** — QMD hybrid search injects relevant context before each agent session.
6. **Consolidation** — Periodic pass merges duplicates, updates entity profiles, expires stale entries.

→ **[Architecture Overview](docs/architecture/overview.md)** for internals.

## Memory Categories

10 typed categories: `fact`, `preference`, `correction`, `entity`, `decision`, `relationship`, `principle`, `commitment`, `moment`, `skill`.

### v8.0 Memory OS (current)

- **Memory Boxes** (`memoryBoxesEnabled`) — Topic-windowed episode boxes with trace linking.
- **Episode/Note dual store** (`episodeNoteModeEnabled`) — Episodes preserve event fidelity; notes reconsolidate stable beliefs.
- **Verbatim Artifacts** (`verbatimArtifactsEnabled`) — High-confidence decisions/constraints stored as trusted retrieval anchors.
- **Recall Planner** (`recallPlannerEnabled`, default `true`) — Lightweight retrieve-vs-think gating.

## Agent Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search over memories |
| `memory_store` | Manually store a memory |
| `memory_profile` | Retrieve the behavioral profile |
| `memory_entities` | List tracked entities |
| `memory_promote` | Promote to shared namespace |
| `memory_feedback` | Record thumbs up/down signal |

## Docs

| Guide | Contents |
|-------|----------|
| [Getting Started](docs/getting-started.md) | Install, QMD setup, first-time config |
| [Config Reference](docs/config-reference.md) | Every setting, default, and description |
| [Operations](docs/operations.md) | Backup, export, hourly summaries, CLI |
| [Architecture: Overview](docs/architecture/overview.md) | System design and data model |
| [Architecture: Retrieval Pipeline](docs/architecture/retrieval-pipeline.md) | How recall works |
| [Architecture: Memory Lifecycle](docs/architecture/memory-lifecycle.md) | Write, consolidation, expiry |
| [Advanced Retrieval](docs/advanced-retrieval.md) | Reranking, query expansion, feedback |
| [Import / Export](docs/import-export.md) | Portable backups and migration |
| [Namespaces](docs/namespaces.md) | Multi-agent memory isolation |
| [Shared Context](docs/shared-context.md) | Cross-agent shared intelligence |
| [Compounding](docs/compounding.md) | Weekly synthesis and mistake learning |
| [Context Retention](docs/context-retention.md) | Transcript indexing and hourly summaries |

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) gateway
- OpenAI API key (extraction only; retrieval works without one)
- [QMD](https://github.com/tobi/qmd) (optional, recommended for hybrid search)
