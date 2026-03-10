# Config Reference

All settings live in `openclaw.json` under `plugins.entries.openclaw-engram.config`.

## Core

| Setting | Default | Description |
|---------|---------|-------------|
| `openaiApiKey` | `(env fallback)` | OpenAI API key or `${ENV_VAR}` reference |
| `openaiBaseUrl` | `(env fallback)` | Override OpenAI API base URL (e.g. for proxies or compatible endpoints); falls back to `OPENAI_BASE_URL` env var |
| `model` | `gpt-5.2` | OpenAI model for extraction and consolidation |
| `reasoningEffort` | `low` | `none`, `low`, `medium`, `high` |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | Memory storage root |
| `workspaceDir` | `~/.openclaw/workspace` | Workspace root (IDENTITY.md location) |
| `debug` | `false` | Enable debug logging |

## Memory OS Presets

| Setting | Default | Description |
|---------|---------|-------------|
| `memoryOsPreset` | `(unset)` | Optional advanced preset: `conservative`, `balanced`, `research-max`, or `local-llm-heavy`. Preset values seed the advanced config surface before explicit per-setting overrides are applied. |

Preset intent:

- `conservative` keeps recall budgets lower and leaves experimental learning/graph features off.
- `balanced` enables the recommended indexing, artifact, and rerank defaults without turning on the higher-churn learning loops.
- `research-max` enables the broadest shipped experimental surface, including graph recall and adaptive policy loops.
- `local-llm-heavy` biases extraction/rerank/tooling toward local OpenAI-compatible endpoints and the fast local tier.

Backward compatibility note:

- `memoryOsPreset: "research"` is accepted as an alias for `research-max`, but new configs should use `research-max`.

## Access Layer

| Setting | Default | Description |
|---------|---------|-------------|
| `agentAccessHttp.enabled` | `false` | Start a local authenticated Engram HTTP API during plugin startup |
| `agentAccessHttp.host` | `127.0.0.1` | Loopback bind host for the Engram HTTP API |
| `agentAccessHttp.port` | `4318` | Bind port for the Engram HTTP API (`0` = ephemeral port) |
| `agentAccessHttp.authToken` | `OPENCLAW_ENGRAM_ACCESS_TOKEN` | Bearer token for the local HTTP API; supports `${ENV_VAR}` references |
| `agentAccessHttp.maxBodyBytes` | `131072` | Maximum accepted JSON request body size |

When `agentAccessHttp.enabled` is on (or `openclaw engram access http-serve` is running), the same loopback server also serves the browser-based admin console shell at `/engram/ui/`. The shell is static; memory data and operator actions still require the configured bearer token over `/engram/v1/...`.

## Buffer & Triggers

| Setting | Default | Description |
|---------|---------|-------------|
| `triggerMode` | `smart` | `smart`, `every_n`, or `time_based` |
| `bufferMaxTurns` | `5` | Max buffered turns before forced extraction |
| `bufferMaxMinutes` | `15` | Max minutes before forced extraction |
| `highSignalPatterns` | `[]` | Additional regex patterns for immediate extraction |
| `consolidateEveryN` | `3` | Run consolidation every N extractions |

## Extraction Guardrails

| Setting | Default | Description |
|---------|---------|-------------|
| `extractionDedupeEnabled` | `true` | Skip extraction if the same buffer was already extracted recently |
| `extractionDedupeWindowMs` | `300000` | Dedup window in milliseconds (default 5 minutes) |
| `extractionMinChars` | `40` | Minimum buffer character count to trigger extraction |
| `extractionMinUserTurns` | `1` | Minimum user turns in buffer before extraction |
| `extractionMaxTurnChars` | `4000` | Truncate each turn to this many chars before sending to LLM |
| `extractionMaxFactsPerRun` | `12` | Cap on facts extracted per LLM call |
| `extractionMaxEntitiesPerRun` | `6` | Cap on entities extracted per LLM call |
| `extractionMaxQuestionsPerRun` | `3` | Cap on curiosity questions generated per LLM call |
| `extractionMaxProfileUpdatesPerRun` | `4` | Cap on profile update statements per LLM call |

## Search Backend (v9.0)

| Setting | Default | Description |
|---------|---------|-------------|
| `searchBackend` | `"qmd"` | Search engine to use: `"qmd"`, `"orama"`, `"lancedb"`, `"meilisearch"`, `"remote"`, `"noop"` |
| `lanceDbPath` | `{memoryDir}/lancedb` | LanceDB database directory |
| `lanceEmbeddingDimension` | `1536` | Vector dimension for LanceDB |
| `meilisearchHost` | `http://localhost:7700` | Meilisearch server URL |
| `meilisearchApiKey` | `(none)` | Meilisearch API key |
| `meilisearchTimeoutMs` | `30000` | Meilisearch request timeout |
| `meilisearchAutoIndex` | `false` | Auto-push documents to Meilisearch on update |
| `oramaDbPath` | `{memoryDir}/orama` | Orama database directory |
| `oramaEmbeddingDimension` | `1536` | Vector dimension for Orama |
| `remoteSearchBaseUrl` | `http://localhost:8181` | Remote search service URL |
| `remoteSearchApiKey` | `(none)` | Remote search API key |
| `remoteSearchTimeoutMs` | `30000` | Remote search request timeout |

See [Search Backends](search-backends.md) for detailed configuration and comparison.

## Retrieval

