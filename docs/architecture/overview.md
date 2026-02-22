# Architecture Overview

## System Design

Engram is a **local-first, plugin-based memory system** that runs inside the OpenClaw gateway. All data stays on disk as plain markdown files. Outbound API calls occur for: (1) LLM extraction/consolidation, (2) embedding fallback recall when QMD is unavailable and an OpenAI key is present, and (3) hourly summaries when enabled (`hourlySummariesEnabled`, default on).

### Three-Phase Flow

```
Before agent session:  Recall   → inject relevant memories into system prompt
After each turn:       Buffer   → accumulate turns until trigger fires
Periodically:          Extract  → LLM call to extract + store new memories
```

### Components

| Component | File | Role |
|-----------|------|------|
| Orchestrator | `src/orchestrator.ts` | Coordinates all phases; main entry point |
| Storage | `src/storage.ts` | Read/write markdown files with YAML frontmatter |
| Buffer | `src/buffer.ts` | Smart turn accumulation with signal-based triggers |
| Extraction | `src/extraction.ts` | LLM-powered extraction engine (OpenAI Responses API) |
| QMD client | `src/qmd.ts` | Hybrid search client (BM25 + vector + reranking) |
| Importance | `src/importance.ts` | Zero-LLM local heuristic importance scoring |
| Chunking | `src/chunking.ts` | Sentence-boundary splitting for long memories |
| Threading | `src/threading.ts` | Conversation thread detection |
| Topics | `src/topics.ts` | TF-IDF topic extraction |
| HiMem | `src/himem.ts` | Episode/Note classification (v8.0) |
| Boxes | `src/boxes.ts` | Memory Box builder and Trace Weaver (v8.0) |
| Tools | `src/tools.ts` | Agent-callable memory tools |
| CLI | `src/cli.ts` | Command-line interface |

## Storage Layout

```
~/.openclaw/workspace/memory/local/
├── profile.md                  # Living behavioral profile (auto-updated)
├── entities/                   # One file per tracked entity
│   ├── person-jane-doe.md
│   ├── project-my-app.md
│   └── tool-qmd.md
├── facts/                      # Memory entries, organized by date
│   └── YYYY-MM-DD/
│       ├── fact-1738789200000-a1b2.md
│       └── preference-1738789200000-c3d4.md
├── corrections/                # High-weight correction memories
├── artifacts/                  # Verbatim artifact anchors (v8.0)
│   └── YYYY-MM-DD/
├── boxes/                      # Memory boxes (v8.0)
│   └── YYYY-MM-DD/
│       └── box-<id>.md
├── archive/                    # Archived low-value facts (v6.0)
│   └── YYYY-MM-DD/
├── questions/                  # Generated curiosity questions
├── threads/                    # Conversation threads (v1.2)
├── summaries/                  # Memory summaries (v1.2)
├── compounding/                # Weekly synthesis (v5.0)
│   ├── weekly/
│   └── mistakes.json
├── config/
│   └── aliases.json            # Entity name aliases
└── state/
    ├── buffer.json             # Unbatched turns (survives restarts)
    ├── meta.json               # Extraction count, timestamps, totals
    ├── topics.json             # Extracted topics (v1.2)
    ├── fact-hashes.txt         # Content-hash dedup index (v6.0)
    └── traces.json             # Trace Weaver index (v8.0)
```

## Memory File Format

Each memory file uses YAML frontmatter followed by the memory content:

```yaml
---
id: fact-1738789200000-a1b2
category: fact
memoryKind: note
created: 2026-02-05T12:00:00.000Z
updated: 2026-02-05T12:00:00.000Z
source: extraction
confidence: 0.85
confidenceTier: implied
importanceScore: 0.6
importanceLevel: normal
importanceReasons: ["entity reference", "tool usage"]
importanceKeywords: ["qmd", "search", "hybrid"]
tags: ["tools", "preferences"]
entityRef: tool-qmd
---

QMD supports hybrid search combining BM25 and vector embeddings with reranking.
```

### frontmatter Fields

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (category-timestamp-hash) |
| `category` | Memory type: `fact`, `preference`, `correction`, `entity`, `decision`, `relationship`, `principle`, `commitment`, `moment`, `skill` |
| `memoryKind` | `episode` or `note` (v8.0 HiMem; only when `episodeNoteModeEnabled`) |
| `confidence` | 0.0–1.0 from extraction |
| `confidenceTier` | `explicit`, `implied`, `inferred`, `speculative` |
| `importanceScore` | 0.0–1.0 from local heuristic scorer |
| `importanceLevel` | `critical`, `high`, `normal`, `low`, `trivial` |
| `importanceReasons` | Array of reason strings explaining the score |
| `importanceKeywords` | Array of salient keywords extracted for search |
| `status` | `active`, `superseded`, `archived` |
| `tags` | Semantic tags from extraction |
| `entityRef` | Link to entity file (if applicable) |
| `parentId` | Source memory ID (for chunks and consolidation lineage) |
| `intentGoal` | Intent goal string (v8.0 intent routing) |
| `intentActionType` | Intent action type (v8.0 intent routing) |
| `intentEntityTypes` | Intent entity types array (v8.0 intent routing) |

## v8.0 Memory OS Additions

### Memory Boxes (Membox)

Topic-windowed grouping of related memories into sealed episode boxes:
- Open box accumulates memories on a topic window
- Seals on topic shift, time gap, or memory count threshold
- Trace Weaver links recurring-topic boxes into named traces
- Storage: `memory/boxes/YYYY-MM-DD/box-<id>.md`

### Episode/Note Dual Store (HiMem)

Every extracted memory is classified as:
- `episode` — time-specific event (preserves raw event fidelity)
- `note` — stable belief, preference, decision, or constraint (candidate for reconsolidation)

Classification logic (in priority order): temporal date/time markers → extraction category → tag signals → content keywords → default `episode`.

### Verbatim Artifacts (CogCanvas)

High-confidence memories in decision/correction/principle/commitment categories are stored as verbatim quote-first anchors. Artifacts are injected first in the recall context, before regular memories.

## Integration Points

```typescript
api.registerService({ start })  // Initialize orchestrator and storage (service lifecycle)
api.on("before_agent_start")    // Inject memory context into system prompt
api.on("agent_end")             // Buffer the completed turn
api.registerTool()              // memory_search, memory_store, etc.
api.registerCommand()           // CLI: openclaw engram <command>
```

## See Also

- [Retrieval Pipeline](retrieval-pipeline.md) — how recall works in detail
- [Memory Lifecycle](memory-lifecycle.md) — write, consolidation, expiry
- [Config Reference](../config-reference.md) — all configuration flags
