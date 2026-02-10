# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [2.1.0] - 2026-02-10

### Added
- Configurable local LLM hard timeout (`localLlmTimeoutMs`, default 180000ms) to prevent stalls.
- Optional slow query logging (`slowLogEnabled`, `slowLogThresholdMs`) for local LLM + QMD operations (metadata only; never logs content).

### Changed
- Reduced default log verbosity for local LLM model listings.
- QMD failures now include a concise error string and are backoff-suppressed.

### Fixed
- Model context budgeting now clamps output/input to avoid negative input budgets.
- TypeScript typecheck/build issues across CLI, extraction salvage, and plugin SDK typings.

## [1.2.0] - 2026-02-07

### Added
- **Access Tracking (Phase 1A)**: Track memory access counts and recency
  - New frontmatter fields: `accessCount`, `lastAccessed`
  - Batched updates flushed during consolidation (zero retrieval latency)
  - Configurable via `accessTrackingEnabled`, `accessTrackingBufferMaxSize`
- **Local Importance Scoring (Phase 1B)**: Zero-LLM heuristic importance
  - New `importance` field with score (0-1), level, reasons, keywords
  - Pattern-based scoring for critical/high/normal/low/trivial content
  - Category-based boosts (corrections +0.15, principles +0.12, etc.)
  - Keyword extraction for improved search relevance
  - Importance used for ranking boost, not exclusion (quality safeguard)
- **Recency Boosting**: Recent memories ranked higher in search results
  - Configurable `recencyWeight` (0-1, default 0.2)
  - Exponential decay with 7-day half-life
- **Access Count Boosting**: Frequently accessed memories surface higher
  - Log-scale boost capped at 0.1 to prevent runaway effects
  - Configurable via `boostAccessCount`
- **Status Field**: New `status` field for lifecycle management
  - Values: `active` (default), `superseded`, `archived`
  - Non-active memories filtered from default retrieval
- CLI: `engram access` - Show top accessed memories with stats
- CLI: `engram flush-access` - Manually flush access tracking buffer
- CLI: `engram importance` - Show importance distribution and top memories
- **Automatic Chunking (Phase 2A)**: Sentence-boundary chunking for long memories
  - New frontmatter fields: `parentId`, `chunkIndex`, `chunkTotal`
  - Sentence-boundary splitting preserves coherent thoughts
  - Configurable target tokens (default 200) and overlap (default 2 sentences)
  - Skip chunking for short memories (< 150 tokens)
  - Each chunk scored separately for importance
  - Disabled by default, enable with `chunkingEnabled: true`
- CLI: `engram chunks` - Show chunking statistics and orphaned chunks
- **Contradiction Detection (Phase 2B)**: LLM-verified contradiction resolution
  - QMD similarity search finds candidates (fast, cheap)
  - LLM verifies actual contradiction (prevents false positives)
  - Auto-resolve when confidence > 0.9 (configurable)
  - Full audit trail via `status: superseded` and correction entries
  - Disabled by default, enable with `contradictionDetectionEnabled: true`
- **Memory Linking (Phase 3A)**: Build knowledge graph between memories
  - Link types: follows, references, contradicts, supports, related
  - LLM suggests links during extraction
  - Links stored in frontmatter for graph traversal
  - Disabled by default, enable with `memoryLinkingEnabled: true`
- **Conversation Threading (Phase 3B)**: Group memories into threads
  - Auto-detect thread boundaries (session change or 30min gap)
  - Auto-generate thread titles from top keywords
  - Track episode IDs and linked threads
  - Threads stored in `threads/` directory
  - Disabled by default, enable with `threadingEnabled: true`
- CLI: `engram threads` - List conversation threads
- **Memory Summarization (Phase 4A)**: Compress old memories into summaries
  - Triggered when memory count exceeds threshold (default 1000)
  - Keeps recent memories uncompressed (default 300)
  - Protects important memories (by importance score, tags, entityRef)
  - Archives source memories (status: archived), not deleted
  - Summaries stored in `summaries/` directory
  - Disabled by default, enable with `summarizationEnabled: true`
- **Topic Extraction (Phase 4B)**: TF-IDF topic analysis
  - Extracts top topics from memory corpus
  - Runs during consolidation (batch process)
  - Topics stored in `state/topics.json`
  - Enabled by default
- CLI: `engram topics` - Show extracted topics
- CLI: `engram summaries` - Show memory summaries

### Changed
- Retrieval now filters out non-active memories by default
- Plan updated to v1.2 with quality safeguards

## [1.1.0] - 2026-02-07

### Added
- LLM trace callback system (`LlmTraceEvent`) for external observability plugins
- Expose orchestrator via `globalThis.__openclawEngramOrchestrator` for inter-plugin discovery
- Token usage reporting on all LLM calls
- CHANGELOG.md

### Changed
- Entity extraction now injects known entity names to reduce fragmentation
- Fuzzy entity matching prevents duplicate entity files
- Profile dedup uses normalized string comparison instead of exact match
- Entity aliases moved from hardcoded source to configurable `config/aliases.json`
- All code examples use generic placeholders (no personal data)

## [1.0.0] - 2026-02-05

### Added
- Initial release: GPT-5.2 extraction, QMD hybrid search, markdown storage
- 10 memory categories: fact, preference, correction, entity, decision, relationship, principle, commitment, moment, skill
- Question generation and identity reflections
- Profile and identity auto-consolidation
- CLI tools for search, store, profile, entities, questions, identity
