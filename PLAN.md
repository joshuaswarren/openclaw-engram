# OpenClaw Engram Roadmap

**Current Version:** 2.2.2
**Last Updated:** 2026-02-10

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

### v2.0.0 — Transcript & Context Preservation (2026-02-08)
- **Transcript Archive**: Full conversation history stored in JSONL with 7-day retention
- **Transcript Injection**: Recent conversation context (12h) automatically injected into recall
- **Compaction Checkpoint**: Pre-compaction state capture for seamless session recovery
- **Hourly Summaries**: Per-channel narrative summaries of conversation activity
- **Auto-registered Cron**: Hourly summary generation at random minute to avoid thundering herd

### v2.1.0 — Local LLM Provider Support (2026-02-08)
- **Local LLM Client**: Auto-detection of LM Studio, Ollama, MLX, vLLM
- **Fallback Support**: Graceful degradation to gateway's default AI when local LLM unavailable
- **Extraction via Local LLM**: Memory extraction using local models (qwen3-coder-30b recommended)
- **Summarization via Local LLM**: Hourly summaries using local models (phi-4 recommended)
- **Configurable Endpoints**: Custom URL and model name support
- **Multi-Provider Fallback**: Supports OpenAI, Anthropic, and any OpenAI-compatible API configured in openclaw.json
- **Hard Timeout**: Configurable `localLlmTimeoutMs` (default 180s) to prevent stalls
- **Slow Query Log**: `slowLogEnabled` + `slowLogThresholdMs` for debugging long local/QMD operations
- **Safer Logging Defaults**: No request-body previews at info level; reduced noisy startup output

### v2.2.0 — Advanced Retrieval (2026-02-10)
- **Heuristic Query Expansion**: Optional expanded queries (no LLM calls) to improve recall coverage
- **LLM Re-ranking**: Optional, timeboxed local-only rerank of top candidates (fail-open)
- **Feedback Loop**: Optional thumbs up/down tool (`memory_feedback`) stored locally and applied as a soft bias

---

## Planned Features

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
