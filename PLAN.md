# OpenClaw Engram Roadmap

**Current Version:** 1.2.0
**Last Updated:** 2026-02-08 (v2.0 finalized with transcript/summary injection design)

---

## Completed Features

### v1.0.0 — Core Memory System (2026-02-05)
- GPT-5.2 extraction via OpenAI Responses API
- QMD hybrid search (BM25 + vector + reranking)
- Markdown + YAML frontmatter storage
- 10 memory categories: fact, preference, correction, entity, decision, relationship, principle, commitment, moment, skill
- Question generation and identity reflections
- Profile auto-consolidation
- CLI tools: search, store, profile, entities, questions, identity

### v1.1.0 — Observability & Entity Management (2026-02-07)
- LLM trace callback system for external observability plugins
- Inter-plugin discovery via `globalThis.__openclawEngramOrchestrator`
- Token usage reporting on all LLM calls
- Entity extraction with known entity name injection
- Fuzzy entity matching to prevent fragmentation
- Configurable entity aliases (`config/aliases.json`)

### v1.2.0 — Retrieval Quality & Knowledge Graph (2026-02-07)
- **Access Tracking**: Track memory access counts and recency (batched updates)
- **Local Importance Scoring**: Zero-LLM heuristic scoring with critical/high/normal/low/trivial tiers
- **Recency Boosting**: Recent memories rank higher (configurable weight)
- **Access Count Boosting**: Frequently accessed memories surface higher
- **Status Field**: Lifecycle management (active/superseded/archived)
- **Automatic Chunking**: Sentence-boundary chunking for long memories (disabled by default)
- **Contradiction Detection**: LLM-verified contradiction resolution (disabled by default)
- **Memory Linking**: Knowledge graph with typed relationships (disabled by default)
- **Conversation Threading**: Group memories into threads (disabled by default)
- **Memory Summarization**: Compress old memories into summaries (disabled by default)
- **Topic Extraction**: TF-IDF topic analysis from memory corpus

---

## Planned Features

### v2.0 — Transcript & Context Preservation

**Goal:** Solve session compaction context loss. Agents currently forget recent working context (e.g., API keys already provided) after compaction.

#### Feature 1: Transcript Archive
- Append every turn to `memory/local/transcripts/{channelType}/{channelId}/YYYY-MM-DD.jsonl`
- 7-day retention (configurable via `transcriptRetentionDays`)
- JSON Lines format with timestamp, role, content, sessionKey, turnId
- Survives compaction and gateway restarts
- Skips channels by type (e.g., `cron`) via `transcriptSkipChannelTypes` config

#### Feature 2: Transcript Injection in Recall
- Include recent conversation turns (default: **last 12 hours**) in context injection
- Formatted as readable conversation log, not raw JSON
- **Auto-injected** (no relevance filtering — recency is the signal)
- Hard caps prevent token budget overflow:
  - `maxTranscriptTurns`: default 50, range 10-200
  - `maxTranscriptTokens`: default 1000, range 200-4000
- Injected after memories, before summaries in recall output

#### Feature 3: Compaction Detection & Checkpoint
- Detect session compaction via OpenClaw hook or polling
- Capture last N turns as "checkpoint" before compaction
- Persist checkpoint to `memory/local/state/checkpoint.json`
- Inject checkpoint into recall after compaction (TTL: 24 hours)

#### Feature 4: Hourly Summaries (Per-Channel)
- Cron job generates narrative summary of each hour's activity **per session/channel**
- Runs at a random minute (1-59) to avoid thundering herd across all channels
- Empty hours skipped (no file created for inactive channels)
- Appends to `memory/local/summaries/hourly/{channelType}/{channelId}/YYYY-MM-DD.md`
- Injects last 24 hours of summaries into recall context (capped by `maxSummaryCount`)
- Provides "what was I working on" narrative for post-compaction recovery

#### New Configuration Options
```typescript
// Transcript archive
transcriptEnabled: boolean;          // default: true
transcriptRetentionDays: number;     // default: 7 (range: 1-30)
transcriptSkipChannelTypes: string[]; // default: ["cron"] - skip transcript for these channel types

// Transcript injection (full conversation)
transcriptRecallHours: number;       // default: 12 (range: 1-24)
maxTranscriptTurns: number;          // default: 50 (range: 10-200)
maxTranscriptTokens: number;         // default: 1000 (range: 200-4000)

// Compaction checkpoint
checkpointEnabled: boolean;          // default: true
checkpointTurns: number;             // default: 15 (range: 5-50)

// Hourly summaries (narrative)
hourlySummariesEnabled: boolean;     // default: true
summaryRecallHours: number;          // default: 24 (range: 6-48)
maxSummaryCount: number;             // default: 6 (range: 1-24)
summaryModel: string;                // default: same as extraction model
```

