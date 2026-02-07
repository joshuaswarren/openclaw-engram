# OpenClaw Engram Enhancement Plan

**Plan Version:** 1.2
**Created:** 2026-02-07
**Status:** Approved
**Approved:** 2026-02-07
**Revised:** 2026-02-07 (Quality safeguards added)

---

## Executive Summary

This plan outlines enhancements to openclaw-engram inspired by the CLAWS memory system. These features will improve memory quality, retrieval accuracy, and knowledge graph capabilities while maintaining engram's local-first philosophy and rich categorization system.

### Why These Enhancements?

After comparing openclaw-engram with CLAWS (a production-grade Redis-based memory system), we identified several capabilities that would significantly improve engram's effectiveness:

1. **Better Retrieval** - Recency boosting and importance scoring surface the most relevant memories
2. **Quality Control** - Contradiction detection and importance filtering reduce noise
3. **Richer Relationships** - Memory linking creates knowledge graphs beyond entity references
4. **Scalability** - Chunking and compression handle long content and memory growth

---

## Feature Specifications

### 1. Local Importance Scoring ⭐ HIGH PRIORITY

**What it is:**
A zero-LLM heuristic scoring system that evaluates each memory's significance at extraction time. Analyzes content for markers like explicit importance statements, personal information, instructions, emotional content, and factual density.

**How it works:**
- Scores memories on 0-1 scale with five tiers:
  - `critical` (0.9-1.0): Explicit importance markers, personal info, preferences
  - `high` (0.7-0.9): Decisions, instructions, temporal references
  - `normal` (0.4-0.7): Factual content, emotional content
  - `low` (0.2-0.4): Uncertain statements, hedging
  - `trivial` (0.0-0.2): Greetings, filler words ("ok", "thanks", "got it")
- Provides explainable reasons for each score
- Extracts salient keywords for indexing

**Why we need it:**
- **Rank** memories in retrieval (important first)
- Prioritize important memories during consolidation
- Make retrieval more relevant without LLM calls
- Guide compression decisions (only compress low-importance)

**Implementation notes:**
- Add to extraction schema: `importance` field with score, level, reasons, keywords
- Store in memory frontmatter
- Use in retrieval **ranking** (not exclusion)
- Only compression uses importance as a gate (threshold 0.3)
- Zero external API calls - pure local heuristics

**Quality safeguard:** Importance scoring is for **ranking and compression gating only**. All memories are still stored and retrievable. A `low` importance memory can still be found via search — it just ranks lower. Only the compression pass uses importance as an exclusion gate, and even then with protections (entityRef, protected tags).

---

### 2. Automatic Chunking with Overlap ⭐ HIGH PRIORITY

**What it is:**
Automatic splitting of long memories into overlapping chunks for better retrieval granularity. Instead of storing a 1000-token conversation as one unit, split it into smaller chunks with overlap.

**How it works:**
- **Sentence-boundary chunking** (default) — never split mid-sentence
- Target chunk size: ~200 tokens, but boundaries flex to preserve sentences
- Overlap: at least 2 sentences (not fixed token count)
- Each chunk maintains reference to parent episode via `parentId` and `chunkIndex`
- Chunks are searchable units but link back to full context
- **Skip chunking for short memories** (< 150 tokens) — no benefit, adds noise

**Why we need it:**
- Long conversations/documents currently stored as monolithic units
- Specific details get lost in large text blocks
- Enables precise retrieval of relevant segments
- Better vector search (smaller, focused embeddings)

**Implementation notes:**
- Store chunks as **separate files with parent reference** (not sub-units)
- Chunk IDs: `{parent-id}-chunk-{index}`
- Add `parentId` and `chunkIndex` to frontmatter
- Retrieval returns chunks with link to parent for full context
- QMD indexes chunks individually for granular semantic search

**Quality safeguard:** Sentence-boundary splitting preserves coherent thoughts. A statement like "He prefers dark mode for coding but light mode for reading" stays intact.

---

### 3. Recency Boosting in Search ⭐ MEDIUM PRIORITY

**What it is:**
Blending of BM25 relevance scores with recency to surface recently created/accessed memories higher in results.

**How it works:**
- Configurable `recencyWeight` parameter (0-1, default 0.2)
- Final score = (BM25_score * (1 - recencyWeight)) + (recency_score * recencyWeight)
- Recency score decays exponentially with age
- Can be disabled by setting weight to 0

**Why we need it:**
- Recent context often more relevant than old memories
- Currently, an old irrelevant memory might rank above a recent relevant one
- Users tend to care about what was discussed recently
- Improves conversational coherence