| Setting | Default | Description |
|---------|---------|-------------|
| `maxMemoryTokens` | `2000` | Token cap for injected memory context |
| `qmdEnabled` | `true` | Use QMD for hybrid search |
| `qmdCollection` | `openclaw-engram` | QMD collection name |
| `qmdMaxResults` | `8` | Final result cap after over-scanning and ranking (fetch size may be larger) |
| `qmdPath` | `(auto)` | Absolute path to `qmd` binary (bypasses PATH) |
| `qmdDaemonEnabled` | `true` | Prefer QMD MCP daemon for recall/search when available (lower contention); fail-open to subprocess search/hybrid paths |
| `qmdDaemonUrl` | `http://localhost:8181/mcp` | QMD daemon MCP endpoint URL |
| `qmdDaemonRecheckIntervalMs` | `60000` | Interval to re-probe daemon availability after failure |
| `embeddingFallbackEnabled` | `true` | Use embedding search when QMD is unavailable |
| `embeddingFallbackProvider` | `auto` | `auto`, `openai`, or `local` — selects embedding API for fallback |
| `recordEmptyRecallImpressions` | `false` | If `true`, write recall impression rows with empty `memoryIds` when no memory context is injected |
| `knowledgeIndexEnabled` | `true` | Inject entity/topic index into recall context |
| `knowledgeIndexMaxEntities` | `40` | Max entities included in the knowledge index |
| `knowledgeIndexMaxChars` | `4000` | Max characters of knowledge index injected |
| `entityRetrievalEnabled` | `true` | Enable entity-oriented recall hints for `who is`, `what do we know about`, and transcript-backed recent-turn pronoun follow-ups within the active recall namespace |
| `entityRetrievalMaxChars` | `2400` | Max characters injected by the entity retrieval section |
| `entityRetrievalMaxHints` | `2` | Max entity targets summarized in a single recall pass |
| `entityRetrievalMaxSupportingFacts` | `6` | Max direct-answer supporting facts/timeline snippets considered per target |
| `entityRetrievalMaxRelatedEntities` | `3` | Max related entities listed per target when confidence is high |
| `entityRetrievalRecentTurns` | `6` | Number of recent transcript turns scanned for pronoun carry-forward and short follow-up resolution |
| `recallBudgetChars` | `maxMemoryTokens * 4` | Hard cap for total assembled recall context (final safety trim before system prompt injection) |
| `recallPipeline` | `(built-in ordered defaults)` | Ordered section controls for recall assembly, including per-section caps and knobs |

### `recallPipeline` entries

`recallPipeline` is an array of section entries:

```json
{
  "id": "knowledge-index",
  "enabled": true,
  "maxChars": 3000,
  "maxEntities": 25
}
```

Supported keys:

| Key | Type | Notes |
|-----|------|-------|
| `id` | `string` | Section identifier (required) |
| `enabled` | `boolean` | Enable/disable the section |
| `maxChars` | `number \| null` | Per-section char cap (`null` = uncapped by section) |
| `maxHints` | `number` | `entity-retrieval` section only; max resolved entity targets |
| `maxSupportingFacts` | `number` | `entity-retrieval` section only; direct-answer evidence budget per target |
| `maxRelatedEntities` | `number` | `entity-retrieval` section only; related-entity cap per target |
| `consolidateTriggerLines` | `number` | `profile` section only; profile consolidation trigger line count |
| `consolidateTargetLines` | `number` | `profile` section only; consolidation target line count |
| `maxEntities` | `number` | `knowledge-index` section only; per-section entity cap |
| `maxResults` | `number` | `memories` section only; cap injected memory result count |
| `recentTurns` | `number` | `entity-retrieval` section only; transcript follow-up window |
| `maxTurns` | `number` | `transcript` section only |
| `maxTokens` | `number` | `transcript` section only |
| `lookbackHours` | `number` | `transcript` / `summaries` section only |
| `maxCount` | `number` | `summaries` section only |
| `topK` | `number` | `conversation-recall` section only |
| `timeoutMs` | `number` | `conversation-recall` section only |
| `maxPatterns` | `number` | `compounding` section only |

## Native Knowledge

| Setting | Default | Description |
|---------|---------|-------------|
| `nativeKnowledge.enabled` | `false` | Enable curated-file and adapter-backed native knowledge recall. |
| `nativeKnowledge.includeFiles` | `["IDENTITY.md","MEMORY.md"]` | Workspace-relative markdown files to chunk directly into the native knowledge recall section. |
| `nativeKnowledge.maxChunkChars` | `900` | Maximum chunk size before heading/paragraph-aware splitting. |
| `nativeKnowledge.maxResults` | `4` | Maximum native knowledge chunks injected into recall. |
| `nativeKnowledge.maxChars` | `2400` | Maximum total characters injected by the native knowledge section. |
| `nativeKnowledge.stateDir` | `state/native-knowledge` | `memoryDir`-relative directory used for backend-agnostic adapter sync state. |
| `nativeKnowledge.openclawWorkspace` | unset | Optional OpenClaw workspace adapter for bootstrap docs, handoffs, daily summaries, and automation notes. |
| `nativeKnowledge.obsidianVaults` | `[]` | Optional Obsidian vault adapters to sync into native knowledge recall. |

### `nativeKnowledge.openclawWorkspace`

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable the OpenClaw workspace artifact adapter. |
| `bootstrapFiles` | `["IDENTITY.md","MEMORY.md","USER.md"]` | Workspace-relative bootstrap docs treated as high-confidence native knowledge. |
| `handoffGlobs` | `["**/*handoff*.md","handoffs/**/*.md"]` | Workspace-relative globs used to discover handoff notes. |
| `dailySummaryGlobs` | `["**/*daily*summary*.md","summaries/**/*.md"]` | Workspace-relative globs used to discover daily summary notes. |
| `automationNoteGlobs` | `[]` | Optional workspace-relative globs for automation-written status or operating notes. |
| `workspaceDocGlobs` | `[]` | Optional workspace-relative globs for other explicitly allowlisted workspace docs. |
| `excludeGlobs` | `[]` | Additional excludes appended to the built-in safety exclusions (`.git/**`, `node_modules/**`, `dist/**`, `build/**`, `coverage/**`, `**/*.log`, `**/.env*`, `**/*.pem`, `**/*.key`). |
| `sharedSafeGlobs` | `[]` | Optional workspace-relative globs tagged as `shared_safe` when no explicit privacy class is present. |

### `nativeKnowledge.obsidianVaults` entries

Each vault entry supports:

