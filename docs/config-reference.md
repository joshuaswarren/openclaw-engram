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
  - synthesis is fail-open and never blocks consolidation

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
| `conversationIndexQmdCollection` | `openclaw-engram-conversations` | QMD collection for conversation index |
| `conversationRecallTopK` | `3` | Top-K relevant transcript chunks to inject |
| `conversationRecallMaxChars` | `2500` | Max characters of conversation context to inject |
| `conversationRecallTimeoutMs` | `800` | Timeout for conversation recall (ms) |
| `conversationIndexMinUpdateIntervalMs` | `900000` | Min interval between index updates |
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
| `graphAssistMinSeedResults` | `3` | Minimum seed recalls required for full-mode graph assist |
| `graphWriteSessionAdjacencyEnabled` | `true` | Write fallback time edges between consecutive extracted memories |
| `entityGraphEnabled` | `true` | Enable entity co-reference edges |
| `timeGraphEnabled` | `true` | Enable temporal sequence edges |
| `causalGraphEnabled` | `true` | Enable causal phrase edges |
| `maxGraphTraversalSteps` | `3` | Max spreading-activation BFS hops |
| `graphActivationDecay` | `0.7` | Per-hop decay factor |

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
