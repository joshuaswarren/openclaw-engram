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

## Retrieval

| Setting | Default | Description |
|---------|---------|-------------|
| `maxMemoryTokens` | `2000` | Token cap for injected memory context |
| `qmdEnabled` | `true` | Use QMD for hybrid search |
| `qmdCollection` | `openclaw-engram` | QMD collection name |
| `qmdMaxResults` | `8` | Final result cap after over-scanning and ranking (fetch size may be larger) |
| `qmdPath` | `(auto)` | Absolute path to `qmd` binary (bypasses PATH) |
| `qmdDaemonEnabled` | `true` | Use QMD MCP daemon for search (falls back to subprocess) |
| `qmdDaemonUrl` | `http://localhost:8181/mcp` | QMD daemon MCP endpoint URL |
| `qmdDaemonRecheckIntervalMs` | `60000` | Interval to re-probe daemon availability after failure |
| `embeddingFallbackEnabled` | `true` | Use embedding search when QMD is unavailable |
| `embeddingFallbackProvider` | `auto` | `auto`, `openai`, or `local` — selects embedding API for fallback |

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

## v2.2 Advanced Retrieval

See [advanced-retrieval.md](advanced-retrieval.md) for guidance.

| Setting | Default | Description |
|---------|---------|-------------|
| `queryExpansionEnabled` | `false` | Heuristic query expansion (no LLM calls) |
| `queryExpansionMaxQueries` | `4` | Max expanded queries including original |
| `queryExpansionMinTokenLen` | `3` | Minimum token length for expansion |
| `rerankEnabled` | `false` | LLM reranking (do not use with QMD) |
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
| `hourlySummariesEnabled` | `true` | Generate hourly summaries of conversation activity |
| `hourlySummaryCronAutoRegister` | `false` | Auto-register hourly summary cron job on gateway start |
| `hourlySummariesExtendedEnabled` | `false` | Structured topics/decisions in hourly summaries |
| `hourlySummariesIncludeToolStats` | `false` | Include tool usage stats in summaries |
| `conversationIndexEnabled` | `false` | Index transcript chunks for semantic recall |
| `conversationIndexQmdCollection` | `openclaw-engram-conversations` | QMD collection for conversation index |
| `conversationRecallTopK` | `3` | Top-K relevant transcript chunks to inject |
| `conversationIndexMinUpdateIntervalMs` | `900000` | Min interval between index updates |
| `conversationIndexEmbedOnUpdate` | `false` | Run `qmd embed` on each update |

## v3.0 Namespaces

See [namespaces.md](namespaces.md).

| Setting | Default | Description |
|---------|---------|-------------|
| `namespacesEnabled` | `false` | Enable multi-agent namespace isolation |
| `defaultNamespace` | `default` | Namespace for this agent's private memories |
| `sharedNamespace` | `shared` | Namespace for promoted shared memories |
| `namespacePolicies` | `{}` | Per-namespace read/write policies |

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
