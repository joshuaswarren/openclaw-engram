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
│  b. QMD hybrid search           │  BM25 + vector + reranker
│  c. Embedding fallback          │  semantic search when QMD unavailable
│  d. Namespace filter (v3.0)     │  filter to allowed namespaces
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│  4. Scoring & filtering         │
│  - Recency boost (opt-in)       │
│  - Importance weight            │
│  - Intent compatibility (v8.0)  │
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
│  1. Profile                     │  behavioral context (prepended first)
│  2. Artifacts (v8.0)            │  high-confidence anchors
│  3. Memory boxes                │  recent topic windows
│  4. Notes + memories            │  search results
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
| `graph_mode` | Timeline / history queries | Extended graph traversal (future) |

Config: `recallPlannerEnabled` (default `true`).

## QMD Hybrid Search

Engram's `QmdClient.hybridSearch()` runs BM25 and vector searches as separate subprocess calls and merges results. This avoids QMD's HTTP daemon in favor of direct subprocess execution for reliability.

- `qmdCollection` specifies which QMD collection to search.
- `qmdMaxResults` caps the number of candidates returned.
- Optional `rerankEnabled` runs an additional LLM reranking pass over the merged candidates. This adds latency — enable only if QMD's built-in scoring is insufficient.

## Artifact Anchors (v8.0)

Verbatim artifacts are injected first in the context window, before regular search results. They represent high-confidence, high-importance memories (decisions, corrections, principles, commitments) extracted at write time. See `verbatimArtifactsEnabled`.

## Intent Routing (v8.0)

When `intentRoutingEnabled` is on, extraction captures `intent.goal`, `intent.actionType`, and `intent.entityTypes` for each memory. At recall time, memories whose intent is compatible with the current request receive a small score boost (`intentRoutingBoost`).

## Context Token Budget

All retrieved content is capped at `maxMemoryTokens` (default 2000 tokens) before injection. Sections are assembled in this order:
1. Profile
2. Artifacts
3. Memory boxes
4. Notes + search results

## Namespace Routing (v3.0)

With namespaces enabled, retrieval filters candidates to allowed namespaces (local and shared) and returns results in score order. See [Namespaces](../namespaces.md).

## Configuration Quick Reference

| Setting | Default | Notes |
|---------|---------|-------|
| `recallPlannerEnabled` | `true` | Lightweight request classifier |
| `recallPlannerMaxQmdResultsMinimal` | `4` | QMD cap in minimal mode |
| `maxMemoryTokens` | `2000` | Total injected token cap |
| `qmdEnabled` | `true` | Enable QMD hybrid search |
| `qmdMaxResults` | `8` | Max QMD candidates |
| `intentRoutingEnabled` | `false` | Intent-compatible recall boost |
| `verbatimArtifactsEnabled` | `false` | Inject artifact anchors first |
| `rerankEnabled` | `false` | LLM reranking (don't use with QMD) |

→ Full settings: [Config Reference](../config-reference.md)
