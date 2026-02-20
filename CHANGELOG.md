# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- npm-first distribution + release automation:
  - New `Release and Publish` workflow (`.github/workflows/release-and-publish.yml`) that runs on `main` merges, verifies quality gates, bumps patch version, tags, creates GitHub release, and publishes to npm (when `NPM_TOKEN` is configured).
  - Package publish metadata in `package.json`: `engines.node`, `prepack`, and `publishConfig` (`access: public`, `provenance: true`).
- Contributor onboarding and contribution governance docs:
  - New `CONTRIBUTING.md` with standards for issues/PRs, testing, changelog policy, and AI-assisted contributions.
  - New `CONTRIBUTORS.md` with contributor recognition, including the first community contributors.
  - New GitHub issue templates for bug reports and feature requests.
  - New pull request template with validation and risk checklist.
- Changelog/release process automation:
  - `Changelog Guard` workflow requiring `CHANGELOG.md` updates for source/config/plugin changes (with `skip-changelog` maintainer bypass label).
  - `Release Drafter` workflow + config for automated draft release notes from merged PRs.
  - `Release Drafter` now also runs on `pull_request_target` so autolabeler rules apply during PR review.
  - `Review Thread Guard` workflow that fails PR checks when active review threads are unresolved.
  - Release Drafter autolabeling adjusted so `src/**` changes no longer auto-label as `feature` (avoids accidental minor version bumps for fixes/refactors).
- GitHub Actions quality and security checks for pull requests:
  - `CI` (typecheck, tests, build on Node 22)
  - `Dependency Review` (blocks high+ severity dependency risks)
  - `Secret Scan` (Gitleaks on PRs and main pushes)
  - `CodeQL` analysis (PR + weekly schedule)
- `AI Review Gate` workflow requiring review activity from KiloConnect, Codex, and Cursor Bugbot bot groups before merge.
- v2.3 portability:
  - CLI: `openclaw engram export|import|backup` (json/md/sqlite bundles)
  - Format autodetection on import (`--format auto`)
  - Namespace-aware CLI surface (`--namespace <ns>`) when namespaces are enabled
- v2.4 context retention hardening:
  - Optional structured hourly summaries (`hourlySummariesExtendedEnabled`)
  - Optional tool usage stats capture for summaries (`hourlySummariesIncludeToolStats`)
  - Optional conversation chunk indexing + semantic recall injection (`conversationIndexEnabled`)
  - Tool: `conversation_index_update`
- v3.0 multi-agent memory (namespaces):
  - Principal resolution from `sessionKey`
  - Namespace-scoped profile storage (when enabled)
  - Tool: `memory_promote`
- v4.0 cross-agent shared intelligence (shared-context):
  - Shared-context injection (priorities + latest roundtable)
  - Tools: `shared_context_write_output`, `shared_priorities_append`, `shared_feedback_record`, `shared_context_curate_daily`
- v5.0 compounding engine:
  - Weekly synthesis output + mistakes file
  - Tool: `compounding_weekly_synthesize`
- Reliability guardrails (P0/P1):
  - Extraction dedupe window + minimum extraction thresholds
  - Per-run extraction caps (facts/entities/questions/profile updates)
  - Consolidation cooldown + non-zero gating
  - Debounced/singleflight QMD maintenance worker
  - Local LLM resilience knobs (bounded 5xx retries, 400 trip threshold + cooldown)
- Path override knobs for non-committed local installs:
  - Config: `localLlmHomeDir`, `localLmsCliPath`, `localLmsBinDir`
  - Env: `OPENCLAW_ENGRAM_CONFIG_PATH` (fallback `OPENCLAW_CONFIG_PATH`) for bootstrap config path

### Changed
- Installation docs now lead with `openclaw plugins install openclaw-engram --pin` and move git clone/build to a developer-only path.
- `agent_end` ingestion now ignores non-`user`/`assistant` message roles for extraction to avoid tool-output memory churn.
- Extractions with no durable outputs skip persistence/log churn paths.