**Implementation notes:**
- Modify retrieval pipeline to calculate recency scores
- Add `recencyWeight` to recall/search options
- Works with QMD search results (post-process ranking)
- Consider also boosting recently accessed (see #6 Access Tracking)

---

### 4. Access Tracking ⭐ MEDIUM PRIORITY

**What it is:**
Tracking how often and how recently each memory is retrieved/used, enabling "working set" prioritization.

**How it works:**
- Increment `accessCount` each time memory is retrieved
- Update `lastAccessed` timestamp on each retrieval
- Use in importance boosting (frequently accessed = more important)
- Separate from creation timestamp (createdAt vs lastAccessed)
- **Batch updates** to avoid latency (see Decisions Made section)

**Why we need it:**
- Some memories are "hot" (referenced often) vs "cold" (stored but unused)
- Identifies what's actually valuable to the user
- Enables LRU (least recently used) pruning decisions
- Analytics: which memories matter most?

**Implementation notes:**
- Add to memory frontmatter: `accessCount`, `lastAccessed`
- Track changes in memory buffer (Map of memoryId -> {newCount, newTimestamp})
- Flush to disk during consolidation pass OR when buffer exceeds 100 entries
- Zero latency impact on retrieval performance
- Use in retrieval ranking alongside recency

---

### 5. Contradiction Detection ⭐ HIGH PRIORITY

**What it is:**
Automatic detection when a new memory conflicts with or contradicts an existing memory, with auto-resolution and audit trail.

**How it works:**
- When storing new memory, search QMD for semantically similar existing memories
- If similarity > 0.7, use **LLM verification** to confirm contradiction (see Decision #6)
- Auto-resolve when LLM confirms with confidence > 0.9
- Full audit trail with `supersededBy`/`supersedes` linking

**Why we need it:**
- Users change preferences over time ("I hate dark mode" → "I love dark mode")
- Storing both without marking contradiction causes confusion
- Maintains memory quality and consistency
- Enables "what changed?" queries
- Audit trail preserves belief evolution history

**Implementation notes:**
- Run during extraction/consolidation
- QMD similarity search finds candidates (fast, cheap)
- LLM verifies actual contradiction (accurate, worth the cost)
- Mark old memory with `status: superseded` and `supersededBy: <new-id>`
- Add to new memory: `supersedes: <old-id>`
- Log to `corrections/` directory with reasoning

**Quality safeguard:** LLM verification prevents false positives. "Likes TypeScript" and "Likes Python" are NOT contradictions — the LLM understands this, naive heuristics don't.

---

### 6. Memory Linking with Relationship Types ⭐ HIGH PRIORITY

**What it is:**
Explicit typed relationships between memories beyond entity references - creating a knowledge graph.

**How it works:**
- Relationship types: `follows` | `references` | `contradicts` | `supports` | `related`
- Each link has source, target, type, and strength (0-1)
- Stored in memory frontmatter
- Enables graph traversal (find memories related to this one)
- Bidirectional or unidirectional as appropriate

**Link detection (two-stage):**
1. **Extraction time:** LLM suggests links when it sees a memory that relates to recent context (e.g., "this decision supports that principle")
2. **Consolidation time:** Expand links by examining co-occurring entities and temporal proximity

**Why we need it:**
- Current entity linking only connects memories sharing entities
- Richer semantics: "this decision supports that principle"
- Navigate memory space via relationships
- Build up user's belief system, reasoning chains

**Implementation notes:**
- Add `links` array to memory frontmatter:
  ```yaml
  links:
    - target: decision-456
      type: supports
      strength: 0.8
  ```
- Add `suggestedLinks` to extraction schema (LLM output)
- Add agent tool: `memory_related` - find memories linked to given one
- Consolidation validates and expands links based on entity overlap
- Visualize as knowledge graph

---

### 7. Memory Summarization / Compression ⭐ MEDIUM PRIORITY

**What it is:**
Compress batches of old memories into summaries, preserving key facts while reducing retrieval noise. **Archive, don't delete.**

**How it works:**
- Triggered when memory count exceeds threshold (e.g., 1000 episodes)
- Select candidates: old, low-importance, unprotected memories
- Send to LLM with compression prompt
- Extract: summary text, key facts[], key entities[], time range
- Store summary, **mark sources as `status: archived`** (not deleted)
- Configurable: `recentToKeep`, `protectedTags`, `importanceThreshold`

**Why we need it:**
- Memory grows indefinitely - need growth control
- Old detailed conversations less valuable than summarized learnings
- Reduces retrieval noise from obsolete details
- Preserves knowledge while freeing retrieval space

**Implementation notes:**
- Add `summaries/` directory alongside `facts/`
- Summary files reference source episode IDs
- Mark source episodes with `status: archived` (stays in place, QMD still indexes)
- Retrieval filters out `archived` by default, but archive is still searchable explicitly
- Run during consolidation passes

**Quality safeguard:** Using `status: archived` instead of file deletion means:
- QMD still indexes archived memories (no path exclusion needed)
- Explicit archive searches still work
- Nothing is truly lost
- Reversible if compression was too aggressive

**Additional protection:** Memories with `entityRef` (personal relationships, project details) are protected from compression regardless of importance score.

---

### 8. Conversation Threading ⭐ MEDIUM PRIORITY

**What it is:**
Group related memories into conversation threads with auto-generated titles, enabling context-aware retrieval.

**How it works:**
- Thread has ID, title, timestamps, list of episode IDs
- Episodes can belong to multiple threads
- Auto-generate title from top 3 keywords (local TF-IDF on thread content)
- Retrieve "context of this conversation" by getting all episodes in thread
- Link threads (thread A references thread B)

**Thread boundary detection (deterministic, no LLM):**
- New thread when session key changes, OR
- Time gap > 30 minutes from previous turn
- No topic-shift detection (too unreliable without LLM)

**Why we need it:**
- Current system stores isolated memories
- Conversations span multiple turns - want to reconstruct flow
- "What did we discuss about X last week?" - find thread, get full context
- Better than simple recency for conversational coherence

**Implementation notes:**
- Add `threads/` directory with thread metadata files
- Episode frontmatter gets `threadIds` array
- Thread file: title, createdAt, episodeIds[], linkedThreadIds[]
- Agent tool: `memory_thread_context` - get all episodes in thread
- Session key already exists in `BufferTurn` — use it

---

### 9. Topic Extraction ⭐ LOW PRIORITY

**What it is:**
Extract key topics from all memories using TF-IDF weighting to understand what the memory corpus is "about".

**How it works:**
- Calculate term frequency across all memories
- Compute inverse document frequency (IDF) for each term
- Score = TF * IDF (terms frequent in specific memories but rare overall score highest)
- Return top N topics
- Update periodically (expensive calculation)

**Why we need it:**
- "What do I talk about most?" - meta-analysis of memory
- Auto-tagging suggestions (high-scoring topics as tags)
- Identify emerging interests over time
- Could drive curiosity questions ("explore this topic more?")

**Implementation notes:**
- Batch process all memories (expensive, run during consolidation)
- Store in meta.json: `topTopics: [{term, score}]`
- Compare topics over time (trending up/down)
- Could feed into identity reflections

---

## Implementation Roadmap

### Phase 1: Foundation (High Impact, Low Complexity)
1. **Local Importance Scoring** - Add to extraction pipeline
2. **Access Tracking** - Add to retrieval path
3. **Recency Boosting** - Modify search ranking

### Phase 2: Content Management
4. **Automatic Chunking** - Handle long content better
5. **Contradiction Detection** - Maintain memory quality

### Phase 3: Knowledge Graph
6. **Memory Linking** - Rich relationships
7. **Conversation Threading** - Context reconstruction

### Phase 4: Scale
8. **Memory Summarization** - Growth control
9. **Topic Extraction** - Meta-analysis

---

## Technical Considerations

### Storage Format Changes

Current memory frontmatter:
```yaml
---
id: fact-123
category: fact
created: 2026-02-07T10:00:00Z
confidence: 0.85
tags: [tools]
---
```

Proposed extended frontmatter:
```yaml
---
id: fact-123
category: fact
created: 2026-02-07T10:00:00Z
confidence: 0.85
tags: [tools]
# New fields
importance:
  score: 0.75
  level: high
  reasons: ["Contains instruction", "Technical detail"]
  keywords: [docker, container]
accessCount: 3
lastAccessed: 2026-02-07T12:00:00Z
links:
  - target: decision-456
    type: supports
    strength: 0.8
threadIds: [thread-abc]
# Chunking (if this is a chunk)
parentId: fact-456  # Parent episode ID
chunkIndex: 0  # Position in parent
# Status management
status: active  # active | superseded | archived
supersededBy: null  # Set to memory ID if superseded
supersedes: null  # Set to memory ID if this supersedes another
supersededAt: null  # Timestamp when superseded
archivedAt: null  # Timestamp when archived (compression)
---
```

**Status field values:**
- `active` (default): Normal memory, included in retrieval
- `superseded`: Contradicted by newer memory, excluded from retrieval by default
- `archived`: Compressed into summary, excluded from retrieval by default

**QMD considerations:** All statuses remain in QMD index. Retrieval filters by status in post-processing. Explicit searches can include superseded/archived if requested.

### Backwards Compatibility

- All new fields optional
- Default values for existing memories during migration
- Graceful degradation if features disabled

### Configuration Additions

```json
{
  "importanceScoring": {
    "enabled": true
    // Note: No minLevel filter - importance is for ranking only
  },
  "chunking": {
    "enabled": true,
    "targetTokens": 200,
    "minTokensToChunk": 150,
    "splitOn": "sentence"  // Only sentence-boundary splitting
  },
  "retrieval": {
    "recencyWeight": 0.2,
    "boostAccessCount": true,
    "excludeStatuses": ["superseded", "archived"]  // Default filter
  },
  "contradictionDetection": {
    "enabled": true,
    "similarityThreshold": 0.7,
    "minConfidence": 0.9,  // Raised from 0.8 for safety
    "useLlmVerification": true,  // Prevents false positives
    "autoResolve": true,
    "createAuditTrail": true
  },
  "accessTracking": {
    "enabled": true,
    "batchUpdates": true,
    "flushDuringConsolidation": true,
    "bufferMaxSize": 100
  },
  "compression": {
    "enabled": true,
    "triggerAt": 1000,
    "recentToKeep": 300,
    "protectedTags": ["commitment", "preference", "decision"],
    "protectEntityRefs": true,  // Memories with entityRef are protected
    "importanceThreshold": 0.3,
    "archiveNotDelete": true  // Use status: archived, not file deletion
  },
  "topicExtraction": {
    "enabled": true,
    "runDuringConsolidation": true,
    "topN": 50
  }
}
```

---

## Success Metrics

After implementation, we should see:

1. **Retrieval Quality** - More relevant memories surfaced first
2. **Memory Signal/Noise** - Reduction in trivial memories stored
3. **User Satisfaction** - Agent feels more "aware" of important context
4. **Storage Efficiency** - Compression reduces file count over time
5. **Knowledge Graph** - Ability to navigate related memories

---

## Decisions Made

The following architectural decisions were made during plan review on 2026-02-07:

### 1. Continue with QMD (Not Native BM25) ✓

**Decision:** Continue using QMD for hybrid search (BM25 + vector + reranking) rather than implementing native BM25.

**Rationale:** QMD already provides robust search capabilities. Building native BM25 would be redundant effort. We'll focus on post-processing QMD results with recency boosting and importance filtering.

---

### 2. Conservative Compression Defaults ✓

**Decision:** Use conservative compression settings by default, user-configurable.

**Rationale:** Aggressive compression risks losing valuable context. Conservative defaults are safer while still providing growth control.

**Default settings:**
```json
{
  "compression": {
    "triggerAt": 1000,
    "recentToKeep": 300,
    "importanceThreshold": 0.3,
    "protectedTags": ["commitment", "preference", "decision"]
  }
}
```

This means compression only affects:
- Memories older than the 300 most recent
- With importance score < 0.3 (trivial/low tier)
- Not tagged as commitment/preference/decision

---

### 3. Auto-Resolve Contradictions with Audit Trail ✓

**Decision:** Automatically resolve contradictions (confidence > 0.8) with a full audit trail, not deletion.

**How it works:**
1. Mark the old memory as `status: superseded` with `supersededBy: <new-memory-id>`
2. Add to the new memory: `supersedes: <old-memory-id>`
3. Log to `corrections/` with timestamp and reasoning

**Example:**
```yaml
# Old memory (now superseded)
id: preference-123
content: "User hates dark mode"
status: superseded
supersededBy: preference-456
supersededAt: 2026-02-07T14:00:00Z

# New memory
id: preference-456
content: "User prefers dark mode for coding"
supersedes: preference-123
```

**Benefits:**
- Retrieval skips superseded memories by default
- User can query "what changed?" to see belief evolution
- Nothing truly lost (full audit trail)
- Reversible if auto-resolve was wrong

---

### 4. Batch Access Tracking Updates ✓

**Decision:** Batch access tracking updates to avoid latency impact on retrieval.

**How it works:**
1. Track access changes in memory (a Map of `memoryId -> {newCount, newTimestamp}`)
2. Flush to disk during the next **consolidation pass**
3. Or flush when buffer exceeds N entries (e.g., 100)

**Rationale:** Writing to disk on every retrieval would create unnecessary latency. Batching means zero impact on retrieval performance, and writes happen during background consolidation where timing doesn't matter.

---

### 5. Batch Topic Extraction During Consolidation ✓

**Decision:** Run topic extraction as a batch process during consolidation passes, not real-time.

**Rationale:**
- Topics are "nice to have" metadata, not critical for retrieval
- Real-time recalculation is computationally expensive
- Running during consolidation means zero additional overhead
- Daily updates are fresh enough for curiosity question generation

---

### 6. LLM Verification for Contradiction Detection ✓

**Decision:** Use LLM to verify contradictions instead of local polarity heuristics.

**Rationale:**
- False positives are worse than missed contradictions (superseding valid memories is destructive)
- Local heuristics are too crude: "likes TypeScript" vs "likes Python" is NOT a contradiction
- LLM understands semantic nuance that heuristics miss
- The cost is justified: one LLM call per suspected conflict (rare) is cheap insurance
- Only called when QMD finds high-similarity match (> 0.7), not on every memory

**How it works:**
1. QMD similarity search finds candidate conflicts (fast, free)
2. If similarity > 0.7, call LLM with both memories and ask: "Are these contradictory?"
3. LLM returns: `{isContradiction: boolean, confidence: number, reasoning: string}`
4. Auto-resolve only if `isContradiction && confidence > 0.9`
5. Lower confidence contradictions are flagged but not auto-resolved

---

### 7. Archive via Status Field (Not File Movement) ✓

**Decision:** Use `status: archived` instead of moving files to a separate directory.

**Rationale:**
- QMD indexes the entire memory directory — moving files would require path exclusion config
- Status field approach keeps files in place, QMD still indexes everything
- Retrieval filters out `archived` in post-processing (already done for `superseded`)
- Explicit archive searches remain possible
- No file system complexity, no QMD reconfiguration needed

**Status values:**
- `active` (default): Normal retrieval
- `superseded`: Contradicted by newer memory
- `archived`: Compressed into summary

---

### 8. Sentence-Boundary Chunking Only ✓

**Decision:** Chunk on sentence boundaries, never mid-sentence.

**Rationale:**
- Fixed-token chunking can split coherent thoughts
- "He prefers dark mode for coding but light mode for reading" must stay intact
- Sentence boundaries preserve semantic units
- Overlap should be 2+ sentences, not fixed tokens

**Implementation:**
- Split on `.` `!` `?` followed by whitespace
- Target ~200 tokens per chunk, but flex to preserve sentences
- Skip chunking for memories < 150 tokens (no benefit)

---

### 9. Importance for Ranking Only ✓

**Decision:** Use importance scoring for retrieval ranking, not exclusion.

**Rationale:**
- Excluding low-importance memories could lose subtle but valuable signals
- "Hey, I'm back from vacation in Japan" might score `low` but contains context
- Ranking ensures important memories surface first without losing anything
- Only compression uses importance as a gate (with additional protections)

**Where importance is used:**
- Retrieval: boost ranking (important first)
- Compression: gate (importance < 0.3 can be archived)

**Where importance is NOT used:**
- Storage: all memories are stored regardless of importance
- Search: all memories are searchable regardless of importance

---

## ~~Open Questions~~ → Resolved

All architectural questions have been resolved (see Decisions Made section above):

| Question | Resolution |
|----------|------------|
| Native BM25 vs QMD? | Continue with QMD ✓ |
| Compression aggressiveness? | Conservative (trigger at 1000, keep 300 recent) ✓ |
| Contradiction handling? | Auto-resolve with audit trail ✓ |
| Access tracking performance? | Batch updates during consolidation ✓ |
| Topic extraction timing? | Batch during consolidation ✓ |
| Contradiction detection method? | LLM verification (not local heuristics) ✓ |
| Archive storage approach? | Status field (not file movement) ✓ |
| Chunking strategy? | Sentence-boundary only ✓ |
| Importance scoring usage? | Ranking only (not exclusion) ✓ |

---

## Quality Safeguards Summary

These safeguards ensure the enhancements improve memory quality without introducing regressions:

| Risk | Safeguard |
|------|-----------|
| False contradiction detection | LLM verification (not heuristics), 0.9 confidence threshold |
| Losing compressed memories | Archive via status field, nothing deleted, still searchable |
| Fragmenting coherent thoughts | Sentence-boundary chunking only, skip short memories |
| Missing subtle signals | Importance for ranking only, not exclusion |
| Losing personal context | Protect memories with `entityRef` from compression |
| QMD indexing conflicts | Status field approach keeps all files in place |

**Core principle:** Additive metadata (links, threads, scores) is safe. Destructive actions (supersede, archive) require high confidence and full audit trails.

---

*Plan maintained by: openclaw-engram maintainers*
*Last updated: 2026-02-07 (v1.2 - Quality safeguards)*
