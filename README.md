# openclaw-engram

A local-first memory plugin for [OpenClaw](https://github.com/openclaw/openclaw) that gives AI agents persistent, searchable long-term memory across conversations.

Engram uses **LLM-powered extraction** (OpenAI Responses API) to intelligently identify what's worth remembering from each conversation, stores memories as plain **markdown files** on disk, and retrieves relevant context via **[QMD](https://github.com/tobi/qmd)** hybrid search (BM25 + vector + reranking).

## Why Engram?

Most AI memory systems are either too noisy (store everything) or too lossy (store nothing useful). Engram takes a different approach:

- **Signal detection first** -- A fast local regex scan classifies each turn before any API call happens. High-signal turns (corrections, preferences, identity statements) trigger immediate extraction; low-signal turns are batched.
- **Structured extraction** -- An LLM analyzes buffered turns and extracts typed memories (facts, preferences, corrections, entities, decisions, relationships, principles, commitments, moments, skills) with confidence scores.
- **Automatic consolidation** -- Periodic consolidation passes merge duplicates, update entity profiles, refresh the behavioral profile, and expire stale memories.
- **Local-first storage** -- All memories are plain markdown files with YAML frontmatter. No database, no vendor lock-in. Grep them, version them, back them up however you like.
- **Privacy by default** -- Memories never leave your machine unless you choose to sync them. The LLM extraction call is the only external API call.

## Features

### Core Features
- **10 memory categories**: fact, preference, correction, entity, decision, relationship, principle, commitment, moment, skill
- **Confidence tiers**: explicit (0.95-1.0), implied (0.70-0.94), inferred (0.40-0.69), speculative (0.00-0.39)
- **TTL on speculative memories**: Auto-expire after 30 days if unconfirmed
- **Lineage tracking**: Memories track their parent IDs through consolidation merges and updates
- **Entity profiles**: Accumulates facts about people, projects, tools, and companies into per-entity files, with automatic name normalization and periodic deduplication
- **Behavioral profile**: A living `profile.md` that evolves as the system learns about the user, with automatic cap and pruning to control token usage
- **Identity reflection**: Optional self-reflection that helps the agent improve over sessions
- **Question generation**: Generates 1-3 curiosity questions per extraction to drive deeper engagement
- **Commitment lifecycle**: Tracks promises and deadlines with configurable decay (default 90 days)
- **Auto-consolidation**: IDENTITY.md reflections are automatically summarized when they exceed 8KB
- **Smart buffer**: Configurable trigger logic (signal-based, turn count, or time-based)
- **QMD integration**: Hybrid search with BM25, vector embeddings, and reranking
- **Graceful degradation**: Works without QMD (falls back to direct file reads) and without an API key (retrieval-only mode)
- **Portability**: Import/export/backup your memory store via CLI (v2.3)
- **CLI**: Search, inspect, and manage memories from the command line
- **Agent tools**: `memory_search`, `memory_store`, `memory_profile`, `memory_entities`, `memory_promote`

### v1.2.0 Advanced Features

All advanced features are **disabled by default** for gradual adoption. Enable them in your config as needed.

#### Importance Scoring (Zero-LLM)
- **Local heuristic scoring** at extraction time — no API calls
- Five tiers: `critical` (0.9-1.0), `high` (0.7-0.9), `normal` (0.4-0.7), `low` (0.2-0.4), `trivial` (0.0-0.2)
- Scores based on: explicit importance markers, personal info, instructions, emotional content, factual density
- Extracts salient keywords for improved search relevance
- Used for **ranking** (not exclusion) — all memories are still stored and searchable

#### Access Tracking
- Tracks `accessCount` and `lastAccessed` for each memory
- Batched updates during consolidation (zero retrieval latency impact)
- Enables "working set" prioritization — frequently accessed memories surface higher
- CLI: `openclaw engram access` to view most accessed memories

#### Recency Boosting
- Recent memories ranked higher in search results
- Configurable weight (0-1, default 0.2)
- Exponential decay with 7-day half-life

#### Automatic Chunking
- Sentence-boundary splitting for long memories (>150 tokens)
- Target ~200 tokens per chunk with 2-sentence overlap
- Each chunk maintains `parentId` and `chunkIndex` for context reconstruction
- Preserves coherent thoughts — never splits mid-sentence

#### Contradiction Detection
- QMD similarity search finds candidate conflicts (fast, cheap)
- LLM verification confirms actual contradictions (prevents false positives)
- Auto-resolve when confidence > 0.9
- Full audit trail: old memory marked `status: superseded` with `supersededBy` link
- Nothing is deleted — superseded memories remain searchable explicitly

#### Memory Linking (Knowledge Graph)
- Typed relationships: `follows`, `references`, `contradicts`, `supports`, `related`
- LLM suggests links during extraction based on semantic connections
- Links stored in frontmatter with strength scores (0-1)
- Enables graph traversal between related memories

#### Conversation Threading
- Auto-detect thread boundaries (session change or 30-minute gap)
- Auto-generate thread titles from top TF-IDF keywords
- Group memories into conversation threads for context reconstruction
- CLI: `openclaw engram threads` to view threads

#### Memory Summarization
- Triggered when memory count exceeds threshold (default 1000)
- Compresses old, low-importance, unprotected memories into summaries
- **Archive, not delete** — source memories marked `status: archived`, still searchable
- Protected: recent memories, high-importance, entities, commitments/preferences/decisions
- Summaries stored in `summaries/` directory

#### Topic Extraction
- TF-IDF analysis of the entire memory corpus
- Extracts top N topics (default 50) during consolidation
- Stored in `state/topics.json`
- CLI: `openclaw engram topics` to view extracted topics

### v2.2 Advanced Retrieval

All v2.2 retrieval features are **disabled by default**. Enable them only if you can tolerate a small latency increase.

- **Heuristic query expansion** (`queryExpansionEnabled`): Runs a few deterministic, cheap expanded queries (no LLM calls) and merges results.
- **LLM re-ranking** (`rerankEnabled`): Re-scores the top N retrieved memories using a short, timeboxed request.
  - Default mode: **local-only** (`rerankProvider: "local"`), fail-open on errors/timeouts.
- **Feedback loop** (`feedbackEnabled` + `memory_feedback` tool): Store thumbs up/down locally and apply it as a small ranking bias.
- **Negative examples** (`negativeExamplesEnabled` + `memory_feedback_last_recall` tool): Track retrieved-but-not-useful memories and apply a small ranking penalty.
- **Slow query log** (`slowLogEnabled` + `slowLogThresholdMs`): Logs durations and metadata (never content) for local LLM and QMD operations.

### v2.3 Import / Export / Backup

Engram supports **portable exports** and **safe backups** via CLI:

```bash
openclaw engram export --format json --out /tmp/engram-export
openclaw engram export --format sqlite --out /tmp/engram.sqlite
openclaw engram export --format md --out /tmp/engram-md

openclaw engram import --from /tmp/engram-export --format auto
openclaw engram backup --out-dir /tmp/engram-backups --retention-days 14
```

If namespaces are enabled (v3.0+), the CLI accepts `--namespace <ns>` for export/import/backup.

Details: `docs/import-export.md`

### v2.4 Context Retention Hardening

- **Extended hourly summaries** (structured topics/decisions/action items/rejections) are optional:
  - Config: `hourlySummariesExtendedEnabled`, `hourlySummariesIncludeToolStats`
- **Conversation semantic recall hook** (optional): index transcript chunks and inject top-K relevant past chunks:
  - Config: `conversationIndexEnabled`, `conversationIndexQmdCollection`, `conversationRecallTopK`, `conversationIndexMinUpdateIntervalMs`, `conversationIndexEmbedOnUpdate`
  - Tool: `conversation_index_update` (optional `embed: true` override)

Details: `docs/context-retention.md`

### v3.0 Namespaces (Multi-Agent Memory)

Optional namespaces let multiple agents share a memory store with isolation:

- Config: `namespacesEnabled`, `defaultNamespace`, `sharedNamespace`, `namespacePolicies`
- Tooling: `memory_store` supports `namespace`; `memory_promote` copies curated items into the shared namespace.

Details: `docs/namespaces.md`

### v4.0 Shared Context (Cross-Agent Shared Intelligence)

Optional shared-context is a **file-based shared brain** (priorities, agent outputs, feedback, roundtables):

- Config: `sharedContextEnabled`, `sharedContextDir`, `sharedContextMaxInjectChars`
- Tools: `shared_context_write_output`, `shared_priorities_append`, `shared_feedback_record`, `shared_context_curate_daily`

Details: `docs/shared-context.md`

### v5.0 Compounding Engine

Optional compounding turns shared feedback into persistent learning:

- Writes: `memoryDir/compounding/weekly/<YYYY-Www>.md`, `memoryDir/compounding/mistakes.json`
- Tool: `compounding_weekly_synthesize`
- Injection: `compoundingInjectEnabled` (default true when compounding is enabled)

Details: `docs/compounding.md`

## Architecture

```
Conversation turn arrives
    |
    v
Signal scan (local regex, <10ms, free)
    |
    v
Append to smart buffer
    |
    v
Trigger check:
    HIGH signal? --> Extract NOW (single LLM call)
    Buffer >= N? --> Extract BATCH
    Time > T?   --> Extract BATCH
    else        --> Keep buffering
    |
    v
If extracted: write markdown files to disk
    |
    v
Every Nth extraction: Consolidation pass
    - Merge/dedup memories
    - Merge fragmented entity files
    - Update entity profiles
    - Update behavioral profile (with cap enforcement)
    - Clean expired commitments and TTL memories
    - Auto-consolidate identity reflections
    |
    v
Background: qmd update (re-index new files)
```

Performance note for conversation indexing:
- `conversation_index_update` now runs `qmd update` only by default.
- `qmd embed` is optional (`conversationIndexEmbedOnUpdate: true` or tool param `embed: true`).
- Re-indexing is min-interval gated per session (`conversationIndexMinUpdateIntervalMs`, default 15m).

### Retrieval Flow

```
Agent session starts
    |
    v
Read profile.md directly (free, instant)
    |
    v
QMD search memory collection (relevant memories)
    |
    v
QMD search global collections (workspace context)
    |
    v
Optionally inject highest-priority open question
    |
    v
Combine and inject into system prompt
```

## Hourly Summaries (Cron)

Engram can generate **hourly summaries** of conversation activity, written to disk under the configured `memoryDir` summaries folder.

In most installs, the safest setup is to drive this via OpenClaw cron using an **agent turn** (not a tool call directly):
- `sessionTarget: "isolated"`
- `payload.kind: "agentTurn"` that calls `memory_summarize_hourly`
- `delivery.mode: "none"` (so it never posts to Discord)

Why: some OpenClaw installations restrict `sessionTarget: "main"` to `payload.kind: "systemEvent"` only. If you configure `main` + `toolCall`, it may be repeatedly skipped and summaries will silently stop.

## Storage Layout

All memories are stored as markdown files with YAML frontmatter:

```
~/.openclaw/workspace/memory/local/
├── profile.md                  # Living behavioral profile (auto-updated)
├── entities/                   # One markdown file per tracked entity
│   ├── person-jane-doe.md
│   ├── project-my-app.md
│   └── tool-qmd.md
├── facts/                      # Memory entries organized by date
│   └── YYYY-MM-DD/
│       ├── fact-1738789200000-a1b2.md
│       └── preference-1738789200000-c3d4.md
├── corrections/                # High-weight correction memories
│   └── correction-1738789200000-e5f6.md
├── questions/                  # Generated curiosity questions
│   └── q-m1abc-xy.md
├── threads/                    # Conversation threads (v1.2.0)
│   └── thread-1738789200000-a1b2.json
├── summaries/                  # Memory summaries (v1.2.0)
│   └── summary-1738789200000-a1b2.json
├── config/
│   └── aliases.json            # Entity name aliases
└── state/
    ├── buffer.json             # Current unbatched turns (survives restarts)
    ├── meta.json               # Extraction count, timestamps, totals
    └── topics.json             # Extracted topics (v1.2.0)
```

### Memory File Format

Each memory file uses YAML frontmatter:

```yaml
---
id: fact-1738789200000-a1b2
category: fact
created: 2026-02-05T12:00:00.000Z
updated: 2026-02-05T12:00:00.000Z
source: extraction
confidence: 0.85
confidenceTier: implied
tags: ["tools", "preferences"]
entityRef: tool-qmd
---

QMD supports hybrid search combining BM25 and vector embeddings with reranking.
```

## Installation

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) gateway
- Node.js 20+
- An OpenAI API key (for extraction; retrieval works without one)
- [QMD](https://github.com/tobi/qmd) (optional, for hybrid search)

### Install

```bash
# Clone into the OpenClaw extensions directory
git clone https://github.com/joshuaswarren/openclaw-engram.git \
  ~/.openclaw/extensions/openclaw-engram

# Install dependencies and build
cd ~/.openclaw/extensions/openclaw-engram
npm install
npm run build
```

### Enable in OpenClaw

Add to your `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-engram"],
    "slots": {
      "memory": "openclaw-engram"
    },
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

### Set Up QMD Collection (Optional)

If you have QMD installed, add a collection pointing at the memory directory. Add to `~/.config/qmd/index.yml`:

```yaml
openclaw-engram:
  path: ~/.openclaw/workspace/memory/local
  extensions: [.md]
```

Then index:

```bash
qmd update && qmd embed
```

### Restart the Gateway

```bash
kill -USR1 $(pgrep openclaw-gateway)
```

Check the logs to confirm:

```bash
tail -f ~/.openclaw/logs/gateway.log
# Should see: [gateway] openclaw-engram: started
```

## Configuration

All settings are defined in `openclaw.json` under `plugins.entries.openclaw-engram.config`:

For a full v2.3-v5 setup (including cron and QMD conversation-index collections) and tuning guidance, see:
- `docs/setup-config-tuning.md`
- `docs/import-export.md`
- `docs/context-retention.md`
- `docs/namespaces.md`
- `docs/shared-context.md`
- `docs/compounding.md`

Bootstrap config path override (for service environments) can be set via env var:
- `OPENCLAW_ENGRAM_CONFIG_PATH=/absolute/path/to/openclaw.json`
- Fallback: `OPENCLAW_CONFIG_PATH`

### Core Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `openaiApiKey` | `(env fallback)` | OpenAI API key or `${ENV_VAR}` reference |
| `model` | `gpt-5.2` | OpenAI model for extraction/consolidation |
| `reasoningEffort` | `low` | Reasoning effort: `none`, `low`, `medium`, `high` |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | Memory storage directory |
| `workspaceDir` | `~/.openclaw/workspace` | Workspace directory (for IDENTITY.md) |
| `debug` | `false` | Enable debug logging |

### File Hygiene (Memory File Limits / Truncation Risk)

OpenClaw may bootstrap workspace markdown files (for example `IDENTITY.md`, `MEMORY.md`) into the prompt on every message.
If those files become large, they can be silently truncated by the gateway's bootstrap budget, which causes "memory loss" without an explicit error.

Engram can optionally:
- Lint selected workspace files and warn when they are approaching a configured size budget.
- Rotate oversized markdown files into an archive directory, replacing the original with a lean index plus a small tail excerpt for continuity.

This is **off by default** because it can modify workspace files.

Example config:

```json
{
  "fileHygiene": {
    "enabled": true,
    "lintEnabled": true,
    "lintPaths": ["IDENTITY.md", "MEMORY.md"],
    "lintBudgetBytes": 20000,
    "lintWarnRatio": 0.8,
    "rotateEnabled": true,
    "rotatePaths": ["IDENTITY.md"],
    "rotateMaxBytes": 18000,
    "rotateKeepTailChars": 2000,
    "archiveDir": ".engram-archive",
    "runMinIntervalMs": 300000,
    "warningsLogEnabled": false
  }
}
```

### Buffer & Trigger Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `triggerMode` | `smart` | `smart`, `every_n`, or `time_based` |
| `bufferMaxTurns` | `5` | Max buffered turns before forced extraction |
| `bufferMaxMinutes` | `15` | Max minutes before forced extraction |
| `highSignalPatterns` | `[]` | Custom regex patterns for immediate extraction |
| `consolidateEveryN` | `3` | Run consolidation every N extractions |

### Retrieval Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `maxMemoryTokens` | `2000` | Max tokens injected into system prompt |
| `qmdEnabled` | `true` | Use QMD for hybrid search |
| `qmdCollection` | `openclaw-engram` | QMD collection name |
| `qmdMaxResults` | `8` | Max QMD results per search |

### V2 Feature Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `identityEnabled` | `true` | Enable agent identity reflections |
| `injectQuestions` | `false` | Inject open questions into the system prompt |
| `commitmentDecayDays` | `90` | Days before fulfilled/expired commitments are removed |

### v2.2 Advanced Retrieval Settings

See `docs/advanced-retrieval.md` for details and recommended safe defaults.

| Setting | Default | Description |
|---------|---------|-------------|
| `queryExpansionEnabled` | `false` | Heuristic query expansion (no LLM calls) |
| `queryExpansionMaxQueries` | `4` | Max expanded queries (including original) |
| `queryExpansionMinTokenLen` | `3` | Minimum token length for expansion |
| `rerankEnabled` | `false` | Enable LLM re-ranking (timeboxed; fail-open) |
| `rerankProvider` | `local` | `local` (no cloud calls). `cloud` is reserved/experimental (no-op in v2.2.0). |
| `rerankMaxCandidates` | `20` | Max candidates sent to re-ranker |
| `rerankTimeoutMs` | `8000` | Rerank timeout (ms) |
| `rerankCacheEnabled` | `true` | Cache reranks in-memory |
| `rerankCacheTtlMs` | `3600000` | Rerank cache TTL (ms) |
| `feedbackEnabled` | `false` | Enable `memory_feedback` tool and ranking bias |
| `negativeExamplesEnabled` | `false` | Enable negative examples + ranking penalty (opt-in) |
| `negativeExamplesPenaltyPerHit` | `0.05` | Penalty per "not useful" hit |
| `negativeExamplesPenaltyCap` | `0.25` | Maximum total penalty applied |
| `localLlmHomeDir` | `(auto)` | Optional home directory override for LM Studio settings + helper paths |
| `localLmsCliPath` | `(auto)` | Optional absolute path to `lms` CLI |
| `localLmsBinDir` | `(auto)` | Optional bin dir prepended to PATH for `lms` execution |

### v1.2.0 Advanced Feature Settings

#### Access Tracking & Retrieval

| Setting | Default | Description |
|---------|---------|-------------|
| `accessTrackingEnabled` | `true` | Track memory access counts and recency |
| `accessTrackingBufferMaxSize` | `100` | Max entries in access buffer before flush |
| `recencyWeight` | `0.2` | Weight for recency boosting (0-1) |
| `boostAccessCount` | `true` | Boost frequently accessed memories in search |

#### Chunking

| Setting | Default | Description |
|---------|---------|-------------|
| `chunkingEnabled` | `false` | Enable automatic chunking of long memories |
| `chunkingTargetTokens` | `200` | Target tokens per chunk |
| `chunkingMinTokens` | `150` | Minimum tokens to trigger chunking |
| `chunkingOverlapSentences` | `2` | Number of sentences to overlap between chunks |

#### Contradiction Detection

| Setting | Default | Description |
|---------|---------|-------------|
| `contradictionDetectionEnabled` | `false` | Enable LLM-verified contradiction detection |
| `contradictionSimilarityThreshold` | `0.7` | QMD similarity threshold to trigger check |
| `contradictionMinConfidence` | `0.9` | Minimum LLM confidence to auto-resolve |
| `contradictionAutoResolve` | `true` | Automatically supersede contradicted memories |

#### Memory Linking

| Setting | Default | Description |
|---------|---------|-------------|
| `memoryLinkingEnabled` | `false` | Enable automatic memory linking |

#### Conversation Threading

| Setting | Default | Description |
|---------|---------|-------------|
| `threadingEnabled` | `false` | Enable conversation threading |
| `threadingGapMinutes` | `30` | Minutes of gap to start a new thread |

#### Memory Summarization

| Setting | Default | Description |
|---------|---------|-------------|
| `summarizationEnabled` | `false` | Enable automatic memory compression |
| `summarizationTriggerCount` | `1000` | Memory count threshold to trigger |
| `summarizationRecentToKeep` | `300` | Number of recent memories to keep uncompressed |
| `summarizationImportanceThreshold` | `0.3` | Only compress memories with importance below this |
| `summarizationProtectedTags` | `["commitment", "preference", "decision", "principle"]` | Tags that protect memories from compression |

#### Topic Extraction

| Setting | Default | Description |
|---------|---------|-------------|
| `topicExtractionEnabled` | `true` | Enable topic extraction during consolidation |
| `topicExtractionTopN` | `50` | Number of top topics to extract |

### Trigger Modes

- **`smart`** (default): Extracts immediately on high-signal turns (corrections, preferences, identity statements). Batches low-signal turns until buffer-full or time-elapsed.
- **`every_n`**: Extracts every N turns. Simple and predictable.
- **`time_based`**: Extracts when `bufferMaxMinutes` elapsed since last extraction.

### API Key Configuration

The plugin resolves the OpenAI API key in this order:

1. `config.openaiApiKey` with `${VAR}` syntax -- resolved from environment
2. `config.openaiApiKey` as literal string -- used directly
3. `process.env.OPENAI_API_KEY` -- implicit fallback
4. None -- extraction disabled, retrieval-only mode (plugin still loads and serves memories)

**Gateway note:** The OpenClaw gateway runs as a launchd service with its own environment. If you use `${VAR}` syntax, make sure the variable is in the gateway's launchd plist `EnvironmentVariables`, not just your shell profile.

## Agent Tools

The plugin registers tools that agents can call during conversations:

| Tool | Description |
|------|-------------|
| `memory_search` | Search memories by query string via QMD hybrid search |
| `memory_store` | Explicitly store a memory with category, confidence, and tags |
| `memory_promote` | Promote/copy a curated memory to shared namespace (v3.0+) |
| `memory_profile` | View the current behavioral profile |
| `memory_entities` | List all tracked entities or view a specific entity's facts |
| `memory_summarize_hourly` | Generate hourly summaries |
| `conversation_index_update` | Refresh conversation chunk index (v2.4) |
| `shared_context_write_output` | Write an agent output into shared-context (v4.0) |
| `shared_priorities_append` | Append priorities proposal to inbox (v4.0) |
| `shared_feedback_record` | Record approval/rejection feedback for compounding (v4/v5) |
| `shared_context_curate_daily` | Curate daily roundtable in shared-context (v4.0) |
| `compounding_weekly_synthesize` | Build weekly compounding report + mistakes file (v5.0) |

## CLI Commands

```bash
# Core commands
openclaw engram stats                 # Memory statistics (counts, last extraction, etc.)
openclaw engram search "query"        # Search memories via QMD
openclaw engram export --format json --out /tmp/engram-export
openclaw engram import --from /tmp/engram-export --format auto
openclaw engram backup --out-dir /tmp/engram-backups --retention-days 14

# Namespace-aware (v3.0+, when namespacesEnabled=true)
openclaw engram export --format json --out /tmp/engram-shared --namespace shared
openclaw engram import --from /tmp/engram-shared --format auto --namespace shared
openclaw engram backup --out-dir /tmp/engram-backups --namespace main
openclaw engram profile               # Display the behavioral profile
openclaw engram entities              # List all tracked entities
openclaw engram entities person-name  # View specific entity details
openclaw engram questions             # List open curiosity questions
openclaw engram identity              # Show agent identity reflections

# v1.2.0 commands
openclaw engram access                # Show most accessed memories
openclaw engram access -n 30          # Show top 30 most accessed
openclaw engram flush-access          # Manually flush access tracking buffer

openclaw engram importance            # Show importance score distribution
openclaw engram importance -l high    # Filter by importance level
openclaw engram importance -n 20      # Show top 20 most important

openclaw engram chunks                # Show chunking statistics
openclaw engram chunks -p <id>        # Show chunks for a specific parent

openclaw engram threads               # List conversation threads
openclaw engram threads -t <id>       # Show details for a specific thread

openclaw engram topics                # Show extracted topics
openclaw engram topics -n 30          # Show top 30 topics

openclaw engram summaries             # Show memory summaries
openclaw engram summaries -n 10       # Show top 10 most recent summaries
```

## Migration

Import memories from existing OpenClaw memory systems:

```bash
cd ~/.openclaw/extensions/openclaw-engram

# Full migration (context files + Supermemory + Honcho)
npx tsx scripts/migrate.ts

# Preview without writing anything
npx tsx scripts/migrate.ts --dry-run

# Migrate specific sources
npx tsx scripts/migrate.ts --source=context        # Context files only
npx tsx scripts/migrate.ts --source=supermemory     # Supermemory daily logs
npx tsx scripts/migrate.ts --source=honcho          # Honcho API conclusions
```

The migration script:
- Deduplicates against existing engram memories
- Categorizes each memory (fact, preference, correction, decision)
- Writes proper frontmatter with source attribution
- Seeds `profile.md` from context files (if it doesn't exist yet)
- Prints a detailed report with counts per source

After migration, re-index QMD:

```bash
qmd update && qmd embed
```

## How It Works

### Extraction

When a trigger fires, the buffered conversation turns are sent to the OpenAI Responses API with a structured output schema (Zod). Empty or whitespace-only turns are filtered out before the API call to avoid errors. The LLM returns:

- **Facts**: Typed memories with category, content, confidence score, tags, and optional entity reference
- **Entities**: Named entities with their type and newly learned facts
- **Profile updates**: Standalone behavioral statements about the user
- **Questions**: 1-3 curiosity questions the agent wants answered in future sessions
- **Identity reflection**: A brief self-reflection on the agent's own behavior

### Consolidation

Every N extractions, a consolidation pass:

1. Compares recent memories against older ones
2. For each memory, decides: ADD, MERGE, UPDATE, INVALIDATE, or SKIP
3. MERGE and UPDATE actions track lineage (parent memory IDs)
4. Updates entity profiles and the behavioral profile
5. **Merges fragmented entity files** — entities with variant names that resolve to the same canonical form are automatically merged
6. Cleans expired commitments (fulfilled/expired + past decay period)
7. Removes TTL-expired speculative memories
8. Auto-consolidates IDENTITY.md if it exceeds 8KB

### Entity Normalization

Entity names are automatically normalized to prevent fragmentation:

- Names are lowercased and hyphenated (`BlendSupply` → `blend-supply`)
- A configurable alias table maps common variants to canonical names
- Type preferences resolve cross-type duplicates (e.g., `company` wins over `other`)
- The periodic merge pass consolidates any entities that escaped normalization

### Profile Management

The behavioral profile (`profile.md`) is injected into every agent's system prompt to provide user context. To prevent unbounded growth:

- **Smart consolidation** (threshold: 600 lines): When the profile exceeds this limit during a consolidation pass, the LLM consolidates it — merging duplicate or near-duplicate bullets, removing stale information, and preserving `##` section headers
- Consolidation targets roughly 400 lines, prioritizing quality and durability of observations
- All section structure is preserved; only redundant or superseded bullets are removed

### Confidence Tiers

| Tier | Range | Meaning | TTL |
|------|-------|---------|-----|
| Explicit | 0.95-1.0 | Direct user statement ("I prefer X") | None |
| Implied | 0.70-0.94 | Strong contextual inference | None |
| Inferred | 0.40-0.69 | Pattern recognition from limited evidence | None |
| Speculative | 0.00-0.39 | Tentative hypothesis, needs confirmation | 30 days |

## Development

```bash
# Watch mode (rebuilds on file changes)
npm run dev

# Type checking
npm run check-types

# Build for production
npm run build
```

### Project Structure

```
src/
├── index.ts          # Plugin entry point (hooks, tools, CLI registration)
├── orchestrator.ts   # Central coordinator (extraction, consolidation, retrieval)
├── extraction.ts     # OpenAI Responses API client
├── storage.ts        # File-based storage manager (markdown + YAML frontmatter)
├── buffer.ts         # Smart buffer with configurable trigger logic
├── signal.ts         # Local signal detection (regex, zero cost)
├── schemas.ts        # Zod schemas for structured LLM output
├── types.ts          # TypeScript type definitions
├── config.ts         # Config parser with env var resolution
├── qmd.ts            # QMD CLI client (search, update, collection management)
├── tools.ts          # Agent tool definitions
├── cli.ts            # CLI subcommand definitions
├── logger.ts         # Logging utilities
├── chunking.ts       # [v1.2.0] Sentence-boundary chunking for long memories
├── importance.ts     # [v1.2.0] Zero-LLM heuristic importance scoring
├── threading.ts      # [v1.2.0] Conversation threading with TF-IDF titles
└── topics.ts         # [v1.2.0] TF-IDF topic extraction across corpus
scripts/
└── migrate.ts        # Migration from Honcho, Supermemory, context files
```

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

**Important:** This is a public repository. Never commit personal data, API keys, memory content, or user-specific configuration. See [CLAUDE.md](CLAUDE.md) for the full privacy policy.

## License

MIT