| Key | Default | Description |
|-----|---------|-------------|
| `id` | `vault-{n}` | Stable adapter identifier used in synced metadata and recall formatting. |
| `rootDir` | required | Absolute path to the Obsidian vault root. |
| `includeGlobs` | `["**/*.md"]` | Vault-relative globs eligible for sync. |
| `excludeGlobs` | `[".obsidian/**","**/*.canvas","**/*.png","**/*.jpg","**/*.jpeg","**/*.gif","**/*.pdf"]` | Vault-relative globs excluded from sync. |
| `namespace` | unset | Default namespace assigned to synced notes from this vault. |
| `privacyClass` | unset | Operator-defined privacy classification preserved on synced note chunks. |
| `folderRules` | `[]` | Optional per-folder overrides for namespace and privacy class. Longest matching prefix wins. |
| `dailyNotePatterns` | `["YYYY-MM-DD"]` | Filename patterns used to derive a note date from the vault-relative path. |
| `materializeBacklinks` | `false` | When enabled, compute backlinks from wikilink targets and expose them in recall metadata. |

Example:

```jsonc
{
  "nativeKnowledge": {
    "enabled": true,
    "includeFiles": ["IDENTITY.md", "MEMORY.md", "TEAM.md"],
    "openclawWorkspace": {
      "enabled": true,
      "bootstrapFiles": ["IDENTITY.md", "MEMORY.md", "USER.md"],
      "handoffGlobs": ["handoffs/**/*.md"],
      "dailySummaryGlobs": ["summaries/**/*.md"],
      "automationNoteGlobs": ["automation/**/*.md"],
      "sharedSafeGlobs": ["automation/shared/**/*.md"]
    },
    "obsidianVaults": [
      {
        "id": "personal",
        "rootDir": "/Users/you/Documents/Obsidian",
        "namespace": "shared",
        "privacyClass": "private",
        "folderRules": [
          { "pathPrefix": "Projects", "namespace": "work", "privacyClass": "team" }
        ],
        "dailyNotePatterns": ["Daily/YYYY-MM-DD", "YYYY-MM-DD"],
        "materializeBacklinks": true
      }
    ]
  }
}
```

The OpenClaw workspace adapter persists incremental sync state and tombstones under `nativeKnowledge.stateDir`, preserves source kind plus date/session/workflow metadata on each chunk when derivable, and dedupes exact overlaps against `includeFiles` so enabling the adapter does not double-inject bootstrap docs.

## v8.0 Memory OS

| Setting | Default | Description |
|---------|---------|-------------|
| `recallPlannerEnabled` | `true` | Lightweight retrieve-vs-think gating |
| `recallPlannerMaxQmdResultsMinimal` | `4` | QMD cap in `minimal` recall mode |
| `memoryBoxesEnabled` | `false` | Enable Memory Box topic-windowed grouping |
| `traceWeaverEnabled` | `false` | Link recurring-topic boxes into named traces |
| `boxTimeGapMs` | `1800000` | Milliseconds of inactivity that seal an open box (default 30 min) |
| `boxTopicShiftThreshold` | `0.35` | Topic overlap below this seals the box |
| `boxMaxMemories` | `50` | Max memories before forced seal |
| `traceWeaverLookbackDays` | `7` | Days to look back for matching traces |
| `traceWeaverOverlapThreshold` | `0.4` | Minimum topic overlap to join an existing trace |
| `boxRecallDays` | `3` | Days of boxes to inject into recall context |
| `episodeNoteModeEnabled` | `false` | Classify memories as `episode` or `note` |
| `verbatimArtifactsEnabled` | `false` | Store high-confidence memories as verbatim anchors |
| `verbatimArtifactsMinConfidence` | `0.8` | Minimum confidence for artifact writes |
| `verbatimArtifactsMaxRecall` | `5` | Max artifact anchors injected per recall |
| `verbatimArtifactCategories` | `["decision","correction","principle","commitment"]` | Eligible categories |
| `intentRoutingEnabled` | `false` | Write intent metadata; boost compatible recalls |
| `intentRoutingBoost` | `0.12` | Max additive score boost from intent compatibility |

## v8.1 Temporal + Tag Indexes

| Setting | Default | Description |
|---------|---------|-------------|
| `queryAwareIndexingEnabled` | `false` | Build and maintain temporal (`state/index_time.json`) and tag (`state/index_tags.json`) indexes after each extraction. Enables score boosts for temporal queries and `#tag` tokens at recall time. |
| `queryAwareIndexingMaxCandidates` | `200` | Max candidate paths from the index prefilter (0 = no cap). |

## v8.3 Lifecycle Policy Engine

| Setting | Default | Description |
|---------|---------|-------------|
| `lifecyclePolicyEnabled` | `false` | Enable lifecycle scoring + transitions + retrieval weighting. |
| `lifecycleFilterStaleEnabled` | `false` | Filter lifecycle `stale`/`archived` candidates from retrieval before final cap (only when policy is enabled). |
| `lifecyclePromoteHeatThreshold` | `0.55` | Heat threshold for promotion toward `validated`/`active`. |
| `lifecycleStaleDecayThreshold` | `0.65` | Decay threshold to move a memory to `stale`. |
| `lifecycleArchiveDecayThreshold` | `0.85` | Decay threshold to move a memory to `archived` (non-protected categories). |
| `lifecycleProtectedCategories` | `["decision","principle","commitment","preference"]` | Categories protected from automatic archive transition. |
| `lifecycleMetricsEnabled` | `false` (auto-`true` when policy enabled unless explicitly set) | Emit lifecycle metrics snapshot at `state/lifecycle-metrics.json`. |

## v8.3 Proactive + Policy Learning Foundation

| Setting | Default | Description |
|---------|---------|-------------|
| `proactiveExtractionEnabled` | `false` | Enable proactive extraction second-pass paths (feature-gated). |
| `contextCompressionActionsEnabled` | `false` | Enable context compression action tool paths and action telemetry wiring. |
| `compressionGuidelineLearningEnabled` | `false` | Enable adaptive compression guideline learning loop. |
| `maxProactiveQuestionsPerExtraction` | `2` | Hard cap on proactive self-questions per extraction (`0` disables). |
| `maxCompressionTokensPerHour` | `1500` | Hourly token budget for compression-learning workflows (`0` disables). |

### v8.3 Tool + State Artifacts

- `context_checkpoint` tool:
  - gated by `contextCompressionActionsEnabled`
  - records append-only telemetry in `state/memory-actions.jsonl`
