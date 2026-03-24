# Parallel Specialized Retrieval — Implementation Plan

## Context

Supermemory's ASMR technique achieved ~99% on LongMemEval by replacing single-pass vector search with parallel specialized retrieval agents. Engram already has hybrid BM25+vector search, decay, temporal supersession, and hook-based implicit saves. The single gap: **retrieval is one pass with no specialization**. This plan adds multi-agent retrieval with distinct focus areas.

## Critical Design Constraint: Zero LLM Inference Cost

**These are pure search/math agents. No LLM inference is added.** Each agent reuses existing search primitives:

| Agent | What it does | LLM calls | Cost |
|-------|-------------|-----------|------|
| DirectFact | Entity lookup → read entity files → filter facts | Zero | File I/O only |
| Contextual | Hybrid BM25+vector search → tag expansion → graph traversal | Same as existing hybrid search (embedding only) | Same as current |
| Temporal | Temporal index prefilter → decay scoring | Zero | File I/O + math |

Running three in parallel adds **no additional LLM cost** over the current single-pass. The BM25/vector embedding already happens — Agent 2 reuses it with a broader query scope.

## Latency Profile

Since agents run in **parallel**, total latency = `max(agent1, agent2, agent3)`, not `sum(...)`.
- Agent 1 (direct): reads a file or two — typically <5ms
- Agent 2 (contextual): reuses existing hybrid search — same latency as current
- Agent 3 (temporal): reads index file + scores — typically <10ms
- Merge step: Map operation on a few dozen results — negligible

**Net latency: roughly equal to current hybrid search, possibly slightly faster** because Agent 1 returns entity results while Agent 2 is still embedding.

## Graceful Degradation

If any agent errors or times out, the other two still return results. The merge step works with whatever it gets. No LLM fallback needed.

## Current Architecture (what exists)

- `qmd.ts`: `hybridSearch()` — runs BM25 + vector in parallel, merges by path
- `temporal-index.ts`: date-bucketed prefilter
- `tag-index.ts`: tag-based prefilter
- `orchestrator.ts`: single `recall()` function that calls `hybridSearch()` once

## Target Architecture

### Three Parallel Search Agents

Instead of one `hybridSearch()` call, run three parallel specialized passes:

#### Agent 1: Direct Facts (entity-specific)
- **Focus**: Exact entity matches, fact-level retrieval
- **Strategy**: Entity name matching → entity file read → fact extraction
- **Input**: query + extracted entity names from query
- **Returns**: Entity facts, decisions, commitments directly matching query entities
- **Implementation**: Reuse existing entity lookup + `readEntity()`, filter facts by relevance to query keywords

#### Agent 2: Contextual Implications (cross-project)
- **Focus**: Related context, project connections, implicit relationships
- **Strategy**: Broad semantic search → tag-based expansion → connected entity traversal
- **Input**: query + semantic embedding
- **Returns**: Related project context, connections between entities, background knowledge
- **Implementation**: Existing `hybridSearch()` with expanded tag set + Knowledge Index traversal via entity connections

#### Agent 3: Temporal & Active (recent + live)
- **Focus**: Recent decisions, active tasks, recent changes, temporal context
- **Strategy**: Temporal index prefilter (last 7 days) → decay-aware scoring (boost fresh, penalize stale)
- **Input**: query + time window
- **Returns**: Recent memories, active commitments, recent changes, anything with high recency score
- **Implementation**: `temporalIndex.search()` with narrow window + decay score integration

### Orchestrator: Merging

New function `parallelRetrieval(query, options)`:
1. Extract known entities from query (reuse existing entity extraction)
2. Run query classification: decide which agents to activate
3. Run activated agents in parallel via `Promise.all()`
4. Each agent returns typed results with `agentSource: 'direct' | 'contextual' | 'temporal'`
5. Merge by memory path, keeping best score per agent source
6. Apply source-weighted scoring:
   - Direct facts: 1.0x (high precision)
   - Contextual: 0.7x (broader, lower precision)
   - Temporal: 0.85x (boosted for recency)
