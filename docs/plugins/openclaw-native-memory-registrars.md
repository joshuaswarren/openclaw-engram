# OpenClaw Native Memory Registrar Spike

Checked on 2026-05-04 against:

- `openclaw/openclaw` `358cd87ff300fd515bf35f9725dd59198fb9c416`
- `openclaw/kitchen-sink` `f57a0fc7c430c928bbe8049e5d69e6c7b806ed12`

The OpenClaw kitchen-sink plugin exercises three native memory-related
registrars that are adjacent to Remnic:

- `registerMemoryEmbeddingProvider()`
- `registerMemoryCorpusSupplement()`
- `registerCompactionProvider()`

## Decision

Keep Remnic on `registerMemoryCapability()` as the primary OpenClaw integration
point for now. Do not register OpenClaw embedding, corpus supplement, or
compaction providers until a product need requires one of those host-native
surfaces directly.

## Surface Map

| OpenClaw surface | Current upstream contract | Remnic mapping | Decision |
|---|---|---|---|
| `registerMemoryEmbeddingProvider()` | Registers an embedding-provider adapter with `create()`, `embedQuery()`, `embedBatch()`, optional multimodal support, and runtime batch metadata. | Remnic already owns embedding and index lifecycle inside `@remnic/core` and its QMD/runtime manager. Registering here would make OpenClaw call Remnic as an embedding backend for OpenClaw-owned memory, which is the wrong ownership direction. | Not a fit yet. Keep embeddings behind Remnic's runtime manager. |
| `registerMemoryCorpusSupplement()` | Registers an additive corpus supplement with `search({ query, maxResults, agentSessionKey })` and `get({ lookup, fromLine, lineCount, agentSessionKey })`. Supplements live alongside, not instead of, the active memory capability. | Remnic can already expose search/read through `registerMemoryCapability({ runtime })`, `memory_search`, `memory_get`, and public artifacts. As a supplement, Remnic could duplicate results when it owns the memory slot and would need explicit passive-mode ranking/citation semantics when another plugin owns the slot. | Defer. Revisit only for a read-only passive bridge alongside another memory-slot owner. |
| `registerCompactionProvider()` | Registers a provider with `summarize({ messages, signal, compressionRatio, customInstructions, summarizationInstructions, previousSummary })` that can replace OpenClaw's built-in transcript compaction summarizer. | Remnic observes compaction/reset boundaries, saves checkpoints, and flushes memory around lifecycle events. It does not own the user-facing transcript summary OpenClaw needs for context management. | Not applicable. Keep compaction hooks and checkpointing, not summary replacement. |

## Why `registerMemoryCapability()` Still Fits

`registerMemoryCapability()` matches Remnic's shape as a complete memory adapter:
prompt building, runtime search/read, backend status, flush planning, and public
artifacts can live under one exclusive memory-slot capability. That keeps
OpenClaw-specific code thin while preserving Remnic core ownership of storage,
retrieval, extraction, consolidation, and QMD behavior.

Future work can revisit `registerMemoryCorpusSupplement()` if Remnic needs an
explicit passive-mode, read-only bridge. That should be implemented as a
separate PR with ranking, citation, and duplicate-result expectations documented
before code changes.
