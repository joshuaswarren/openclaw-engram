# openclaw-engram

**Long-term memory for AI agents.** Engram gives your [OpenClaw](https://github.com/openclaw/openclaw) agents persistent, searchable memory that survives across conversations. Every interaction builds a richer understanding of your world — decisions, preferences, facts, relationships, and more — so your agents remember what matters.

[![npm version](https://img.shields.io/npm/v/@joshuaswarren/openclaw-engram)](https://www.npmjs.com/package/@joshuaswarren/openclaw-engram)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Product Thesis

Engram is being built around three requirements:

- **Memory that improves action outcomes**
- **Memory that survives long horizons and failures**
- **Memory that can defend itself**

That product thesis drives the roadmap order:

1. Evaluation harness and shadow-mode measurement
2. Objective-state and causal trajectory memory
3. Trust-zoned memory promotion and poisoning defense
4. Harmonic retrieval over abstractions plus anchors
5. Creation-memory, commitments, and recoverability

## Why Engram?

AI agents forget everything between conversations. Engram fixes that.

- **Automatic extraction** — Engram watches conversations and extracts facts, decisions, preferences, corrections, and more. No manual tagging required.
- **Smart recall** — Before each conversation, Engram injects the most relevant memories into the agent's context. Your agents remember what they need, when they need it.
- **Local-first** — All memory data stays on your filesystem as plain markdown files. No cloud dependency, no vendor lock-in, fully portable.
- **Pluggable search** — Choose from six search backends: QMD (hybrid BM25+vector+reranking), LanceDB, Meilisearch, Orama, remote HTTP, or bring your own.
- **Memory OS features** — Graph recall, temporal memory tree, lifecycle policy, compounding, shared context, memory boxes, and identity continuity can be enabled progressively as your install grows.
- **Benchmark-first roadmap** — Engram now has an evaluation harness with live shadow recall recording and a CI benchmark delta gate, so memory improvements can be measured and regression-checked instead of argued from anecdotes.
- **Baseline snapshot discipline** — Engram can now, when `benchmarkBaselineSnapshotsEnabled` is enabled, capture typed baseline snapshots of the latest completed benchmark runs so later PR delta reporting can compare candidates against a stable stored reference instead of an ad hoc branch state.
- **Named baseline delta reporting** — Engram can now, when `benchmarkDeltaReporterEnabled` is enabled, compare the current eval store against a stored baseline snapshot, emit a machine-readable delta report plus markdown summary, and fail fast when a candidate regresses a benchmark that previously passed.
- **Required CI baseline gate** — Engram's `eval-benchmark-gate` workflow now reads a named stored baseline snapshot from the base branch fixture store and blocks merges when the candidate branch regresses relative to that required baseline.
- **Objective-state recall** — Engram can now store normalized file, process, and tool outcomes and, when `objectiveStateRecallEnabled` is enabled, inject the most relevant objective-state snapshots back into recall context as a separate `Objective State` section.
- **Causal trajectory graph foundation** — Engram can now persist typed `goal -> action -> observation -> outcome -> follow-up` chains when `causalTrajectoryMemoryEnabled` is enabled and, with `actionGraphRecallEnabled`, emit deterministic action-conditioned edges into the causal graph for later trajectory-aware retrieval.
- **Causal trajectory recall** — Engram can now, when `causalTrajectoryRecallEnabled` is enabled, inject prompt-relevant causal chains back into recall context as a separate `Causal Trajectories` section with lightweight match explainability.
- **Trust-zone promotion path** — Engram can now, when `trustZonesEnabled` and `quarantinePromotionEnabled` are enabled, persist typed quarantine, working, and trusted records, plan explicit promotions, block direct `quarantine -> trusted` jumps, and require anchored provenance before promoting risky working records into `trusted`.
- **Trust-zone recall** — Engram can now, when `trustZoneRecallEnabled` is enabled, inject prompt-relevant `working` and `trusted` trust-zone records into recall context as a separate `Trust Zones` section while keeping `quarantine` material out of recall by default.
- **Poisoning-defense corroboration** — Engram can now, when `memoryPoisoningDefenseEnabled` is enabled, score trust-zone provenance deterministically and require independent non-quarantine corroboration before risky `working -> trusted` promotions succeed.
- **Red-team benchmark packs** — Engram's eval harness can now validate and count typed `memory-red-team` benchmark packs so poisoning-defense regression suites stay explicit and reviewable instead of hiding inside generic benchmark metadata.
- **Cue-anchor index foundation** — Engram can now, when `harmonicRetrievalEnabled` and `abstractionAnchorsEnabled` are enabled, persist typed cue anchors for entities, files, tools, outcomes, constraints, and dates, inspect them with `openclaw engram cue-anchor-status`, and keep harmonic retrieval grounded in explicit abstraction-to-cue links before blending logic lands.
- **Harmonic retrieval diagnostics** — Engram can now, when `harmonicRetrievalEnabled` is enabled, blend abstraction-node evidence with cue-anchor matches into a dedicated `Harmonic Retrieval` recall section and inspect those blended results with `openclaw engram harmonic-search`.
- **Verified episodic recall** — Engram can now, when `verifiedRecallEnabled` is enabled, inject a dedicated `Verified Episodes` recall section that reuses memory boxes but only surfaces boxes whose cited source memories still verify as non-archived episodes.
- **Semantic rule promotion** — Engram can now, when `semanticRulePromotionEnabled` is enabled, promote explicit `IF ... THEN ...` rules from verified episodic memories into durable `rule` memories with lineage, source-memory provenance, duplicate suppression, and the operator-facing `openclaw engram semantic-rule-promote` CLI.
- **Verified rule recall** — Engram can now, when `semanticRuleVerificationEnabled` is enabled, inject a dedicated `Verified Rules` recall section that re-checks promoted rule memories against their cited source episodes at recall time and downgrades stale provenance before the rule can surface.
- **Creation-memory ledger** — Engram can now, when `creationMemoryEnabled` is enabled, persist a typed work-product ledger for explicit outputs agents create or update, inspect it with `openclaw engram work-product-status`, and write deterministic entries through `openclaw engram work-product-record`.
- **Artifact recovery recall** — Engram can now, when both `creationMemoryEnabled` and `workProductRecallEnabled` are enabled, surface prompt-relevant work-product ledger entries back into recall as a dedicated `Work Products` section and inspect reuse candidates with `openclaw engram work-product-recall-search`.
- **Commitment lifecycle foundation** — Engram can now, when `creationMemoryEnabled`, `commitmentLedgerEnabled`, and `commitmentLifecycleEnabled` are enabled, transition existing commitments to `fulfilled` / `cancelled` / `expired`, inspect overdue and stale obligations in `openclaw engram commitment-status`, and run deterministic lifecycle cleanup with `openclaw engram commitment-lifecycle-run`.
- **Resume-bundle builder** — Engram can now, when `creationMemoryEnabled` and `resumeBundlesEnabled` are enabled, persist typed crash-recovery resume bundles, inspect them with `openclaw engram resume-bundle-status`, write explicit handoff shells through `openclaw engram resume-bundle-record`, and build bounded resume bundles from transcript recovery, recent objective-state snapshots, work products, and open commitments through `openclaw engram resume-bundle-build`.
- **Utility-learning runtime weighting** — Engram can now persist typed downstream utility events, learn bounded offline promotion/ranking weights, inspect the learner snapshot, and, when both `memoryUtilityLearningEnabled` and `promotionByOutcomeEnabled` are enabled, apply those learned weights back to ranking heuristics and tier-migration thresholds in a bounded fail-open way.
- **Zero-config start** — Install, add an API key, restart. Engram works out of the box with sensible defaults and progressively unlocks advanced features as you enable them.

## Quick Start

```bash
openclaw plugins install @joshuaswarren/openclaw-engram --pin
```

Add to your `openclaw.json`:

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

Restart the gateway:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

That's it. Start a conversation — Engram begins learning immediately.

## Verify Installation

```bash
openclaw engram compat --strict   # Should exit 0
openclaw engram stats             # Shows memory counts and search status
```

## How It Works

Engram operates in three phases, running automatically in the background:

```
 Recall    Before each conversation, inject relevant memories
 Buffer    After each turn, accumulate content until a trigger fires
 Extract   Periodically, use an LLM to extract structured memories
```

Memories are stored as markdown files with YAML frontmatter:

```yaml
---
id: decision-1738789200000-a1b2
category: decision
confidence: 0.92
tags: ["architecture", "search"]
---
Decided to use the port/adapter pattern for search backends
so alternative engines can replace QMD without changing core logic.
```

Categories include: `fact`, `decision`, `preference`, `correction`, `relationship`, `principle`, `commitment`, `moment`, `skill`, and more.

## Search Backends

Engram v9 introduces a pluggable search architecture. Set `searchBackend` in your config to switch engines:

| Backend | Type | Best For | Config |
|---------|------|----------|--------|
| **QMD** (default) | Hybrid BM25+vector+reranking | Best recall quality, production use | `"qmd"` |
| **Orama** | Embedded, pure JS | Zero native deps, quick setup | `"orama"` |
| **LanceDB** | Embedded, native Arrow | Large collections, fast vector search | `"lancedb"` |
| **Meilisearch** | Server-based | Shared search across services | `"meilisearch"` |
| **Remote** | HTTP REST | Custom search service integration | `"remote"` |
| **Noop** | No-op | Disable search (extraction only) | `"noop"` |

Example — switch to Orama (zero setup, no external dependencies):

```jsonc
{
  "searchBackend": "orama"
}
```

See the [Search Backends Guide](docs/search-backends.md) for detailed configuration and tradeoffs.

Want to build your own? See [Writing a Search Backend](docs/writing-a-search-backend.md).

## Roadmap

- [Engram Feature Roadmap (GitHub Project)](https://github.com/users/joshuaswarren/projects/1) — Current issue order, blockers, and next work
- [Historical Plans Index](docs/plans/README.md) — Design docs and archived completed plans

## Feature Highlights

Engram's capabilities are organized into feature families that you can enable progressively:

| Feature | What It Does |
|---------|-------------|
| **Recall Planner** | Lightweight gating that decides whether to retrieve memories or skip recall |
| **Memory Boxes** | Groups related memories into topic-windowed episodes with trace linking |
| **Episode/Note Model** | Classifies memories as time-specific events or stable beliefs |
| **Graph Recall** | Entity-relationship graph for causal and timeline queries |
| **Lifecycle Policy** | Automatic memory aging: active, validated, stale, archived |
| **Identity Continuity** | Maintains consistent agent personality across sessions |
| **Shared Context** | Cross-agent memory sharing for multi-agent setups |
| **Compounding** | Weekly synthesis that surfaces patterns and recurring mistakes |
| **Hot/Cold Tiering** | Automatic migration of aging memories to cold storage |
| **Behavior Loop Tuning** | Runtime self-tuning of extraction and recall parameters |
| **Evaluation Harness** | Tracks benchmark packs, run summaries, live shadow recall records, and CI delta comparisons so future PRs can be gated on memory quality instead of anecdotes |
| **Objective-State Recall** | Surfaces prompt-relevant file/process/tool state snapshots separately from semantic memory recall |

Start with defaults, then enable features as needed. See [Enable All Features](docs/enable-all-v8.md) for a full-feature config profile.

## Agent & Operator Commands

```bash
openclaw engram stats                        # Memory counts, search status, health
openclaw engram search "your query"          # Search memories from CLI
openclaw engram compat --strict              # Compatibility check
openclaw engram benchmark-status             # Benchmark/eval harness packs, runs, shadow recalls, latest summaries
openclaw engram benchmark-validate <path>    # Validate a benchmark manifest or pack directory
openclaw engram benchmark-import <path>      # Import a validated benchmark pack into the eval store
openclaw engram benchmark-baseline-snapshot  # Capture a typed baseline snapshot of the latest completed benchmark runs
openclaw engram benchmark-baseline-report    # Compare the current eval store against a stored baseline snapshot
openclaw engram benchmark-ci-gate            # Compare base vs candidate eval stores and fail on regressions
openclaw engram objective-state-status       # Objective-state snapshot counts and latest stored snapshot
openclaw engram causal-trajectory-status    # Causal-trajectory record counts and latest stored chain
openclaw engram trust-zone-status           # Trust-zone record counts and latest stored record
openclaw engram trust-zone-promote          # Dry-run or apply a trust-zone promotion with provenance/corroboration enforcement
openclaw engram harmonic-search <query>     # Preview blended harmonic retrieval matches
openclaw engram verified-recall-search <query> # Preview verified episodic recall matches
openclaw engram commitment-status          # Commitment ledger counts and latest recorded obligation
openclaw engram commitment-record          # Record a typed commitment ledger entry
openclaw engram commitment-set-state      # Transition a commitment to open|fulfilled|cancelled|expired
openclaw engram commitment-lifecycle-run  # Expire overdue commitments and clean aged resolved entries
openclaw engram work-product-status         # Work-product ledger counts and latest recorded output
openclaw engram work-product-record         # Record a typed work-product ledger entry
openclaw engram work-product-recall-search <query> # Preview reusable work products from the creation-memory ledger
openclaw engram utility-status              # Utility-learning telemetry counts and latest observed outcome event
openclaw engram utility-record              # Record a typed utility-learning telemetry event
openclaw engram utility-learning-status     # Latest offline utility-learning snapshot and learned weight counts
openclaw engram utility-learn               # Learn bounded offline promotion/ranking weights from recorded utility events
openclaw engram conversation-index-health    # Conversation index status
openclaw engram graph-health                 # Entity graph status
openclaw engram tier-status                  # Hot/cold tier metrics
openclaw engram policy-status                # Lifecycle policy snapshot
```

## Configuration

All settings live in `openclaw.json` under `plugins.entries.openclaw-engram.config`. `openaiApiKey` is optional when local LLM or gateway fallback paths are available.

Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `openaiApiKey` | `(env fallback)` | Optional OpenAI API key or `${ENV_VAR}` reference for direct-client paths |
| `model` | `gpt-5.2` | LLM model for extraction |
| `searchBackend` | `"qmd"` | Search engine: `qmd`, `orama`, `lancedb`, `meilisearch`, `remote`, `noop` |
| `qmdEnabled` | `true` | Enable QMD hybrid search |
| `memoryDir` | `~/.openclaw/workspace/memory/local` | Memory storage root |
| `evalHarnessEnabled` | `false` | Enable the evaluation harness for benchmark packs, run summaries, and shadow recall bookkeeping |
| `evalShadowModeEnabled` | `false` | Record live recall decisions to the eval store without changing injected output |
| `benchmarkBaselineSnapshotsEnabled` | `false` | Enable versioned baseline snapshot artifacts for the latest completed benchmark runs |
| `benchmarkDeltaReporterEnabled` | `false` | Enable named-baseline delta reports against the current eval store |

The repo's required benchmark check uses the committed fixture snapshot at
`tests/fixtures/eval-ci/store/baselines/required-main.json` as the stable
release baseline for PR gating. During the rollout PR that first introduces
that file, the gate bootstraps from the candidate branch snapshot once; after
that, PRs resolve the required baseline from the base branch checkout.
| `evalStoreDir` | `{memoryDir}/state/evals` | Root directory for benchmark packs, run summaries, and shadow recall records |
| `objectiveStateMemoryEnabled` | `false` | Enable the objective-state memory foundation for normalized world/tool state snapshots |
| `objectiveStateSnapshotWritesEnabled` | `false` | Permit objective-state snapshot writers to persist typed state records |
| `objectiveStateRecallEnabled` | `false` | Inject prompt-relevant objective-state snapshots into recall context |
| `objectiveStateStoreDir` | `{memoryDir}/state/objective-state` | Root directory for objective-state snapshots |
| `causalTrajectoryMemoryEnabled` | `false` | Enable the causal-trajectory memory foundation for typed causal chains |
| `causalTrajectoryStoreDir` | `{memoryDir}/state/causal-trajectories` | Root directory for causal-trajectory records |
| `causalTrajectoryRecallEnabled` | `false` | Inject prompt-relevant causal trajectories into recall context |
| `actionGraphRecallEnabled` | `false` | Write action-conditioned causal-stage edges from typed trajectory records into the causal graph |
| `trustZonesEnabled` | `false` | Enable the trust-zone memory foundation and operator-facing promotion path for quarantine, working, and trusted records |
| `quarantinePromotionEnabled` | `false` | Allow explicit trust-zone promotions such as `quarantine -> working` and guarded `working -> trusted` |
| `trustZoneStoreDir` | `{memoryDir}/state/trust-zones` | Root directory for trust-zone records |
| `trustZoneRecallEnabled` | `false` | Inject prompt-relevant working and trusted trust-zone records into recall context |
| `memoryPoisoningDefenseEnabled` | `false` | Enable deterministic provenance trust scoring and corroboration requirements for risky trusted promotions |
| `memoryRedTeamBenchEnabled` | `false` | Enable typed memory red-team benchmark pack support and status accounting for poisoning-defense suites |
| `harmonicRetrievalEnabled` | `false` | Enable harmonic retrieval blending over abstraction nodes and cue anchors, including the dedicated recall section and `harmonic-search` diagnostics |
| `abstractionAnchorsEnabled` | `false` | Enable typed cue-anchor indexing for abstraction nodes and expose the anchor store through status tooling |
| `verifiedRecallEnabled` | `false` | Inject prompt-relevant memory boxes only when their cited source memories verify as non-archived episodes |
| `semanticRulePromotionEnabled` | `false` | Enable deterministic promotion of explicit `IF ... THEN ...` rules from verified episodic memories via `openclaw engram semantic-rule-promote` |
| `semanticRuleVerificationEnabled` | `false` | Verify promoted semantic rules against their cited source episodes at recall time and inject a dedicated `Verified Rules` section via `openclaw engram semantic-rule-verify` |
| `creationMemoryEnabled` | `false` | Enable the creation-memory foundation, including the work-product ledger and operator-facing write/status commands |
| `memoryUtilityLearningEnabled` | `false` | Enable typed utility-learning telemetry storage, offline learning, and runtime loading of learned utility snapshots |
| `promotionByOutcomeEnabled` | `false` | Apply bounded learned utility weights to ranking heuristics and tier-migration thresholds when a learner snapshot is available |
| `commitmentLedgerEnabled` | `false` | Enable the explicit commitment ledger for promises, follow-ups, deadlines, and unfinished obligations |
| `commitmentLifecycleEnabled` | `false` | Enable commitment lifecycle transitions, stale tracking, and resolved-entry cleanup for the commitment ledger |
| `commitmentStaleDays` | `14` | Days before an open commitment without a due date is considered stale in lifecycle status |
| `commitmentLedgerDir` | `{memoryDir}/state/commitment-ledger` | Root directory for typed commitment ledger entries |
| `resumeBundlesEnabled` | `false` | Enable typed resume-bundle storage plus the operator-facing `resume-bundle-status`, `resume-bundle-record`, and `resume-bundle-build` commands |
| `resumeBundleDir` | `{memoryDir}/state/resume-bundles` | Root directory for typed resume bundles |
| `workProductRecallEnabled` | `false` | Inject prompt-relevant work-product ledger entries into recall and expose `openclaw engram work-product-recall-search` |
| `workProductLedgerDir` | `{memoryDir}/state/work-product-ledger` | Root directory for typed work-product ledger entries |

Full reference: [Config Reference](docs/config-reference.md)

## Documentation

- [Getting Started](docs/getting-started.md) — Installation, setup, first-run verification
- [Search Backends](docs/search-backends.md) — Choosing and configuring search engines
- [Writing a Search Backend](docs/writing-a-search-backend.md) — Build your own adapter
- [Config Reference](docs/config-reference.md) — Every setting with defaults
- [Evaluation Harness](docs/evaluation-harness.md) — Benchmark pack, shadow recall, and CI delta gate format
- [Architecture Overview](docs/architecture/overview.md) — System design and storage layout
- [Retrieval Pipeline](docs/architecture/retrieval-pipeline.md) — How recall works
- [Memory Lifecycle](docs/architecture/memory-lifecycle.md) — Write, consolidation, expiry
- [Enable All Features](docs/enable-all-v8.md) — Full-feature config profile
- [Operations](docs/operations.md) — Backup, export, maintenance
- [Namespaces](docs/namespaces.md) — Multi-agent memory isolation
- [Shared Context](docs/shared-context.md) — Cross-agent intelligence
- [Identity Continuity](docs/identity-continuity.md) — Consistent agent personality
- [Agentic Memory Roadmap](docs/plans/2026-03-06-engram-agentic-memory-roadmap.md) — Benchmark-first roadmap and PR slices

## Developer Install

```bash
git clone https://github.com/joshuaswarren/openclaw-engram.git \
  ~/.openclaw/extensions/openclaw-engram
cd ~/.openclaw/extensions/openclaw-engram
npm ci && npm run build
```

Run tests:

```bash
npm test              # Full suite (672 tests)
npm run check-types   # TypeScript type checking
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write tests for new functionality
4. Ensure `npm test` and `npm run check-types` pass
5. Submit a pull request

## License

[MIT](LICENSE)
