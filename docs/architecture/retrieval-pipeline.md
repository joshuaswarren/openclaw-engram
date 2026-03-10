# Retrieval Pipeline

## Overview

Retrieval runs before each agent session (`before_agent_start` hook). It injects relevant memories and profile context into the system prompt.

## Pipeline Stages

```
before_agent_start
       │
       ▼
┌─────────────────────────────────┐
│  1. Recall Planner              │  classify request intent
│     → no_recall / minimal /     │  gate unnecessary recalls
│       full / graph_mode         │
└──────────────┬──────────────────┘
               │ (if recall needed)
               ▼
┌─────────────────────────────────┐
│  2. Profile read                │  profile.md (direct file read, instant)
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│  3. Candidate generation        │
│  a. Artifact anchors (v8.0)     │  high-trust verbatim memories first
│  b. QMD hybrid search           │  BM25 + vector subprocess calls in parallel
│  c. Embedding fallback          │  when QMD unavailable or returns empty results
│  d. Namespace filter (v3.0)     │  filter to allowed namespaces
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│  4. Scoring & filtering         │
│  - Recency boost (default-on)   │
│  - Importance weight            │
│  - Intent compatibility (v8.0)  │
│  - Temporal index boost (v8.1)  │  score boost for time-matching memories
│  - Tag index boost (v8.1)       │  score boost for #tag-matching memories
│  - Access frequency boost       │
│  - Negative example penalty     │
│  - Namespace / artifact filter  │
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│  5. LLM reranking (opt-in)      │  timeboxed, fail-open
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│  6. Context assembly            │
│  0. Shared context (opt-in)     │  cross-agent shared context (if enabled)
│  1. Profile                     │  behavioral context
│  2. Identity continuity (v8.4)  │  mode-gated anchor/incident signals
│  3. Knowledge Index             │  entity/topic index (default-on)
│  4. Artifacts (v8.0)            │  high-confidence anchors
│  5. Memory boxes                │  recent topic windows
│  6. Notes + memories            │  search results
│  7. Checkpoint / transcripts    │  working context recovery
│  8. Hourly summaries            │  recent activity digest
└──────────────┬──────────────────┘
               ▼
         inject into system prompt
         (capped at maxMemoryTokens)
```

## Recall Planner (v8.0)

The planner classifies each request and selects a recall mode before any search:

| Mode | When Used | Behavior |
|------|-----------|----------|
| `no_recall` | Acknowledgements, simple acks | Skip search entirely |
| `minimal` | Short operational commands | QMD capped at `recallPlannerMaxQmdResultsMinimal` |
| `full` | Normal requests | Standard pipeline |
| `graph_mode` | Timeline / history queries | Extended graph traversal + provenance snapshot (seed/hop/type) |

Config: `recallPlannerEnabled` (default `true`).

## QMD Hybrid Search

Recall uses `QmdClient.search()` first (daemon-preferred when available) and supplements underfilled results with `QmdClient.hybridSearch()` (BM25 + vector merge). This keeps recall fail-open while reducing subprocess contention under load.

- `qmdCollection` specifies which QMD collection to search.
- `qmdMaxResults` caps the number of candidates returned.
- Optional `rerankEnabled` runs an additional LLM reranking pass over the merged candidates. This adds latency — enable only if QMD's built-in scoring is insufficient.

## Artifact Anchors (v8.0)

Verbatim artifacts are injected first in the context window, before regular search results. They represent high-confidence, high-importance memories (decisions, corrections, principles, commitments) extracted at write time. See `verbatimArtifactsEnabled`.

## Intent Routing (v8.0)

When `intentRoutingEnabled` is on, extraction captures `intent.goal`, `intent.actionType`, and `intent.entityTypes` for each memory. At recall time, memories whose intent is compatible with the current request receive a small score boost (`intentRoutingBoost`).

## Context Token Budget

All retrieved content is capped at `maxMemoryTokens` (default 2000 tokens) before injection. Sections are assembled in this order:
0. Shared context (if enabled)
1. Profile
2. Identity continuity (if enabled + mode gate passes)
3. Knowledge Index (entity/topic index; default-on)
4. Artifacts
5. Memory boxes
6. Notes + search results
7. Checkpoint / working context recovery
8. Hourly summaries

Identity continuity section behavior:
- `recovery_only`: inject only when prompt has explicit recovery/continuity intent.
- `minimal`: inject compact identity signals.
- `full`: inject structured anchor/loops/incidents block (downgraded to compact form when recall planner mode is `minimal`).
- `identityMaxInjectChars`: per-section cap with explicit trim marker when exceeded.

Recall telemetry (`recall_summary`) includes identity fields:
- `identityInjectionMode`
- `identityInjectedChars`
- `identityInjectionTruncated`

Graph recall explainability (`memory_graph_explain_last_recall`):
- snapshot persists bounded seed and expanded path sets (max 64 each)
- expanded entries include provenance: `seed`, `hopDepth`, `decayedWeight`, `graphType`
- output remains concise by honoring `maxExpanded` and rendering a compact per-entry provenance line

Retrieval debug artifacts (`state/last_graph_recall.json`, `state/last_intent.json`):
- `memory_graph_explain_last_recall` reads `state/last_graph_recall.json`
- the companion `memory_intent_debug` surface reads `state/last_intent.json` when the runtime exposes intent-debug snapshots
- `last_intent.json` is the planner-side snapshot: query text, inferred intent, selected recall mode, and any classifier reasons the runtime records
- `last_graph_recall.json` is the graph-side snapshot: mode, namespaces, seed paths, expanded paths, and graph provenance for each expansion
- richer graph snapshots may also include skip or fallback metadata and final ranked result summaries; explain tooling should tolerate those extra fields even when older builds only emit the core seed/expanded schema

## Namespace Routing (v3.0)

With namespaces enabled, retrieval filters candidates to allowed namespaces (local and shared) and returns results in score order. See [Namespaces](../namespaces.md).

## Configuration Quick Reference

| Setting | Default | Notes |
|---------|---------|-------|
| `recallPlannerEnabled` | `true` | Lightweight request classifier |
| `recallPlannerMaxQmdResultsMinimal` | `4` | QMD cap in minimal mode |
| `maxMemoryTokens` | `2000` | Total injected token cap |
| `identityContinuityEnabled` | `false` | Enables identity continuity injection path |
| `identityInjectionMode` | `recovery_only` | Identity injection behavior (`recovery_only|minimal|full`) |
| `identityMaxInjectChars` | `1200` | Max characters for identity continuity section |
| `qmdEnabled` | `true` | Enable QMD hybrid search |
| `qmdMaxResults` | `8` | Max QMD candidates |
| `intentRoutingEnabled` | `false` | Intent-compatible recall boost |
| `verbatimArtifactsEnabled` | `false` | Inject artifact anchors first |
| `rerankEnabled` | `false` | LLM reranking pass over QMD/embedding results |
| `queryAwareIndexingEnabled` | `false` | Temporal + tag index boost at scoring (v8.1) |

→ Full settings: [Config Reference](../config-reference.md)
