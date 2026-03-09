# Enable All v8 Features

This guide provides a single config profile that explicitly enables all major v8 feature families in `openclaw-engram`.

Apply under:

- `plugins.entries.openclaw-engram.enabled = true`
- `plugins.entries.openclaw-engram.config = { ... }`

## Full v8 Config Profile

```jsonc
{
  "openaiApiKey": "${OPENAI_API_KEY}",
  "qmdEnabled": true,
  "qmdCollection": "openclaw-engram-hot-facts",
  "qmdColdTierEnabled": true,
  "qmdColdCollection": "openclaw-engram-cold",
  "conversationIndexEnabled": true,
  "conversationIndexBackend": "faiss",
  "conversationIndexFaissPythonBin": "python3",
  "conversationIndexFaissModelId": "text-embedding-3-small",
  "conversationIndexFaissIndexDir": "state/conversation-index/faiss",

  "recallPlannerEnabled": true,
  "memoryBoxesEnabled": true,
  "traceWeaverEnabled": true,
  "episodeNoteModeEnabled": true,
  "queryAwareIndexingEnabled": true,
  "multiGraphMemoryEnabled": true,
  "graphRecallEnabled": true,
  "graphAssistShadowEvalEnabled": true,
  "temporalMemoryTreeEnabled": true,

  "lifecyclePolicyEnabled": true,
  "lifecycleFilterStaleEnabled": true,
  "lifecycleMetricsEnabled": true,

  "proactiveExtractionEnabled": true,
  "contextCompressionActionsEnabled": true,
  "compressionGuidelineLearningEnabled": true,
  "compressionGuidelineSemanticRefinementEnabled": true,

  "identityEnabled": true,
  "identityContinuityEnabled": true,
  "continuityAuditEnabled": true,
  "continuityIncidentLoggingEnabled": true,

  "routingRulesEnabled": true,
  "sessionObserverEnabled": true,

  "sharedContextEnabled": true,
  "sharedCrossSignalSemanticEnabled": true,
  "compoundingEnabled": true,
  "compoundingInjectEnabled": true,
  "compoundingSemanticEnabled": true,
  "compoundingWeeklyCronEnabled": true,

  "qmdTierMigrationEnabled": true,
  "qmdTierAutoBackfillEnabled": true,

  "behaviorLoopAutoTuneEnabled": true,

  "debug": true
}
```

## Safety Notes

- Keep secrets in environment variables (`${OPENAI_API_KEY}`), not hardcoded keys.
- If you run many features at once, expect higher extraction/consolidation activity.
- `debug: true` is recommended while validating; disable later for quieter logs.
- If you use `conversationIndexBackend: "faiss"`, install `scripts/faiss_requirements.txt` first and optionally set `ENGRAM_FAISS_ENABLE_ST=1` for sentence-transformers embeddings.
- If you prefer QMD for transcript recall, swap the FAISS fields for `conversationIndexBackend: "qmd"` plus `conversationIndexQmdCollection`.

## Required Restart

After config changes:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

## Verification Checklist

Run all commands:

```bash
openclaw engram compat --strict
openclaw engram stats
openclaw engram conversation-index-health
openclaw engram conversation-index-inspect
openclaw engram graph-health
openclaw engram tier-status
openclaw engram policy-status
```

Expected:

- `compat --strict`: exits `0`
- `stats`: `QMD: available`
- `conversation-index-health`: `status: "ok"` when backend is `qmd`
- `conversation-index-inspect`: returns backend metadata and artifact state without mutating the index
- `graph-health`: JSON report without runtime command failure
- `tier-status`: returns migration telemetry JSON
- `policy-status`: returns runtime policy snapshot JSON

## Search Backend (v9.0)

The config above uses QMD (default). To use an alternative backend, add:

```jsonc
{
  "searchBackend": "orama"   // or "lancedb", "meilisearch", "remote", "noop"
}
```

See [Search Backends](search-backends.md) for full options.

## Related Docs

- [Getting Started](getting-started.md)
- [Search Backends](search-backends.md)
- [Config Reference](config-reference.md)
- [Operations](operations.md)
- [Identity Continuity](identity-continuity.md)
- [Shared Context](shared-context.md)