#### New Storage Layout
```
memory/local/
├── ...existing directories...
├── summaries/                    # NEW: hourly summaries (per-channel)
│   └── hourly/
│       ├── discord/
│       │   ├── 1467253307880771781/
│       │   │   └── 2026-02-08.md
│       │   └── 1467910426162364563/
│       │       └── 2026-02-08.md
│       └── cli/
│           └── default/
│               └── 2026-02-08.md
├── transcripts/                  # NEW: full conversation archive (7-day retention)
│   ├── discord/
│   │   ├── 1467253307880771781/
│   │   │   └── 2026-02-08.jsonl
│   │   └── 1467910426162364563/
│   │       └── 2026-02-08.jsonl
│   └── cli/
│       └── default/
│           └── 2026-02-08.jsonl
└── state/
    ├── ...existing files...
    └── checkpoint.json           # NEW: compaction checkpoint
```

#### New CLI Commands
- `openclaw engram transcript --date 2026-02-07` — View transcript for specific date
- `openclaw engram transcript --recent 12h` — View recent transcript (any duration)
- `openclaw engram transcript --channel discord-1467253307880771781` — View by channel
- `openclaw engram checkpoint` — View current checkpoint (if any)
- `openclaw engram summaries --channel discord-1467253307880771781` — View hourly summaries for channel

#### Recall Output Order (v2.0)
```markdown
## User Profile
[behavioral observations]

---

## Relevant Memories
[semantic search results from QMD]

---

## Recent Conversation (last 12h)
[full transcript turns, capped by maxTranscriptTurns/maxTranscriptTokens]
[10:00] User: Here's my API key...
[10:05] Assistant: Thanks, configured.
...

---

## Recent Activity (last 24h)
[hourly summaries, up to maxSummaryCount]
- 14:00: Debugged cron scheduler
- 10:00: Set up API credentials
...

---

## Workspace Context
[cross-session context from other channels if applicable]
```

#### Success Criteria
1. After compaction, agent immediately knows API key was already provided (no re-asking)
2. Can resume conversations after 4-6 hour gaps (meetings, lunch) with full context
3. Can view any conversation from past 7 days via CLI
4. Hourly summaries provide coherent narrative of daily activity per channel
5. No perceptible latency increase in recall (<100ms added)

---

### v2.1 — Local LLM Provider Support (LM Studio)

**Goal:** Enable privacy-preserving, cost-effective memory operations using local LLMs.

#### Overview
Support for OpenAI-compatible local endpoints (default: `http://localhost:1234/v1`) via LM Studio, Ollama, or similar. Provides fallback to OpenAI when local LLM is unavailable.

#### Model Recommendations

| Task | Recommended Model | Rationale |
|------|-------------------|-----------|
| **Extraction** | qwen3-coder-30b | Excellent structured output adherence, fast inference |
| **Contradiction Detection** | qwq-32b | Strong reasoning capabilities for comparing facts |
| **Hourly Summaries** | phi-4 | Fast, efficient summarization with good coherence |

#### New Configuration Options
```typescript
// Local LLM provider
localLlmEnabled: boolean;            // default: false
localLlmUrl: string;                 // default: "http://localhost:1234/v1"
localLlmModel: string;               // default: "local-model" (LM Studio auto-detects)
localLlmFallback: boolean;           // default: true - fallback to OpenAI if local fails
```

#### Implementation Notes
- Uses OpenAI-compatible `/chat/completions` endpoint
- Supports streaming responses for real-time feedback
- Automatic health check on startup to detect availability
- Per-operation fallback: if local LLM fails, retry with configured cloud provider
- Token counting may be estimated when local model doesn't return usage stats

#### Success Criteria
1. Extraction works offline with local LLM (no OpenAI calls)
2. Graceful degradation when local LLM is stopped mid-operation
3. No perceptible quality loss for routine extractions
4. Latency under 2 seconds for extraction with qwen3-coder-30b

---

### v2.2 — Advanced Retrieval

**Goal:** Improve memory relevance and reduce noise in recall.

- **Query Expansion**: Expand user prompt with synonyms and related terms before search
- **Memory Re-ranking**: Cross-encoder reranking of top-K QMD results
- **Negative Examples**: Track what memories were retrieved but not useful
- **Feedback Loop**: User thumbs up/down on memory relevance

---

### v2.3 — Memory Import & Export

**Goal:** Enable data portability and backup.

- **Export**: Export memories to JSON, Markdown, or SQLite
- **Import**: Import from other memory systems (mem0, CLAWS, etc.)
- **Backup**: Automated daily backups to configured directory
- **Migration Tools**: Re-extract memories with improved prompts

---

### v3.0 — Multi-Agent Memory

**Goal:** Share memories across multiple agents with access control.

- **Memory Namespaces**: Per-agent, shared, and public namespaces
- **Access Control**: Read/write permissions per namespace
- **Agent-Specific Profiles**: Different agents see different profile sections
- **Cross-Agent Learning**: Learn from other agents' interactions

---

## Deferred Ideas

These ideas are noted but not currently planned:

- **Real-time Sync**: Multi-device memory sync (conflicts with local-first philosophy)
- **Image Memory**: Extract and search memories from images
- **Audio Memory**: Transcribe and index voice conversations
- **Third-Party Integrations**: Direct sync with Notion, Obsidian, etc.

---

## Versioning Policy

- **Major (X.0.0)**: Breaking changes to storage format or API
- **Minor (x.Y.0)**: New features, backward compatible
- **Patch (x.y.Z)**: Bug fixes, documentation updates

---

*Maintained by: openclaw-engram maintainers*
*Changelog: See CHANGELOG.md for detailed release notes*