- `memory_action_apply` tool:
  - gated by `contextCompressionActionsEnabled`
  - records append-only action + outcome telemetry in `state/memory-actions.jsonl`
- `compressionGuidelineLearningEnabled`:
  - consolidation synthesizes/updates `state/compression-guidelines.md`
  - optimizer metadata/version state persists to `state/compression-guideline-state.json`
  - synthesis is fail-open and never blocks consolidation

### v8.13 Action-Policy Rollout Presets

Use these as operator presets for progressive rollout. All are baseline-safe when disabled.

`conservative`:

```jsonc
{
  "contextCompressionActionsEnabled": false,
  "proactiveExtractionEnabled": false,
  "compressionGuidelineLearningEnabled": false,
  "compressionGuidelineSemanticRefinementEnabled": false,
  "maxCompressionTokensPerHour": 0
}
```

`balanced`:

```jsonc
{
  "contextCompressionActionsEnabled": true,
  "proactiveExtractionEnabled": true,
  "compressionGuidelineLearningEnabled": true,
  "compressionGuidelineSemanticRefinementEnabled": false,
  "maxCompressionTokensPerHour": 1500
}
```

`research-max`:

```jsonc
{
  "contextCompressionActionsEnabled": true,
  "proactiveExtractionEnabled": true,
  "compressionGuidelineLearningEnabled": true,
  "compressionGuidelineSemanticRefinementEnabled": true,
  "compressionGuidelineSemanticTimeoutMs": 2500,
  "maxCompressionTokensPerHour": 3000
}
```

Disabled-path compatibility guarantees:
- `contextCompressionActionsEnabled=false` keeps action tooling and action-policy telemetry inactive.
- `maxCompressionTokensPerHour=0` remains a hard disable (no implicit non-zero coercion).
- `compressionGuidelineLearningEnabled=false` keeps consolidation behavior baseline-equivalent.

## Budget Mapping Notes

The original v8 roadmap listed several operator knobs that are now split across the live config surface.

| Roadmap knob | Live config surface |
|--------------|---------------------|
| `maxRecallTokens` | `maxMemoryTokens` for token budget, plus `recallBudgetChars` for final assembled-context trimming. |
| `maxRecallMs` | No single global wall-clock cap. Use stage-specific limits such as `recallPlannerTimeoutMs`, `conversationRecallTimeoutMs`, and `rerankTimeoutMs`. |
| `maxCompressionTokensPerHour` | `maxCompressionTokensPerHour` |
| `maxGraphTraversalSteps` | `maxGraphTraversalSteps` |
| `maxArtifactsPerSession` | No dedicated per-session write cap. The nearest shipped controls are `verbatimArtifactsEnabled`, `verbatimArtifactsMaxRecall`, and `verbatimArtifactCategories`. |
| `maxProactiveQuestionsPerExtraction` | `maxProactiveQuestionsPerExtraction` |
| `indexRefreshBudgetMs` | Use refresh cadence + timeout controls such as `qmdUpdateMinIntervalMs`, `qmdUpdateTimeoutMs`, and `conversationIndexMinUpdateIntervalMs`. |

## v8.14 Hot/Cold Tier Parity + Migration

| Setting | Default | Description |
|---------|---------|-------------|
| `qmdTierMigrationEnabled` | `false` | Enable value-aware migration between hot and cold QMD tiers. |
| `qmdTierDemotionMinAgeDays` | `14` | Minimum age (days) before a hot memory can be considered for demotion. |
| `qmdTierDemotionValueThreshold` | `0.35` | Value threshold at/below which hot memories are eligible for cold demotion. |
| `qmdTierPromotionValueThreshold` | `0.7` | Value threshold at/above which cold memories are eligible for hot promotion. |
| `qmdTierParityGraphEnabled` | `true` | Keep graph-assist behavior parity between hot and cold retrieval paths. |
| `qmdTierParityHiMemEnabled` | `true` | Keep HiMem episode/note handling parity between hot and cold retrieval paths. |
| `qmdTierAutoBackfillEnabled` | `false` | Enable automated cold-tier parity backfill jobs. |

## Local LLM / OpenAI-Compatible Endpoint

| Setting | Default | Description |
|---------|---------|-------------|
| `localLlmEnabled` | `false` | Enable local/compatible endpoint |
| `localLlmUrl` | `http://localhost:1234/v1` | Base URL for endpoint |
| `localLlmModel` | `local-model` | Model ID |
| `localLlmApiKey` | `(unset)` | Optional API key |
| `localLlmHeaders` | `(unset)` | Extra HTTP headers |
| `localLlmAuthHeader` | `true` | Send `Authorization: Bearer` header when key set |
| `localLlmFallback` | `true` | Fall back to gateway model chain on failure |
| `localLlmMaxContext` | `(unset)` | Override context window size |
| `localLmsCliPath` | `(auto)` | Path to `lms` CLI (LM Studio) |
| `localLmsBinDir` | `(auto)` | LM Studio binary directory |

## v2 Features

| Setting | Default | Description |
|---------|---------|-------------|
| `identityEnabled` | `true` | Enable agent identity reflections |
| `injectQuestions` | `false` | Inject open questions into system prompt |
| `commitmentDecayDays` | `90` | Days before fulfilled commitments are removed |

## v8.4 Identity Continuity

| Setting | Default | Description |
|---------|---------|-------------|
| `identityContinuityEnabled` | `false` | Enable identity continuity workflows (anchor/incidents/audits) |
| `identityInjectionMode` | `recovery_only` | Identity context injection mode: `recovery_only`, `minimal`, `full` |
| `identityMaxInjectChars` | `1200` | Maximum identity continuity characters injected into recall |
| `continuityIncidentLoggingEnabled` | `(follows identityContinuityEnabled when unset)` | Explicit override for continuity incident logging |
| `continuityAuditEnabled` | `false` | Enable continuity audit generation workflows |

## v8.5 Active Session Observer

