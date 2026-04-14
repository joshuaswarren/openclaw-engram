# Architecture Overview

## System Design

Remnic is a **local-first, multi-platform memory system** built around a host-agnostic core. `@remnic/core` owns memory semantics, `@remnic/server` exposes the shared HTTP/MCP runtime, and host adapters such as OpenClaw and Hermes translate that shared behavior into each platform's native integration model. All data stays on disk as plain markdown files. Outbound API calls occur for: (1) LLM extraction/consolidation, (2) embedding fallback recall when QMD is unavailable and an OpenAI key is present, and (3) hourly summaries when enabled (`hourlySummariesEnabled`, default on).

OpenClaw is one adapter, not the architectural center. Standalone Remnic and shared-core behavior must remain correct without OpenClaw, Hermes, or any future host process.

### Three-Phase Flow

```
Before agent session:  Recall   → inject relevant memories into system prompt
After each turn:       Buffer   → accumulate turns until trigger fires
Periodically:          Extract  → LLM call to extract + store new memories
```

### Components

| Component | File | Role |
|-----------|------|------|
| Orchestrator | `packages/remnic-core/src/orchestrator.ts` | Coordinates all phases; main core entry point |
| Storage | `packages/remnic-core/src/storage.ts` | Read/write markdown files with YAML frontmatter |
| Buffer | `packages/remnic-core/src/buffer.ts` | Smart turn accumulation with signal-based triggers |
| Extraction | `packages/remnic-core/src/extraction.ts` | LLM-powered extraction engine |
| Search port | `packages/remnic-core/src/search/port.ts` | Pluggable search backend interface |
| Search factory | `packages/remnic-core/src/search/factory.ts` | Config-driven backend selection |
| QMD client | `packages/remnic-core/src/qmd.ts` | Hybrid search client (BM25 + vector + reranking) |
| Tools | `packages/remnic-core/src/tools.ts` | Core memory tools and service helpers |
| Shared server | `packages/remnic-server/src/*` | Host-agnostic HTTP + MCP runtime |
| OpenClaw adapter | `packages/plugin-openclaw/` plus root `src/` wiring | Maps core behavior onto OpenClaw's plugin SDK/runtime |
| Hermes adapter | `packages/plugin-hermes/` | Maps core behavior onto Hermes' MemoryProvider/plugin contracts |

## Storage Layout

OpenClaw-hosted installs commonly use the following memory layout:

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
    ├── entity-synthesis-queue.json # Stale entity syntheses waiting for bounded rebuild
    ├── meta.json               # Extraction count, timestamps, totals
    ├── topics.json             # Extracted topics (v1.2)
    ├── fact-hashes.txt         # Content-hash dedup index (v6.0)
    └── traces.json             # Trace Weaver index (v8.0)
```

Standalone installs use the same logical structure under the configured Remnic memory directory.

## Entity File Format

Entity files use a two-layer layout so recall can inject compact current truth
while preserving append-only evidence:

```md
---
synthesis_updated_at: "2026-04-13T11:04:55.000Z"
synthesis_version: 3
---

# Jane Doe

**Type:** person
**Updated:** 2026-04-13T11:04:55.000Z

## Synthesis

Jane Doe leads roadmap work and now owns release approvals.

## Timeline

- [2026-04-13T09:00:00.000Z] [source=extraction] [session=session-1] Led roadmap work.
- [2026-04-13T11:00:00.000Z] [source=extraction] [session=session-2] Now owns release approvals.
```

Rules:
- `## Synthesis` is mutable current truth and is the default recall surface.
- `## Timeline` is append-only evidence with timestamp and provenance metadata.
- A synthesis is stale when any timeline entry is newer than `synthesis_updated_at`.
- `openclaw engram entities-migrate` rewrites legacy `Summary`/`Facts` files into this format.

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

## v9.0 Search Backend Architecture

Engram v9 introduces a port/adapter pattern for search. All backends implement the `SearchBackend` interface (`src/search/port.ts`), which the orchestrator calls for recall, update, and embedding operations.

```
Orchestrator → SearchBackend (interface)
                 ├── QmdClient        (default, hybrid BM25+vector+reranking)
                 ├── OramaBackend     (embedded, pure JS)
                 ├── LanceDbBackend   (embedded, native Arrow)
                 ├── MeilisearchBackend (server-based SDK)
                 ├── RemoteSearchBackend (HTTP REST)
                 └── NoopSearchBackend   (no-op)
```

The factory (`src/search/factory.ts`) reads `searchBackend` from config and instantiates the correct adapter. Embedded backends (Orama, LanceDB) share two utilities:
- `document-scanner.ts` — scans the memory directory for indexable `.md` files
- `embed-helper.ts` — computes vector embeddings via OpenAI or local LLM

See [Search Backends](../search-backends.md) and [Writing a Search Backend](../writing-a-search-backend.md).

## See Also

- [Retrieval Pipeline](retrieval-pipeline.md) — how recall works in detail
- [Memory Lifecycle](memory-lifecycle.md) — write, consolidation, expiry
- [Search Backends](../search-backends.md) — choosing and configuring search engines
- [Config Reference](../config-reference.md) — all configuration flags
