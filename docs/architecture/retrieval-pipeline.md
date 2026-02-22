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
│  c. Namespace merge (v3.0)      │  local + shared namespaces
│  d. Query expansion (opt-in)    │  deterministic BM25 expansions
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
│  1. Artifacts (v8.0)            │  highest priority anchors
│  2. Profile                     │  behavioral context
│  3. Notes + stable memories     │  durable beliefs
│  4. Episodes / boxes            │  narrative continuity
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

QMD's `query` command runs BM25 + vector + built-in reranking in a single call. This is the recommended search path.

- Do NOT also enable `rerankEnabled` when using QMD — it causes redundant double reranking.
- `qmdCollection` specifies which QMD collection to search.
- `qmdMaxResults` caps the number of results.

## Artifact Anchors (v8.0)

Verbatim artifacts are injected first in the context window, before regular search results. They represent high-confidence, high-importance memories (decisions, corrections, principles, commitments) extracted at write time. See `verbatimArtifactsEnabled`.

## Intent Routing (v8.0)

When `intentRoutingEnabled` is on, extraction captures `intent.goal`, `intent.actionType`, and `intent.entityTypes` for each memory. At recall time, memories whose intent is compatible with the current request receive a small score boost (`intentRoutingBoost`).

## Context Token Budget

All retrieved content is capped at `maxMemoryTokens` (default 2000 tokens) before injection. Assembly order ensures the highest-value content is kept when the budget is tight:
1. Artifacts
2. Profile
3. Notes
4. Episodes / boxes

## Namespace Routing (v3.0)

With namespaces enabled, search runs against both the local namespace and the shared namespace. Results are merged via round-robin to preserve representation from each namespace. See [Namespaces](../namespaces.md).

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
| `queryExpansionEnabled` | `false` | Deterministic BM25 expansions |
| `rerankEnabled` | `false` | LLM reranking (don't use with QMD) |

→ Full settings: [Config Reference](../config-reference.md)