| Setting | Default | Description |
|---------|---------|-------------|
| `sessionObserverEnabled` | `false` | Enable heartbeat observer checks for session growth-triggered extraction |
| `sessionObserverDebounceMs` | `120000` | Minimum milliseconds between observer-triggered extractions per session |
| `sessionObserverBands` | `[{maxBytes:50000,triggerDeltaBytes:6000,triggerDeltaTokens:1200}, ...]` | Size-band thresholds used to trigger observer extraction when growth exceeds configured byte/token deltas |

### v8.5 Session Integrity + Recovery Ops

Session integrity diagnostics/repair are CLI-driven and intentionally config-light:
- `openclaw engram session-check`
- `openclaw engram session-repair --dry-run|--apply`

Safety contract:
- Repair defaults to dry-run.
- `--apply` only mutates Engram-managed transcript/checkpoint artifacts.
- OpenClaw session-file mutation requires explicit `--allow-session-file-repair` plus an explicit path and still does not perform automatic pointer rewiring.

### v8.8 Live Graph Dashboard

Dashboard is an optional, separate process and not part of gateway hot-path config.

CLI defaults:
- `openclaw engram dashboard start --host 127.0.0.1 --port 4319`
- `openclaw engram dashboard status`
- `openclaw engram dashboard stop`

Operational safety:
- Bind to localhost by default.
- Explicitly choose non-loopback bind only when network controls are in place.

## v8.7 Custom Memory Routing Rules

| Setting | Default | Description |
|---------|---------|-------------|
| `routingRulesEnabled` | `false` | Enable write-time routing-rule evaluation for extracted facts |
| `routingRulesStateFile` | `state/routing-rules.json` | Relative state file path for persisted route rules |

## v2.2 Advanced Retrieval

See [advanced-retrieval.md](advanced-retrieval.md) for guidance.

| Setting | Default | Description |
|---------|---------|-------------|
| `queryExpansionEnabled` | `false` | Heuristic query expansion (no LLM calls) |
| `queryExpansionMaxQueries` | `4` | Max expanded queries including original |
| `queryExpansionMinTokenLen` | `3` | Minimum token length for expansion |
| `rerankEnabled` | `false` | LLM reranking pass over QMD/embedding results |
| `rerankProvider` | `local` | `local` only in v2.2 |
| `rerankMaxCandidates` | `20` | Max candidates sent to reranker |
| `rerankTimeoutMs` | `8000` | Rerank timeout (ms) |
| `rerankCacheEnabled` | `true` | Cache reranks in-memory |
| `rerankCacheTtlMs` | `3600000` | Rerank cache TTL (ms) |
| `feedbackEnabled` | `false` | Enable `memory_feedback` tool and ranking bias |
| `negativeExamplesEnabled` | `false` | Track and penalize not-useful recalls |
| `recencyWeight` | `0.2` | Recency weight in retrieval ranking (0–1) |
| `boostAccessCount` | `true` | Boost frequently accessed memories in ranking |
| `slowLogEnabled` | `false` | Log slow operations |
| `slowLogThresholdMs` | `30000` | Threshold for slow log entries (ms) |

## v2.4 Context Retention

| Setting | Default | Description |
|---------|---------|-------------|
| `checkpointEnabled` | `true` | Save a working-context checkpoint after each turn for recovery |
| `checkpointTurns` | `15` | Number of recent turns included in checkpoint context |
| `transcriptEnabled` | `true` | Save conversation transcripts to disk |
| `transcriptRetentionDays` | `7` | Days to retain saved transcripts |
| `transcriptSkipChannelTypes` | `["cron"]` | Channel types whose transcripts are not saved |
| `transcriptRecallHours` | `12` | Hours of transcript history to include in recall context |
| `maxTranscriptTurns` | `50` | Max turns of transcript context to inject |
| `maxTranscriptTokens` | `1000` | Token budget cap for transcript recall formatting |
| `hourlySummariesEnabled` | `true` | Generate hourly summaries of conversation activity |
| `hourlySummaryCronAutoRegister` | `false` | Auto-register hourly summary cron job on gateway start |
| `hourlySummariesExtendedEnabled` | `false` | Structured topics/decisions in hourly summaries |
| `hourlySummariesIncludeToolStats` | `false` | Include tool usage stats in summaries |
| `conversationIndexEnabled` | `false` | Index transcript chunks for semantic recall |
| `conversationIndexBackend` | `qmd` | Conversation index backend (`qmd` for QMD collections, `faiss` for the bundled local sidecar) |
| `conversationIndexQmdCollection` | `openclaw-engram-conversations` | QMD collection for conversation index |
| `conversationIndexFaissScriptPath` | `(unset)` | Optional absolute path to FAISS sidecar script |
| `conversationIndexFaissPythonBin` | `(unset)` | Optional Python executable for FAISS sidecar |
| `conversationIndexFaissModelId` | `text-embedding-3-small` | Embedding model id passed to the FAISS sidecar |
| `conversationIndexFaissIndexDir` | `state/conversation-index/faiss` | Relative FAISS artifact directory under `memoryDir` (`index.faiss`, `metadata.jsonl`, `manifest.json`) |
| `conversationIndexFaissUpsertTimeoutMs` | `30000` | Timeout for FAISS upsert operations |
| `conversationIndexFaissSearchTimeoutMs` | `5000` | Timeout for FAISS search operations |
| `conversationIndexFaissHealthTimeoutMs` | `2000` | Timeout for FAISS health checks; degraded health is fail-open |
| `conversationIndexFaissMaxBatchSize` | `512` | Max chunk batch size sent per FAISS upsert |
| `conversationIndexFaissMaxSearchK` | `50` | Max top-K allowed for FAISS search |
| `conversationRecallTopK` | `3` | Top-K relevant transcript chunks to inject |
| `conversationRecallMaxChars` | `2500` | Max characters of conversation context to inject |
| `conversationRecallTimeoutMs` | `800` | Timeout for conversation recall (ms) |
| `conversationIndexMinUpdateIntervalMs` | `900000` | Min interval between index updates |

