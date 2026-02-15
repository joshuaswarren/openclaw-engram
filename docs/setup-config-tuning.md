# Setup, Configuration, and Tuning (v2.3-v5)

This guide is the operational runbook for enabling and tuning Engram features from v2.3 through v5.

## 1) Enable Plugin + Core Config

In `openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-engram"],
    "slots": { "memory": "openclaw-engram" },
    "entries": {
      "openclaw-engram": {
        "enabled": true,
        "config": {
          "openaiApiKey": "${OPENAI_API_KEY}",
          "model": "gpt-5-mini",

          "localLlmEnabled": true,
          "localLlmUrl": "http://127.0.0.1:1234/v1",
          "localLlmModel": "qwen3-coder-30b-a3b-instruct-mlx@4bit",
          "localLlmFallback": true,
          "localLlmHomeDir": "~",
          "localLmsCliPath": "~/.cache/lm-studio/bin/lms",
          "localLmsBinDir": "~/.cache/lm-studio/bin",
          "localLlmMaxContext": 4096,

          "rerankEnabled": true,
          "rerankProvider": "local",
          "rerankMaxCandidates": 20,
          "rerankTimeoutMs": 8000
        }
      }
    }
  }
}
```

Service env override (optional):
- `OPENCLAW_ENGRAM_CONFIG_PATH=/absolute/path/to/openclaw.json`

## 1b) File Hygiene (Avoid Silent Truncation)

If your workspace bootstrap files (commonly `USER.md`, `MEMORY.md`, `IDENTITY.md`) get large, OpenClaw can silently truncate them during prompt bootstrap.
Enable Engram's optional file hygiene to warn early and (optionally) rotate oversized files into an archive directory:

```jsonc
{
  "fileHygiene": {
    "enabled": true,
    "lintEnabled": true,
    "lintPaths": ["USER.md", "MEMORY.md", "IDENTITY.md"],
    "lintBudgetBytes": 20000,
    "lintWarnRatio": 0.8,

    "rotateEnabled": true,
    "rotatePaths": ["IDENTITY.md"],
    "rotateMaxBytes": 18000,
    "rotateKeepTailChars": 2000,
    "archiveDir": ".engram-archive",

    "runMinIntervalMs": 600000,
    "warningsLogEnabled": true,
    "warningsLogPath": "hygiene/warnings.md"
  }
}
```

## 2) v2.4 Context Retention

Recommended starting config:

```jsonc
{
  "hourlySummariesEnabled": true,
  "hourlySummaryCronAutoRegister": false,
  "hourlySummariesExtendedEnabled": true,
  "hourlySummariesIncludeToolStats": true,
  "hourlySummariesIncludeSystemMessages": false,
  "hourlySummariesMaxTurnsPerRun": 200,

  "conversationIndexEnabled": true,
  "conversationIndexBackend": "qmd",
  "conversationIndexQmdCollection": "openclaw-engram-conversations",
  "conversationIndexRetentionDays": 30,
  "conversationIndexMinUpdateIntervalMs": 900000,
  "conversationIndexEmbedOnUpdate": false,
  "conversationRecallTopK": 4,
  "conversationRecallMaxChars": 2000,
  "conversationRecallTimeoutMs": 800
}
```

QMD collection (`~/.config/qmd/index.yml`):

```yaml
collections:
  openclaw-engram-conversations:
    path: ~/.openclaw/workspace/memory/local/conversation-index/chunks
    pattern: "**/*.md"
```

## 3) v3.0 Namespaces

Recommended starter policy:

```jsonc
{
  "namespacesEnabled": true,
  "defaultNamespace": "generalist",
  "sharedNamespace": "shared",
  "principalFromSessionKeyMode": "prefix",
  "principalFromSessionKeyRules": [
    { "match": "agent:generalist:", "principal": "generalist" },
    { "match": "agent:main:", "principal": "main" }
  ],
  "namespacePolicies": [
    {
      "name": "generalist",
      "readPrincipals": ["generalist", "main"],
      "writePrincipals": ["generalist"],
      "includeInRecallByDefault": true
    },
    {
      "name": "main",
      "readPrincipals": ["main"],
      "writePrincipals": ["main"],
      "includeInRecallByDefault": true
    },
    {
      "name": "shared",
      "readPrincipals": ["*"],
      "writePrincipals": ["generalist", "main"],
      "includeInRecallByDefault": true
    }
  ],
  "defaultRecallNamespaces": ["self", "shared"]
}
```

Operational note:
- The default namespace continues using the legacy `memoryDir` root unless `memoryDir/namespaces/<defaultNamespace>` exists.

