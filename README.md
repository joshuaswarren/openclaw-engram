# openclaw-engram

Local-first long-term memory for [OpenClaw](https://github.com/openclaw/openclaw), with typed extraction, markdown-native storage, and retrieval-time memory injection.

Current release line: `8.3.x` (v8 Memory OS series).

## Install

```bash
openclaw plugins install @joshuaswarren/openclaw-engram --pin
```

`openclaw.json` wiring:

```jsonc
{
  "plugins": {
    "allow": ["openclaw-engram"],
    "slots": { "memory": "openclaw-engram" },
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

Restart gateway:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

## Fast Verification

```bash
openclaw engram compat --strict
openclaw engram stats
openclaw engram conversation-index-health
```

Healthy baseline:
- `compat --strict` exits `0`
- `stats` reports `QMD: available`
- `conversation-index-health` reports `status: "ok"` when conversation index is enabled

## Enable Profiles

Use one of these profiles under `plugins.entries.openclaw-engram.config`:

- Minimal: extraction + core recall only
- Recommended: production-safe defaults with major v8 capabilities
- Full v8: all v8 feature families explicitly enabled

Full profile guide:
- [Enable All v8 Features](docs/enable-all-v8.md)

## What Engram Does

1. Signals and buffering: identify high-signal turns, batch low-signal turns.
2. Extraction: create typed memories (`fact`, `decision`, `preference`, `correction`, etc).
3. Storage: markdown files + frontmatter, local filesystem only.
4. Recall: assemble multi-section context by ordered recall pipeline.
5. Maintenance: dedupe, lifecycle transitions, compounding, migration/repair tooling.

Architecture details:
- [Architecture Overview](docs/architecture/overview.md)
- [Retrieval Pipeline](docs/architecture/retrieval-pipeline.md)
- [Memory Lifecycle](docs/architecture/memory-lifecycle.md)

## v8 Feature Families (at a glance)

| Family | Key flags |
|---|---|
| Recall planning + assembly | `recallPlannerEnabled`, `recallPipeline`, `recallBudgetChars` |
| Episodic memory model | `memoryBoxesEnabled`, `traceWeaverEnabled`, `episodeNoteModeEnabled` |
| Query-aware retrieval | `queryAwareIndexingEnabled`, `graphRecallEnabled`, `graphAssistShadowEvalEnabled` |
| Lifecycle + action policy | `lifecyclePolicyEnabled`, `contextCompressionActionsEnabled`, `compressionGuidelineLearningEnabled` |
| Identity continuity | `identityContinuityEnabled`, `continuityAuditEnabled`, `continuityIncidentLoggingEnabled` |
| Session integrity + replay | `sessionObserverEnabled`, replay/session CLI commands |
| Routing + work layer | `routingRulesEnabled`, `task`/`project` CLI |
| Hot/cold tiering | `qmdTierMigrationEnabled`, `qmdTierAutoBackfillEnabled` |
| Shared intelligence + compounding | `sharedContextEnabled`, `sharedCrossSignalSemanticEnabled`, `compoundingEnabled` |
| Behavior loop runtime tuning | `behaviorLoopAutoTuneEnabled`, policy CLI commands |

For complete settings and defaults:
- [Config Reference](docs/config-reference.md)

## Agent/Operator Commands

Common commands:

```bash
openclaw engram stats
openclaw engram search "query"
openclaw engram compat --strict
openclaw engram conversation-index-health
openclaw engram graph-health
openclaw engram tier-status
openclaw engram policy-status
```

## Docs Index

- [Docs Home](docs/README.md)
- [Getting Started](docs/getting-started.md)
- [Enable All v8 Features](docs/enable-all-v8.md)
- [Config Reference](docs/config-reference.md)
- [Operations](docs/operations.md)
- [Namespaces](docs/namespaces.md)
- [Shared Context](docs/shared-context.md)
- [Compounding](docs/compounding.md)
- [Identity Continuity](docs/identity-continuity.md)