FAISS notes:
- `conversation_index_update` still writes chunk markdown under `memoryDir/conversation-index/chunks/...`; the FAISS backend additionally upserts those chunks into the local sidecar index.
- The sidecar health check reports `degraded` when Python dependencies or local artifacts are missing. Recall stays fail-open and skips semantic transcript injection instead of breaking hook execution.
- Sentence-transformers embeddings are opt-in via `ENGRAM_FAISS_ENABLE_ST=1`. Without that env var, the sidecar uses deterministic hash embeddings for low-friction local setups.

## v9.1 Evaluation Harness Foundation

| Setting | Default | Description |
|---------|---------|-------------|
| `evalHarnessEnabled` | `false` | Enable Engram's benchmark/evaluation harness bookkeeping |
| `evalShadowModeEnabled` | `false` | Record live recall decisions to the eval store without changing injected output |
| `benchmarkBaselineSnapshotsEnabled` | `false` | Enable versioned baseline snapshot artifacts for the latest completed benchmark runs |
| `benchmarkDeltaReporterEnabled` | `false` | Enable named-baseline delta reports against the current eval store |
| `evalStoreDir` | `{memoryDir}/state/evals` | Root directory for benchmark packs, run summaries, and shadow recall records |
| `objectiveStateMemoryEnabled` | `false` | Enable the objective-state memory foundation for normalized world/tool state snapshots |
| `objectiveStateSnapshotWritesEnabled` | `false` | Allow agent-end file/process/tool writers to persist objective-state snapshots into the store |
| `objectiveStateRecallEnabled` | `false` | Inject prompt-relevant objective-state snapshots into recall context |
| `objectiveStateStoreDir` | `{memoryDir}/state/objective-state` | Root directory for objective-state snapshot artifacts |
| `causalTrajectoryMemoryEnabled` | `false` | Enable the causal-trajectory memory foundation for typed goal-action-observation-outcome chains |
| `causalTrajectoryStoreDir` | `{memoryDir}/state/causal-trajectories` | Root directory for causal-trajectory records |
| `causalTrajectoryRecallEnabled` | `false` | Inject prompt-relevant causal trajectories into recall context |
| `actionGraphRecallEnabled` | `false` | Write action-conditioned causal-stage edges from typed trajectory records into the causal graph |
| `trustZonesEnabled` | `false` | Enable the trust-zone memory foundation and operator-facing promotion path for quarantine, working, and trusted records |
| `quarantinePromotionEnabled` | `false` | Allow explicit trust-zone promotions such as `quarantine -> working` and guarded `working -> trusted` |
| `trustZoneStoreDir` | `{memoryDir}/state/trust-zones` | Root directory for trust-zone records |
| `trustZoneRecallEnabled` | `false` | Inject prompt-relevant working and trusted trust-zone records into recall context |
| `memoryPoisoningDefenseEnabled` | `false` | Enable deterministic provenance trust scoring and corroboration requirements for risky trusted promotions |
| `memoryRedTeamBenchEnabled` | `false` | Enable typed `memory-red-team` benchmark packs and status accounting for poisoning-defense regression suites |
| `harmonicRetrievalEnabled` | `false` | Enable harmonic retrieval blending over abstraction nodes and cue anchors, including the dedicated recall section and `harmonic-search` diagnostics |
| `abstractionAnchorsEnabled` | `false` | Enable typed cue-anchor indexing for abstraction nodes and expose the anchor store through status tooling |
| `abstractionNodeStoreDir` | `{memoryDir}/state/abstraction-nodes` | Root directory for abstraction-node artifacts |
| `verifiedRecallEnabled` | `false` | Inject prompt-relevant memory boxes only when their cited source memories verify as non-archived episodes |
| `semanticRulePromotionEnabled` | `false` | Enable deterministic promotion of explicit `IF ... THEN ...` rules from verified episodic memories via `openclaw engram semantic-rule-promote` |
| `semanticRuleVerificationEnabled` | `false` | Verify promoted semantic rules against their cited source episodes at recall time and inject a dedicated `Verified Rules` section via `openclaw engram semantic-rule-verify` |
| `creationMemoryEnabled` | `false` | Enable the creation-memory foundation, including the typed work-product ledger and its operator-facing write/status commands |
| `memoryUtilityLearningEnabled` | `false` | Enable typed utility-learning telemetry storage, the offline learner commands `openclaw engram utility-status`, `openclaw engram utility-record`, `openclaw engram utility-learning-status`, and `openclaw engram utility-learn`, plus runtime loading of the persisted learner snapshot |
| `promotionByOutcomeEnabled` | `false` | Apply bounded learned utility weights to ranking heuristics and tier-migration thresholds when a learner snapshot is available |
| `commitmentLedgerEnabled` | `false` | Enable the explicit commitment ledger for promises, follow-ups, deadlines, and unfinished obligations |
| `commitmentLifecycleEnabled` | `false` | Enable commitment lifecycle transitions, stale tracking, and resolved-entry cleanup for the commitment ledger |
| `commitmentStaleDays` | `14` | Days before an open commitment without a due date is considered stale in lifecycle status |
| `commitmentLedgerDir` | `{memoryDir}/state/commitment-ledger` | Root directory for commitment ledger entries |
| `resumeBundlesEnabled` | `false` | Enable typed resume-bundle storage plus the operator-facing `resume-bundle-status`, `resume-bundle-record`, and `resume-bundle-build` commands |
| `resumeBundleDir` | `{memoryDir}/state/resume-bundles` | Root directory for resume bundles |
| `workProductRecallEnabled` | `false` | Inject prompt-relevant work-product ledger entries into recall and expose `openclaw engram work-product-recall-search` |
| `workProductLedgerDir` | `{memoryDir}/state/work-product-ledger` | Root directory for work-product ledger entries |