## [7.2.1] - 2026-02-19

### Added
- Third-party OpenAI-compatible extraction endpoint support settings:
  - `localLlmApiKey`, `localLlmHeaders`, `localLlmAuthHeader`
  - `qmdPath` override for explicit QMD binary pathing
- Plugin schema + UI hints for the settings above in `openclaw.plugin.json`.
- Regression tests for local LLM abort handling/retry behavior.

### Changed
- Local LLM requests now include operation-aware diagnostics (`op=...`) in timeout/error logs for faster incident triage.
- Extraction/profile/identity/consolidation/hourly-summary/entity-summary local calls now pass explicit operation names for attributed logs.

### Fixed
- Local LLM abort timeouts are now treated as transient: retry with backoff and do not mark local endpoint unavailable immediately.
- Added gateway fallback paths for consolidation/profile/identity JSON parsing when local LLM fails, reducing dropped maintenance passes.

## [2.2.2] - 2026-02-10

### Added
- Negative examples (retrieved-but-not-useful) feedback loop (opt-in):
  - Config: `negativeExamplesEnabled`, `negativeExamplesPenaltyPerHit`, `negativeExamplesPenaltyCap`
  - Storage: `memoryDir/state/negative_examples.json`
- Last recall snapshot + impression log for debugging/feedback workflows:
  - Storage: `memoryDir/state/last_recall.json`, `memoryDir/state/recall_impressions.jsonl`
  - Tools: `memory_last_recall`, `memory_feedback_last_recall`

### Changed
- Signal scan now treats phrases like "that's not right" / "why did you say that" as high-signal (more likely to extract corrections).

## [2.2.3] - 2026-02-10

### Added
- Disagreement heuristic (suggestion-only): when the user pushes back ("that's not right", "why did you say that"), Engram injects a short helper section encouraging use of `memory_last_recall` and (optionally) `memory_feedback_last_recall`.

### Changed
- No auto-marking: this heuristic never records negative examples automatically.

## [2.2.4] - 2026-02-11

### Fixed
- Prevented background extraction crashes when local LLM entity output omits or malforms `entities[].facts` (defensive sanitation + persistence hardening).

### Changed
- Hourly summary cron auto-registration (when used) now targets `sessionTarget: "isolated"` with `payload.kind: "agentTurn"` instead of `main/toolCall` (which can be rejected by cron validation in some installs).

## [2.3.0] - 2026-02-13

### Added
- Optional file hygiene (off by default):
  - Lint selected workspace markdown files (e.g. `IDENTITY.md`, `MEMORY.md`) and warn before truncation risk.
  - Rotate oversized markdown files into `archiveDir`, replacing the original with a lean index plus a small tail excerpt.
  - Config: `fileHygiene.*`

## [2.2.5] - 2026-02-13

### Fixed
- Reduced background extraction crashes by defensively skipping malformed entity payloads (no `toLowerCase` on undefined).
- Improved structured JSON extraction from LLM outputs when responses contain multiple JSON blocks (example + real answer).
- Reduced QMD update/embed flakiness by serializing QMD CLI calls within the process and retrying on transient SQLite lock errors (logs also truncate huge stderr output).

## [2.2.1] - 2026-02-10

### Changed
- Documentation clarified: `rerankProvider: "cloud"` is reserved/experimental and currently treated as a no-op.

## [2.2.0] - 2026-02-10

### Added
- Advanced retrieval controls (disabled by default):
  - Heuristic query expansion (`queryExpansionEnabled`, `queryExpansionMaxQueries`, `queryExpansionMinTokenLen`)
  - Optional LLM re-ranking (`rerankEnabled`, `rerankProvider`, `rerankMaxCandidates`, `rerankTimeoutMs`, caching)
  - Optional feedback capture tool (`feedbackEnabled`, `memory_feedback`) stored locally and applied as a soft ranking bias
- Documentation: `docs/advanced-retrieval.md`

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