7. Deduplicate, sort by combined score, return top N

### Query Classification (v1 — required)

Simple heuristic to decide which agents to run, avoiding unnecessary I/O:

```ts
type SearchAgentSource = "direct" | "contextual" | "temporal";

function shouldRunAgent(
  agent: SearchAgentSource,
  query: string,
  knownEntities: string[]
): boolean {
  switch (agent) {
    case "direct":
      // Skip if query has no entity names — Agent 1 would return nothing
      return knownEntities.length > 0;

    case "temporal":
      // Always run — temporal context is broadly useful and cheap (<10ms)
      return true;

    case "contextual":
      // Always run — this is the core semantic search, same cost as current hybridSearch
      return true;

    default:
      return true;
  }
}
```

**Rationale**: Agent 1 (direct) is the only one worth skipping — if the query mentions no known entities, entity file lookups will return empty. Agents 2 and 3 are already-cheap existing operations (hybrid search + index read) so skipping them saves negligible I/O. The parallelism means running all three costs `max(agents)` not `sum(agents)`.

## Files to Modify

| File | Change |
|------|--------|
| `src/orchestrator.ts` | Add `parallelRetrieval()` method, wire into `recall()` |
| `src/qmd.ts` | Expose `hybridSearch` internals for per-agent customization |
| New: `src/retrieval-agents.ts` | Three search agent classes + orchestrator |
| `src/types.ts` | Add `SearchAgentSource` type, `ParallelSearchResult` interface |
| `src/config.ts` | Add `parallelRetrievalEnabled`, per-agent weight config |

## Implementation Steps

1. **Create `src/retrieval-agents.ts`** with:
   - `DirectFactAgent`: entity-first search
   - `ContextualAgent`: expanded semantic + graph traversal
   - `TemporalAgent`: time-windowed decay-aware search
   - `parallelRetrieval()` orchestrator with merge logic

2. **Add types** to `src/types.ts`:
   ```ts
   type SearchAgentSource = "direct" | "contextual" | "temporal";
   interface ParallelSearchResult {
     path: string;
     score: number;
     snippet: string;
     source: SearchAgentSource;
     agentScores: Record<SearchAgentSource, number>;
   }
   ```

3. **Wire into `orchestrator.ts` `recall()`**:
   - Gate behind `parallelRetrievalEnabled` config flag
   - Fall back to existing single-pass `hybridSearch()` on error
   - Log per-agent timing + result counts for tuning

4. **Config in `src/config.ts`**:
   - `parallelRetrievalEnabled: boolean` (default false)
   - `parallelAgentWeights: Record<SearchAgentSource, number>`
   - `parallelMaxResultsPerAgent: number`

5. **Tests**:
   - Unit: each agent independently
   - Integration: `parallelRetrieval()` merge logic
   - Regression: existing `hybridSearch()` path unchanged

## Acceptance Criteria

- [ ] **Zero LLM inference cost**: agents reuse existing search primitives, no new LLM calls introduced
- [ ] Three search agents run in parallel via `Promise.all()`
- [ ] Each agent returns typed results with source tag
- [ ] Merge logic deduplicates and scores across agents
- [ ] Query classification skips Agent 1 when no entities detected
- [ ] Config flag enables/disables without code changes
- [ ] Existing single-pass retrieval still works as fallback
- [ ] Agent timing logged for performance tuning
- [ ] Graceful degradation: agent error/timeout doesn't block other results
- [ ] All existing tests pass
- [ ] No measurable latency increase vs current `hybridSearch()`

## References

- Supermemory ASMR: https://blog.supermemory.ai/we-broke-the-frontier-in-agent-memory-introducing-99-sota-memory-system/
- Engram `qmd.ts`: existing hybrid search
- Engram `lifecycle.ts`: decay scoring to reuse in TemporalAgent
- Engram `temporal-index.ts`: date prefilter to build on