Current foundation slice:
- `openclaw engram benchmark-status` scans `benchmarks/**.json` and `runs/**.json`, validates manifests/run summaries, and reports the latest completed run.
- When `benchmarkBaselineSnapshotsEnabled` is on, Engram also tracks typed `baselines/*.json` artifacts under the eval store and surfaces the latest stored baseline snapshot in `openclaw engram benchmark-status`.
- When both eval flags are on, live recall also writes `shadow/YYYY-MM-DD/<trace-id>.json` records with hashes, counts, chosen source, and recalled memory IDs.
- `openclaw engram benchmark-validate <path>` validates a manifest JSON file or a pack directory with a root `manifest.json`.
- `openclaw engram benchmark-import <path> [--force]` validates first, then imports into `benchmarks/<benchmarkId>/`.
- `openclaw engram benchmark-baseline-snapshot --snapshot-id <id>` captures a versioned baseline snapshot of the latest completed benchmark runs under `baselines/<snapshotId>.json`.
- `openclaw engram benchmark-baseline-report --snapshot-id <id>` compares the current eval store against a named stored baseline snapshot, emits both JSON and markdown summaries, and fails when pass rate, shared metrics, coverage, or eval artifact validity regress relative to that snapshot.
- The required GitHub `eval-benchmark-gate` workflow uses the committed fixture baseline snapshot at `tests/fixtures/eval-ci/store/baselines/required-main.json` as its stable PR-gating reference.
- `openclaw engram benchmark-ci-gate --base <dir> --candidate <dir>` compares two eval-store roots and fails when pass rate, shared metrics, or benchmark coverage regress.
- When `objectiveStateRecallEnabled` is on, Engram can inject a separate `## Objective State` recall section sourced from the objective-state store.
- When `causalTrajectoryMemoryEnabled` is on, Engram can persist typed causal chains into a separate store for later graph/retrieval slices.
- When `causalTrajectoryRecallEnabled` is on, Engram can inject a separate `## Causal Trajectories` recall section sourced from the causal-trajectory store.
- When `actionGraphRecallEnabled` is also on, each newly recorded causal trajectory emits deterministic `goal -> action -> observation -> outcome -> follow_up` edges into the causal graph without changing retrieval behavior yet.
- When `trustZonesEnabled` is on, Engram can persist provenance-bearing records into separate `quarantine`, `working`, and `trusted` storage tiers.
- When `quarantinePromotionEnabled` is also on, Engram exposes an explicit promotion path that blocks direct `quarantine -> trusted` jumps and requires anchored provenance before promoting risky working records into `trusted`.
- When `trustZoneRecallEnabled` is also on, Engram injects a separate `## Trust Zones` recall section sourced from `working` and `trusted` trust-zone records while keeping `quarantine` records out of recall by default.
- When `memoryPoisoningDefenseEnabled` is also on, `openclaw engram trust-zone-status` reports deterministic provenance trust scores derived from source class plus `sourceId` / `evidenceHash` / `sessionKey` anchors so later poisoning defenses can build on explicit signals instead of hidden heuristics.
- With both `memoryPoisoningDefenseEnabled` and `quarantinePromotionEnabled` enabled, risky `working -> trusted` promotions now require at least one independent non-`quarantine` corroborating record with anchored provenance and overlapping `entityRefs` or `tags`.
- When `memoryRedTeamBenchEnabled` is on, benchmark manifests can also declare `benchmarkType: "memory-red-team"` plus `attackClass` and `targetSurface`, and `openclaw engram benchmark-status` reports red-team pack counts and unique attack metadata.
- When `harmonicRetrievalEnabled` is on, Engram can persist typed abstraction nodes into a separate abstraction-node store for later harmonic retrieval slices.
- When `abstractionAnchorsEnabled` is also on, Engram can persist cue-anchor index entries under `{abstractionNodeStoreDir}/anchors` for entities, files, tools, outcomes, constraints, and dates.
- When the harmonic retrieval section is enabled in the recall pipeline, Engram can inject a dedicated `## Harmonic Retrieval` section that explains which abstraction nodes matched and which cue anchors contributed.
- Use `openclaw engram abstraction-node-status` to inspect node storage, `openclaw engram cue-anchor-status` to inspect anchor counts and invalid index records, and `openclaw engram harmonic-search <query>` to preview blended harmonic retrieval matches.
- When `verifiedRecallEnabled` is on, Engram can inject a separate `## Verified Episodes` recall section sourced from recent memory boxes, but only when each surfaced box still cites at least one non-archived source memory whose `memoryKind` remains `episode`.
- Use `openclaw engram verified-recall-search <query>` to preview verified episodic recall matches, including verified memory counts, matched fields, and cited episodic memory IDs.
- When `semanticRulePromotionEnabled` is on, `openclaw engram semantic-rule-promote --memory-id <id>` can promote an explicit `IF ... THEN ...` rule from a non-archived episodic memory into a durable `rule` memory with lineage, `sourceMemoryId`, and duplicate suppression.
- When `semanticRuleVerificationEnabled` is on, Engram can inject a separate `## Verified Rules` recall section sourced from promoted `rule` memories, but only when each surfaced rule still clears a provenance-aware effective-confidence threshold after re-checking its `sourceMemoryId`.
- When both `creationMemoryEnabled` and `commitmentLedgerEnabled` are on, Engram can persist explicit commitment ledger entries and expose them through `openclaw engram commitment-status` and `openclaw engram commitment-record`.
- When `commitmentLifecycleEnabled` is also on, Engram can transition commitment states with `openclaw engram commitment-set-state`, report overdue/stale/decay-eligible counts in `openclaw engram commitment-status`, and apply overdue-expiry plus resolved-entry cleanup through `openclaw engram commitment-lifecycle-run`.
- When both `creationMemoryEnabled` and `resumeBundlesEnabled` are on, Engram can persist explicit typed resume bundles, inspect them with `openclaw engram resume-bundle-status`, write manual shells with `openclaw engram resume-bundle-record`, and assemble bounded bundles from transcript recovery plus recent objective state, work products, and open commitments with `openclaw engram resume-bundle-build`.
- When `creationMemoryEnabled` is on, Engram can persist explicit work-product ledger entries and expose them through `openclaw engram work-product-status` and `openclaw engram work-product-record`.
- When both `creationMemoryEnabled` and `workProductRecallEnabled` are on, Engram can inject a separate `## Work Products` recall section sourced from the typed work-product ledger and expose `openclaw engram work-product-recall-search <query>` for reuse previews.
- When `memoryUtilityLearningEnabled` is on, Engram can persist typed downstream utility telemetry for promotion and ranking decisions, inspect the resulting event ledger with `openclaw engram utility-status`, record explicit benchmark/operator utility observations through `openclaw engram utility-record`, and learn bounded offline promotion/ranking weights through `openclaw engram utility-learn` with the persisted learner snapshot visible in `openclaw engram utility-learning-status`.
- When `promotionByOutcomeEnabled` is also on and a learner snapshot exists, Engram applies bounded learned utility multipliers to ranking heuristic deltas and bounded promotion/demotion threshold nudges to tier migration without re-reading raw utility telemetry on the hot path.
- Use `openclaw engram semantic-rule-verify <query>` to preview verified semantic-rule matches, including verification status, effective confidence, and the cited source memory id.
- Future slices will add automated benchmark runners on top of this store and gate format.