## 4) v4.0 Shared Context

```jsonc
{
  "sharedContextEnabled": true,
  "sharedContextDir": "~/.openclaw/workspace/shared-context",
  "sharedContextMaxInjectChars": 6000,
  "crossSignalsSemanticEnabled": false,
  "crossSignalsSemanticTimeoutMs": 4000
}
```

Keep semantic cross-signals off until deterministic shared-context behavior is stable and load-tested.

## 5) v5.0 Compounding

```jsonc
{
  "compoundingEnabled": true,
  "compoundingWeeklyCronEnabled": true,
  "compoundingSemanticEnabled": false,
  "compoundingSynthesisTimeoutMs": 15000,
  "compoundingInjectEnabled": true
}
```

Start with deterministic compounding. Enable semantic compounding only after weekly outputs are reliable.

## 6) Recommended Cron Jobs

Use isolated `agentTurn` jobs and `delivery.mode: "none"`:

1. Hourly summaries:
- schedule: `17 * * * *`
- action: call tool `memory_summarize_hourly`

2. Conversation index refresh:
- schedule: `23 * * * *`
- action: call tool `conversation_index_update` with `{"hours":48}`
- optional one-off deep refresh: `{"hours":48,"embed":true}`

3. Shared-context daily curation:
- schedule: `5 21 * * *`
- action: call tool `shared_context_curate_daily`

4. Weekly compounding synthesis:
- schedule: `35 21 * * 0`
- action: call tool `compounding_weekly_synthesize`

## 7) Tuning Checklist

Reliability / load:
- Keep extraction guardrails enabled (defaults are safe):
  - `extractionDedupeEnabled: true`
  - `extractionDedupeWindowMs: 300000`
  - `extractionMinChars: 40`
  - `extractionMinUserTurns: 1`
  - `extractionMaxTurnChars: 4000`
  - `extractionMaxFactsPerRun: 12`
  - `extractionMaxEntitiesPerRun: 6`
  - `extractionMaxQuestionsPerRun: 3`
  - `extractionMaxProfileUpdatesPerRun: 4`
- Consolidation throttling:
  - `consolidationRequireNonZeroExtraction: true`
  - `consolidationMinIntervalMs: 600000`
- QMD maintenance off the hot path:
  - `qmdMaintenanceEnabled: true`
  - `qmdMaintenanceDebounceMs: 30000`
  - `qmdUpdateTimeoutMs: 90000`
  - `qmdAutoEmbedEnabled: false` (enable only when you need frequent embed refresh)
  - `qmdEmbedMinIntervalMs: 3600000`
- QMD performance patches (as of 2026-02-14):
  - Apply PRs [#166](https://github.com/tobi/qmd/pull/166), [#112](https://github.com/tobi/qmd/pull/112), [#117](https://github.com/tobi/qmd/pull/117) locally for daemon stability, model overrides, and FTS join fixes. See README for details.
  - With the daemon fix (#166), `qmd mcp --http --daemon` keeps models warm — queries drop from ~13s to ~30ms.
- Local LLM failure damping:
  - `localLlmRetry5xxCount: 1`
  - `localLlmRetryBackoffMs: 400`
  - `localLlm400TripThreshold: 5`
  - `localLlm400CooldownMs: 120000`

Latency:
- Increase `conversationRecallTimeoutMs` only if your QMD host is consistently fast.
- Keep `rerankTimeoutMs` conservative (5-10s) and fail-open.

Recall quality:
- Increase `conversationRecallTopK` gradually (3 -> 4 -> 6) and watch prompt bloat.
- Keep `conversationRecallMaxChars` bounded (1500-3000) to avoid drowning current context.

Storage growth:
- Keep `conversationIndexRetentionDays` finite.
- Keep `conversationIndexMinUpdateIntervalMs` >= 10m unless you are actively debugging.
- Keep transcript retention finite (`transcriptRetentionDays`).

Safety:
- Leave `hourlySummariesIncludeSystemMessages=false` unless specifically debugging.
- Use `delivery.mode: "none"` for maintenance crons so they never spam Discord.

## 8) Post-Restart Validation

After your next gateway restart:

1. Confirm plugin startup in logs.
2. Run `memory_summarize_hourly` once manually.
3. Run `conversation_index_update` once manually.
4. Confirm files appear:
- `memory/local/summaries/hourly/...`
- `memory/local/conversation-index/chunks/...`
- `workspace/shared-context/...`
- `memory/local/compounding/...` (after weekly run)