| `conversationIndexEmbedOnUpdate` | `false` | Run `qmd embed` on each update |

## v3.0 Namespaces

See [namespaces.md](namespaces.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `namespacesEnabled` | `false` | Enable multi-agent namespace isolation |
| `defaultNamespace` | `default` | Namespace for this agent's private memories |
| `sharedNamespace` | `shared` | Namespace for promoted shared memories |
| `namespacePolicies` | `[]` | Array of per-namespace read/write policy objects |

## v4.0 Shared Context

See [shared-context.md](shared-context.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `sharedContextEnabled` | `false` | Enable shared cross-agent context |
| `sharedContextDir` | `(unset)` | Directory for shared context files |
| `sharedContextMaxInjectChars` | `4000` | Max chars injected from shared context |
| `sharedCrossSignalSemanticEnabled` | `false` | Enable optional semantic overlap enhancement during daily curation |
| `sharedCrossSignalSemanticTimeoutMs` | `4000` | Timeout budget for semantic enhancement pass (fail-open on timeout) |
| `sharedCrossSignalSemanticMaxCandidates` | `120` | Max topic-token candidates considered by semantic enhancement |

## v5.0 Compounding

See [compounding.md](compounding.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `compoundingEnabled` | `false` | Enable weekly synthesis and mistake learning |
| `compoundingInjectEnabled` | `true` | Inject compounding output when enabled |

## v6.0 Deduplication & Archival

| Setting | Default | Description |
|---------|---------|-------------|
| `factDeduplicationEnabled` | `true` | Content-hash deduplication |
| `factArchivalEnabled` | `false` | Archive old, low-value facts |
| `factArchivalAgeDays` | `90` | Minimum age to archive |
| `factArchivalMaxImportance` | `0.3` | Maximum importance to archive |
| `factArchivalMaxAccessCount` | `2` | Maximum access count to archive |
| `factArchivalProtectedCategories` | `["commitment","preference","decision","principle"]` | Never archived |

## v8.2 Graph Recall Activation

| Setting | Default | Description |
|---------|---------|-------------|
| `multiGraphMemoryEnabled` | `false` | Enable graph storage/traversal substrate |
| `graphRecallEnabled` | `false` | Enable planner `graph_mode` expansion |
| `graphExpandedIntentEnabled` | `true` | Escalate broader causal/timeline prompts into `graph_mode` |
| `graphAssistInFullModeEnabled` | `true` | Run bounded graph expansion during `full` recall mode |
| `graphAssistShadowEvalEnabled` | `false` | In `full` mode, run graph assist as shadow-eval (compute + snapshot + telemetry, no injection change) |
| `graphAssistMinSeedResults` | `3` | Minimum seed recalls required for full-mode graph assist |
| `graphWriteSessionAdjacencyEnabled` | `true` | Write fallback time edges between consecutive extracted memories |
| `entityGraphEnabled` | `true` | Enable entity co-reference edges |
| `timeGraphEnabled` | `true` | Enable temporal sequence edges |
| `causalGraphEnabled` | `true` | Enable causal phrase edges |
| `maxGraphTraversalSteps` | `3` | Max spreading-activation BFS hops |
| `graphActivationDecay` | `0.7` | Per-hop decay factor |
| `graphExpansionActivationWeight` | `0.65` | Blend weight for graph activation vs seed QMD score (0-1) |
| `graphExpansionBlendMin` | `0.05` | Lower clamp bound for blended graph-expanded scores (0-1) |
| `graphExpansionBlendMax` | `0.95` | Upper clamp bound for blended graph-expanded scores (0-1) |

## File Hygiene

| Setting | Default | Description |
|---------|---------|-------------|
| `fileHygiene.enabled` | `false` | Enable file hygiene features |
| `fileHygiene.lintEnabled` | `true` | Warn on oversized workspace files (when hygiene is enabled) |
| `fileHygiene.lintPaths` | `["IDENTITY.md","MEMORY.md"]` | Files to monitor (relative to workspaceDir) |
| `fileHygiene.lintBudgetBytes` | `20000` | Budget threshold for warnings |
| `fileHygiene.lintWarnRatio` | `0.8` | Warn at this fraction of budget |
| `fileHygiene.rotateEnabled` | `false` | Rotate oversized files into archive |
| `fileHygiene.rotatePaths` | `["IDENTITY.md"]` | Files to rotate |
| `fileHygiene.rotateMaxBytes` | `18000` | Max size before rotation |
| `fileHygiene.rotateKeepTailChars` | `2000` | Chars to keep as tail excerpt after rotation |
| `fileHygiene.archiveDir` | `.engram-archive` | Archive directory name |
| `fileHygiene.runMinIntervalMs` | `300000` | Min interval between hygiene runs |

## Access Tracking

| Setting | Default | Description |
|---------|---------|-------------|
| `accessTrackingEnabled` | `true` | Track access frequency per memory |
| `boostAccessCount` | `true` | Boost frequently accessed memories in ranking |

## Memory Linking

| Setting | Default | Description |
|---------|---------|-------------|
| `memoryLinkingEnabled` | `false` | LLM-suggested semantic links between memories |

## Summarization

| Setting | Default | Description |
|---------|---------|-------------|
| `summarizationEnabled` | `false` | Summarize old memories when count exceeds threshold |
| `summarizationTriggerCount` | `1000` | Memory count that triggers summarization |
