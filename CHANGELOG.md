# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

<!-- New items go here before they're released -->

### Changed
- PR #57 work extraction boundary hardening:
  - Preserved linked work payload text containing wrapper-like tokens such as `[WORK_LAYER_CONTEXT link_to_memory=...]`.
  - Escaped wrapper opener/closer tokens during work-layer wrapping and restored them only after boundary cleanup.
  - Added regression coverage for metadata-like literal opener text in linked payloads.
- PR #42 review-hardening backfill for Cursor findings (PRs #37-#40):
  - Fixed continuity incident read-limit handling to guard `NaN` limits and to apply state filtering before result capping.
  - Fixed continuity incident close-path ID lookup to verify parsed frontmatter ID before using filename suffix matches.
  - Simplified continuity incident state parsing (removed redundant ternary branch).
  - Fixed identity anchor merge to always persist sentinel cleanup for existing sections.
  - Gated continuity-audit reference reads behind `continuityAuditEnabled` and bounded compounding incident scans.
  - Added regression tests for all above cases (storage, tools/CLI state filtering, compounding gate, anchor sentinel cleanup).
- PR #34 recall hardening + dedupe tooling:
  - Switched recall retrieval to daemon-preferred `search()` with bounded hybrid backfill to reduce contention and preserve fail-open behavior.
  - Kept `hybridSearch()` as BM25+vector diversification path (no daemon short-circuit), so backfill can broaden recall candidates.
  - Added graph-assist guardrails so full-mode graph expansion requires `multiGraphMemoryEnabled=true`.
  - Added bounded TMT summary input capping helpers to avoid oversized summarization payloads.
- PR #33 stability pass:
  - Fixed `buildRecallQueryPolicy` to preserve raw non-cron prompts (no whitespace normalization) when cron recall policy is not active.
  - Replaced cron prompt bullet/numbered-line regex scoring with deterministic parsing to avoid regex-risk findings on untrusted input.
  - Added regression coverage for raw-prompt preservation in non-cron and cron-policy-disabled paths.

### Added
- v8.8 network sync Task 1 (WebDAV module):
  - Added `src/network/webdav.ts` with opt-in `WebDavServer` startup (`enabled=false` by default).
  - Added strict allowlist path scoping so requests are limited to explicit root aliases and traversal escapes are rejected.
  - Added optional HTTP Basic auth support and minimal DAV/read endpoints (`OPTIONS`, `PROPFIND`, `GET`, `HEAD`).
  - Added `tests/network-webdav.test.ts` coverage for disabled-by-default behavior, allowlist enforcement, traversal blocking, and auth gating.
- v8.8 network sync Task 2 (Tailscale helper module):
  - Added `src/network/tailscale.ts` with `TailscaleHelper` status gating (`available` + `running`) and a guarded `syncDirectory(...)` helper.
  - Added default command-runner plumbing for `tailscale version`, `tailscale status --json`, and rsync execution with timeout handling.
  - Added `tests/network-tailscale.test.ts` coverage for availability checks, JSON status parsing, daemon-state enforcement, and sync argument construction.
- v8.8 network sync Task 3 (CLI command surfaces):
  - Added network CLI wrappers in `src/cli.ts`: `runTailscaleStatusCliCommand`, `runTailscaleSyncCliCommand`, `runWebDavServeCliCommand`, and `runWebDavStopCliCommand`.
  - Added command surfaces: `openclaw engram tailscale-status`, `openclaw engram tailscale-sync`, `openclaw engram webdav-serve`, and `openclaw engram webdav-stop`.
  - Added `tests/cli-network-commands.test.ts` coverage for helper passthrough, WebDAV serve/stop lifecycle, and auth argument validation.
- v8.8 network sync Task 4 (security + docs):
  - Updated `docs/operations.md` with network sync/WebDAV command runbook and operational safety notes.
  - Updated `SECURITY.md` with explicit v8.8 network-surface guardrails (opt-in defaults, allowlist-only exposure, loopback bind posture, and auth requirements).
- v8.9 compatibility diagnostics Task 1 (core checks):
  - Added `src/compat/types.ts` for compatibility report/check contracts (`ok|warn|error` + summary metadata).
  - Added `src/compat/checks.ts` with deterministic offline compatibility checks for plugin manifest shape, package wiring, core hook registration, Node runtime floor, and QMD binary availability.
  - Added `tests/compat-checks.test.ts` coverage for healthy fixtures, malformed/missing files, and warn/error remediation paths.
- v8.9 compatibility diagnostics Task 2 (CLI command surface):
  - Added `openclaw engram compat [--json] [--strict]` in `src/cli.ts` for local compatibility diagnostics.
  - Added strict-mode exit behavior (`exitCode=1` when warnings/errors are present) and machine-readable JSON output mode.
  - Added `runCompatCliCommand` wrapper plus `tests/cli-compat.test.ts` coverage for default vs strict exit behavior.
- v8.9 compatibility diagnostics Task 3 (fixture-backed diagnostics tests):
  - Added fixture catalog under `tests/compat-fixtures/` for healthy, missing-manifest, and empty-package repository states.
  - Added `tests/compat-fixtures.test.ts` to validate deterministic check outcomes across fixture scenarios.
  - Added fixture usage notes in `tests/compat-fixtures/README.md`.
- v8.9 compatibility diagnostics Task 4 (docs + rollout guidance):
  - Updated `docs/operations.md` CLI runbook with `openclaw engram compat` usage and strict/json mode guidance.
  - Updated `README.md` with compatibility diagnostics quickstart commands for operator rollout checks.
- v8.10 FAISS conversation index Task 1 (config contracts + docs):
  - Added FAISS backend config fields to plugin config contracts and schema (`conversationIndexFaiss*`) while keeping `conversationIndexBackend` default as `qmd`.
  - Added strict parsing/clamping tests in `tests/config-conversation-index-faiss.test.ts`, including zero-safe semantics and malformed input handling.
  - Updated `docs/config-reference.md` and `docs/context-retention.md` with FAISS backend configuration and rollout notes.
- v8.10 FAISS conversation index Task 2 (adapter interface + fail-open wrappers):
  - Added `src/conversation-index/faiss-adapter.ts` with subprocess-backed FAISS adapter APIs (`upsertChunks`, `searchChunks`, `health`) and bounded timeout/stderr/JSON error handling.
  - Added fail-open helper wrappers in `src/conversation-index/indexer.ts` and `src/conversation-index/search.ts` so adapter failures degrade to no-op/empty recall instead of throwing into hook paths.
  - Added `tests/conversation-index-faiss-adapter.test.ts` coverage for success, timeout, non-zero exit, malformed payload, and fail-open wrapper behavior.
- v8.10 FAISS conversation index Task 3 (Python sidecar CLI + smoke tests):
  - Added `scripts/faiss_index.py` JSON-in/JSON-out sidecar commands (`upsert`, `search`, `health`) with fail-open error envelopes and deterministic local `__hash__` embedding mode for smoke validation.
  - Added `scripts/faiss_requirements.txt` and `scripts/faiss/README.md` with dependency and operational contract guidance.
  - Added `tests/conversation-index-faiss-smoke.test.ts` with sidecar contract checks and a dependency-gated FAISS upsert/search smoke path.
- v8.10 FAISS conversation index Task 4 (orchestrator backend wiring + parity tests):
  - Wired orchestrator conversation-index flow to select `qmd` or `faiss` backend paths for startup health checks, index updates, and semantic recall queries.
  - Preserved fail-open recall behavior for FAISS search/upsert failures and kept semantic-recall section formatting backend-agnostic via shared formatter logic.
  - Added `tests/conversation-index-integration.test.ts` coverage for backend routing (`qmd` vs `faiss`), FAISS fail-open recall, formatting parity, and FAISS update-path routing.
- v8.10 FAISS conversation index Task 5 (ops health command + docs):
  - Added orchestrator `getConversationIndexHealth()` with backend-aware status (`qmd`/`faiss`), chunk-doc counts, and last-update metadata.
  - Added CLI command surface `openclaw engram conversation-index-health` via `runConversationIndexHealthCliCommand`.
  - Added `tests/cli-conversation-index-health.test.ts` coverage for CLI wrapper behavior and backend health/fail-open scenarios.
  - Updated `docs/operations.md` and `docs/setup-config-tuning.md` with conversation-index health command usage.
- v8.12 graph retrieval phase 2 Task 2 (richer graph provenance snapshots):
  - Extended graph spreading-activation outputs to include per-result provenance (`seed`, `hopDepth`, `decayedWeight`, `graphType`).
  - Persisted bounded provenance in `last_graph_recall.json` with capped seed/expanded arrays for high-traffic safety.
  - Updated graph explain output (`memory_graph_explain_last_recall`) to include concise per-result provenance details.
  - Added parsing/bounding helper in `src/recall-state.ts` and expanded graph integration tests for provenance fields.
  - Updated `docs/architecture/retrieval-pipeline.md` with graph provenance snapshot behavior.
- v8.12 graph retrieval phase 2 Task 1 (expansion scoring controls):
  - Added graph expansion scoring config knobs: `graphExpansionActivationWeight`, `graphExpansionBlendMin`, and `graphExpansionBlendMax` with clamped parse-time handling.
  - Added bounded blend function for graph-expanded candidate scoring to combine normalized activation with seed QMD signal while enforcing configurable score bounds.
  - Updated graph expansion path in orchestrator to use blended scoring per namespace seed set.
  - Added `tests/graph-recall-scoring.test.ts` for monotonic blend behavior and filter-before-cap invariants, plus config clamp/default coverage updates.
  - Documented new graph scoring controls in `docs/config-reference.md` and `openclaw.plugin.json`.
- v8.11 compression optimizer Task 5 (runtime integration + guardrails):
  - Added runtime recall integration for active compression guidelines via a guarded section injected only when context-compression actions and guideline learning are both enabled.
  - Added fail-open guideline parsing/extraction helper (`formatCompressionGuidelinesForRecall`) that reads only the suggested-guidelines block for recall usage.
  - Preserved zero-change path behavior when optimizer learning is disabled by short-circuiting before guideline/state reads.
  - Added `tests/recall-compression-guideline-application.test.ts` coverage for disabled (byte-equivalent guard), enabled, and malformed guideline/state cases.
- v8.11 compression optimizer Task 4 (optimizer tool + cron-safe entry point):
  - Added public orchestrator entry point `optimizeCompressionGuidelines(...)` with `dryRun` + `eventLimit` controls and explicit optimization summary fields.
  - Added `compression_guidelines_optimize` tool with dry-run support and summary output including old/new guideline versions and changed-rule count.
  - Kept runtime fail-open behavior by reusing deterministic baseline + optional semantic refinement pipeline in the shared optimizer path.
  - Added `tests/tools-compression-optimize.test.ts` coverage for disabled gate handling, parameter passthrough, and summary output.
  - Updated `docs/operations.md` with tool usage and cron-safe execution guidance.
- v8.11 compression optimizer Task 3 (optional semantic refinement pass):
  - Added optional semantic refinement pipeline in `src/compression-optimizer.ts` behind explicit enable flag + hard timeout fail-open behavior.
  - Added config surface for refinement gating: `compressionGuidelineSemanticRefinementEnabled` and `compressionGuidelineSemanticTimeoutMs` (with schema/UI wiring and parse-time clamping).
  - Wired orchestrator guideline-learning to run deterministic baseline first, then optional semantic refinement via bounded local-LLM runner before persisting outputs.
  - Added `tests/compression-optimizer-semantic.test.ts` coverage for disabled, timeout, runner-error fail-open behavior, and bounded update application.
  - Updated `docs/setup-config-tuning.md` with rollout guidance for semantic refinement.
- v8.11 compression optimizer Task 2 (deterministic engine + orchestrator wiring):
  - Added `src/compression-optimizer.ts` with deterministic telemetry aggregation, bounded rule-delta computation, and conservative sparse-sample behavior.
  - Included downstream recall-quality marker parsing from telemetry notes to inform per-action confidence and direction.
  - Wired orchestrator guideline-learning pass to compute/write versioned optimizer state and guideline markdown from the deterministic candidate.
  - Added `tests/compression-optimizer.test.ts` and updated `tests/orchestrator-compression-guidelines.test.ts` for deterministic candidate/output and state-write coverage.
- v8.11 compression optimizer Task 1 (state model + versioned storage):
  - Added typed optimizer state contracts in `src/types.ts` for version, source window, event counts, and guideline version metadata.
  - Added strict/fail-open storage APIs in `src/storage.ts`: `writeCompressionGuidelineOptimizerState` and `readCompressionGuidelineOptimizerState`.
  - Added `tests/storage-policy-state.test.ts` coverage for optimizer state round-trip, malformed-state fail-open fallback, and missing-state behavior.
  - Updated `docs/config-reference.md` to document persisted optimizer state at `state/compression-guideline-state.json`.
- v8.7 custom memory routing rules Task 1 (routing engine):
  - Added `src/routing/engine.ts` with deterministic route-rule evaluation, regex/keyword matching, and priority-ordered selection.
  - Added safe route target validation for categories and namespaces (path traversal and separator rejection).
  - Added `tests/routing-engine.test.ts` coverage for matching behavior, ordering, and target validation guardrails.
- v8.7 custom memory routing rules Task 2 (config + persisted rules):
  - Added `src/routing/store.ts` with fail-open persisted routing rule reads, normalized writes, and upsert/remove helpers.
  - Added config surface for routing rules: `routingRulesEnabled` and `routingRulesStateFile`.
  - Added `tests/routing-store.test.ts` and `tests/config-routing-rules.test.ts` coverage for store behavior and config defaults/overrides.
- v8.7 custom memory routing rules Task 3 (CLI management commands):
  - Added `openclaw engram route list|add|remove|test` command support in `src/cli.ts`.
  - Added `runRouteCliCommand` wrapper with target parsing/validation and routing rule store integration.
  - Added `tests/cli-routing-commands.test.ts` coverage for route command add/list/test/remove behavior and validation failures.
- v8.7 custom memory routing rules Task 4 (orchestrator wiring + docs):
  - Added write-time routing in `persistExtraction(...)` so rule matches can retarget extracted facts by category/namespace before persistence.
  - Added fail-open behavior for routing rule load/evaluation errors to preserve default extraction writes.
  - Added `tests/orchestrator-routing-rules.test.ts` coverage for category+namespace reroute behavior.
  - Documented routing config/ops surfaces in `docs/config-reference.md` and `docs/operations.md`.
- v8.7 work management Task 3 (board generation + import/export helpers):
  - Added `src/work/board.ts` with board snapshot export, Kanban markdown rendering, and snapshot import helpers.
  - Added `tests/work-board.test.ts` coverage for project-scoped board export and import create/update behavior.
  - Updated `docs/operations.md` with work board helper usage notes.
- v8.7 work management Task 2 (task/project CLI command slice):
  - Added `openclaw engram task <action>` and `openclaw engram project <action>` command surfaces in `src/cli.ts`.
  - Added CLI wrappers `runWorkTaskCliCommand` and `runWorkProjectCliCommand` with validation for status/priority transitions and required IDs.
  - Added `tests/cli-work-commands.test.ts` coverage for task/project CRUD flows, linkage behavior, and transition guardrails.
- v8.7 work management Task 1 (work item models + storage slice):
  - Added `src/work/types.ts` with task/project model contracts, ownership metadata, and status enums.
  - Added `src/work/storage.ts` for markdown-frontmatter task/project persistence, CRUD operations, status transitions, and task-to-project linkage.
  - Added `tests/work-storage.test.ts` coverage for task/project CRUD, transition guards, linkage behavior, and frontmatter file persistence.
- v8.6 observation-ledger maintenance Task 5 (docs/runbook slice):
  - Updated `docs/operations.md` with an observation-ledger maintenance runbook covering archive/rebuild/migrate commands.
  - Documented dry-run defaults, `--write` mutation mode, and operational guarantees (backup-first writes, deterministic UTC hour bucketing, idempotent no-op migration behavior).
- v8.6 observation-ledger maintenance Task 4 (CLI command surfaces slice):
  - Added CLI wrappers in `src/cli.ts` for archive/rebuild/migrate observation maintenance flows with safe dry-run defaults.
  - Added commands: `openclaw engram archive-observations`, `openclaw engram rebuild-observations`, and `openclaw engram migrate-observations`.
  - Added `tests/cli-maintenance-suite.test.ts` coverage for dry-run defaults and explicit write-mode behavior.
- v8.6 observation-ledger maintenance Task 3 (migration service slice):
  - Added `src/maintenance/migrate-observations.ts` to migrate legacy observation-ledger JSONL shapes into canonical `sessionKey/hour` aggregates.
  - Added dry-run-by-default migration behavior with backup-first replacement of `state/observation-ledger/rebuilt-observations.jsonl`.
  - Added deterministic UTC hour normalization for timezone-less legacy timestamps and bounded malformed-line fail-open parsing.
  - Added `tests/migrate-observations.test.ts` coverage for dry-run scanning, mixed-shape migration, malformed input handling, and backup failure behavior.
- v8.6 observation-ledger maintenance Task 2 (rebuild service slice):
  - Added `src/maintenance/rebuild-observations.ts` to rebuild an observation ledger from transcript history with deterministic session/hour aggregation.
  - Added dry-run-by-default rebuild behavior with backup-first replacement of `state/observation-ledger/rebuilt-observations.jsonl`.
  - Added fail-open parsing for malformed transcript lines during rebuild.
  - Added `tests/rebuild-observations.test.ts` coverage for dry-run, deterministic rebuild output, backup behavior, and malformed-line handling.
- v8.6 observation-ledger maintenance Task 1 (archive service slice):
  - Added `src/maintenance/archive-observations.ts` with deterministic archive candidate scanning across dated transcript, tool-usage, and hourly-summary artifacts.
  - Added dry-run-by-default archival behavior with backup-first copy-then-delete flow into `archive/observations/<timestamp>/...`.
  - Preserved zero-limit compatibility semantics (`retentionDays=0` disables archival).
  - Added `tests/archive-observations.test.ts` coverage for dry-run, live archive, candidate filtering, and zero-retention behavior.
- v8.6 replay ingestion Task 3 (CLI + integration slice):
  - Added `openclaw engram replay` command with source selection, date-range filtering, dry-run, offset/max, and batch controls.
  - Added replay command integration helper in `src/cli.ts` that wires source normalizers into replay execution and optional post-replay consolidation.
  - Added `Orchestrator.ingestReplayBatch(...)` to enqueue replay batches through the existing extraction pipeline with preserved replay timestamps/session keys.
  - Added `tests/cli-replay.test.ts` coverage for dry-run and live ingestion paths.
- v8.6 replay ingestion Task 2 (source normalizers slice):
  - Added source normalizers for `openclaw`, `claude`, and `chatgpt` exports in `src/replay/normalizers/*`.
  - Added robust shape handling for JSON/JSONL transcript exports, including ChatGPT mapping exports and Claude `chat_messages`.
  - Added `tests/replay-normalizers.test.ts` coverage for source parsing, strict-mode validation behavior, role/content/timestamp normalization, and default session key fallbacks.
- v8.6 replay ingestion Task 1 (core contracts slice):
  - Added `src/replay/types.ts` with canonical replay turn schema, parser contracts, and strict validation helpers.
  - Added `src/replay/runner.ts` with source normalizer registry helpers and replay execution flow (dry-run, date range, offset, batching, progress summary).
  - Added `tests/replay-types.test.ts` coverage for validation, batching, range filtering, offset/max limits, dry-run behavior, and registry duplicate guards.
- v8.5 active session observer + heartbeat thresholds slice:
  - Added `src/session-observer-state.ts` to persist per-session observer cursors and threshold/debounce decisions.
  - Added heartbeat observer integration (`agent_heartbeat`) to queue proactive extraction when session growth crosses configured byte/token bands.
  - Added config surface and schema/docs wiring: `sessionObserverEnabled`, `sessionObserverDebounceMs`, `sessionObserverBands`.
  - Added tests: `tests/session-observer-state.test.ts` and `tests/heartbeat-observe-trigger.test.ts`.
  - Normalized session-key examples in docs/comments to generic placeholders to avoid installation-specific identifiers.
- v8.4 improvement-loop register slice (Task 7 / PR #43):
  - Added structured improvement-loop register parsing/serialization helpers in `src/identity-continuity.ts`.
  - Extended `StorageManager` with typed register APIs: read/write register, upsert loop, and review loop metadata updates.
  - Added `continuity_loop_add_or_update` and `continuity_loop_review` tools for managing recurring continuity loops.
  - Extended continuity audit synthesis to detect stale active loops by cadence and surface stale-loop signals/actions.
  - Added `tests/improvement-loop-register.test.ts` and expanded continuity-audit test coverage for stale-loop detection.
- v8.4 documentation/templates slice (Task 8):
  - Added `docs/identity-continuity.md` with artifact contracts, safety boundaries, and rollout tiers.
  - Added generic templates for identity anchors, continuity incidents, and continuity audits.
  - Linked identity continuity docs from `README.md` and `docs/README.md`.
- v8.4 identity injection budgeting + mode gating slice (PR #41):
  - Added runtime identity continuity injection modes (`recovery_only`, `minimal`, `full`) with explicit recovery-intent gating and minimal-mode downgrade safeguards.
  - Added per-section `identityMaxInjectChars` enforcement with trim marker + telemetry for injected chars and truncation state.
  - Extended recall telemetry (`recall_summary`) and last-recall snapshots with identity injection fields for observability/debugging.
  - Added `tests/identity-injection-budget.test.ts` and extended recall mode/telemetry tests for identity mode reachability and budget behavior.
  - Updated retrieval architecture documentation with identity continuity assembly order and telemetry fields.
- v8.4 continuity audit generator slice (PR #40):
  - Added `continuity_audit_generate` tool for deterministic weekly/monthly continuity audit artifacts.
  - Extended `CompoundingEngine` with continuity audit synthesis and signal checks (anchor presence, incident counts, improvement-loop presence, compounding pattern count).
  - Added weekly compounding report linking for available continuity audits when `continuityAuditEnabled=true`.
  - Added `tests/continuity-audit.test.ts` coverage for audit generation, compounding linkage, and tool behavior.
  - Updated `docs/compounding.md` with continuity audit workflow and output locations.
- v8.4 continuity incident workflow slice (PR #39):
  - Added `continuity_incident_open`, `continuity_incident_close`, and `continuity_incident_list` tools.
  - Added `openclaw engram continuity incidents`, `openclaw engram continuity incident-open`, and `openclaw engram continuity incident-close` CLI commands.
  - Added validation for required incident closure fields and state-filtered incident listing behavior.
  - Added `tests/continuity-incidents.test.ts` coverage for tool gating, open/close flows, and listing behavior.
  - Documented continuity incident tools and CLI usage in API/operations docs.
- v8.4 identity anchor tooling slice (PR #38):
  - Added `identity_anchor_get` and `identity_anchor_update` tools behind `identityContinuityEnabled`.
  - Added conservative, section-aware identity-anchor merge behavior to avoid destructive overwrites.
  - Added identity-anchor update audit logging for operational traceability.
  - Added `tests/tools-identity-anchor.test.ts` coverage for gating, retrieval, merge semantics, and validation.
  - Documented identity anchor tools and storage location in API/operations docs.
- v8.4 identity continuity storage slice (PR #37):
  - Added identity continuity artifact types and helpers for anchor, incidents, audits, and improvement-loop storage paths.
  - Added `src/identity-continuity.ts` to create/parse continuity incidents with explicit open/close lifecycle transitions.
  - Extended `StorageManager` with typed read/write APIs for identity continuity artifacts and append-only incident handling.
  - Added fail-open parsing behavior for malformed continuity incident files to preserve baseline runtime behavior.
  - Added `tests/identity-continuity-storage.test.ts` coverage for storage round-trips, incident close transitions, and malformed-file handling.
- v8.4 identity continuity config slice (PR #36):
  - Added new config surface: `identityContinuityEnabled`, `identityInjectionMode`, `identityMaxInjectChars`, `continuityIncidentLoggingEnabled`, and `continuityAuditEnabled`.
  - Added parser semantics for bounded identity injection chars and dynamic default for incident logging (`identityContinuityEnabled` when unset).
  - Added config-schema/UI metadata and config-reference documentation for v8.4 identity continuity.
  - Added `tests/config-identity-continuity.test.ts` and updated typed test fixtures to match the expanded `PluginConfig` contract.
- v8.3 PR 21D (guideline learning + docs hardening slice):
  - Added consolidation-integrated, fail-open compression guideline learning pass behind `compressionGuidelineLearningEnabled`.
  - Added deterministic synthesis of `state/compression-guidelines.md` from recent `state/memory-actions.jsonl` telemetry.
  - Added test coverage for guideline synthesis output and flag-gated pass execution in `tests/orchestrator-compression-guidelines.test.ts`.
  - Expanded v8.3 docs with tool/state artifact details and operator checks for guideline-learning rollout.
- v8.3 PR 21C (compression action tools + telemetry slice):
  - Added `context_checkpoint` and `memory_action_apply` tools behind `contextCompressionActionsEnabled`.
  - Added append-only telemetry wiring through `Orchestrator.appendMemoryActionEvent(...)` to persist policy-learning events into namespace-scoped `state/memory-actions.jsonl`.
  - Added fail-open behavior for tool telemetry writes so action paths do not block runtime flow on storage errors.
  - Added tool-focused coverage in `tests/tools-compression-actions.test.ts` for disabled-mode gating, telemetry writes, namespace handling, and fail-open behavior.
- v8.3 PR 21B (proactive extraction slice):
  - Added a proactive second-pass extraction path in `ExtractionEngine` behind `proactiveExtractionEnabled`.
  - Added strict cap enforcement for proactive follow-up questions via `maxProactiveQuestionsPerExtraction` with zero-safe semantics.
  - Added fail-open behavior: proactive-pass failures are logged and baseline extraction results are preserved.
  - Added question merge/dedupe helper coverage in `tests/extraction-proactive.test.ts`.
- v8.3 PR 21A (proactive/policy-learning foundation slice):
  - Added new config surface (default off): `proactiveExtractionEnabled`, `contextCompressionActionsEnabled`, `compressionGuidelineLearningEnabled`.
  - Added new v8.3 policy limits with zero-safe semantics: `maxProactiveQuestionsPerExtraction` and `maxCompressionTokensPerHour`.
  - Added typed policy-state storage primitives in `StorageManager` for `state/memory-actions.jsonl` and `state/compression-guidelines.md`.
  - Added test coverage for proactive/policy config parsing and policy-state storage read/write behavior.
- v8.3 PR 20D (lifecycle retrieval + docs slice):
  - Added lifecycle-aware retrieval weighting in shared score post-processing with boosts for `active`/`validated` memories and penalties for `candidate`/`stale`/`archived` states.
  - Added stronger retrieval penalty for `verificationState: disputed`.
  - Added optional stale retrieval filtering (`lifecycleFilterStaleEnabled`) applied before final top-K cap.
  - Preserved fail-open behavior for legacy memories with no lifecycle metadata.
  - Added retrieval tests covering lifecycle weighting, stale filtering, and fail-open legacy behavior.
- v8.3 PR 20C (lifecycle consolidation + metrics slice):
  - Added lifecycle policy config surface (`lifecyclePolicyEnabled`, thresholds, protected categories, metrics toggle) across `PluginConfig`, config parsing, and plugin schema/UI hints.
  - Wired lifecycle scoring pass into consolidation to persist lifecycle metadata (`lifecycleState`, `heatScore`, `decayScore`, `lastValidatedAt`) only when changed.
  - Added lifecycle metrics snapshot output at `state/lifecycle-metrics.json` with state counts, transition counts, stale ratio, and disputed ratio.
  - Added lifecycle policy tests for config parsing and consolidation/metrics integration.
- v8.3 PR 20B (deterministic lifecycle engine slice):
  - Added `src/lifecycle.ts` with deterministic, bounded lifecycle scoring functions (`computeHeat`, `computeDecay`) and transition logic (`decideLifecycleTransition`).
  - Added lifecycle guardrails: archived is terminal, disputed memories never auto-promote to active, and protected categories are not auto-archived.
  - Added `tests/lifecycle.test.ts` coverage for bounds, monotonic scoring behavior, and transition guardrails.
- v8.3 PR 20A (lifecycle data-model slice):
  - Added optional lifecycle policy frontmatter fields to `MemoryFrontmatter`: `lifecycleState`, `verificationState`, `policyClass`, `lastValidatedAt`, `decayScore`, and `heatScore`.
  - Extended memory frontmatter serialization/parsing to persist and restore lifecycle metadata, including zero-valued score fields.
  - Added storage lifecycle round-trip tests for parse/serialize behavior and legacy compatibility when lifecycle fields are absent.
- v8.2 PR 19A (planner-gating slice):
  - New config flag `graphRecallEnabled` (default `false`) to explicitly opt into graph recall planner mode.
  - New `resolveEffectiveRecallMode()` guard in recall orchestration: `graph_mode` is only active when both `graphRecallEnabled` and `multiGraphMemoryEnabled` are enabled; otherwise behavior degrades to baseline `full` recall.
  - Added planner/config tests for graph-mode gating and opt-in parsing behavior.
- v8.2 PR 19B (graph-recall integration slice):
  - Added graph-mode recall expansion in `recallInternal`: when planner selects `graph_mode`, QMD seeds are expanded via `GraphIndex.spreadingActivation(...)`, merged/deduped with QMD candidates, then fed through existing boost/rerank/cap stages.
  - Added `state/last_graph_recall.json` trace output capturing graph recall mode, query hash/length, namespace scope, seed paths, and expanded candidates for explainability/debugging.
  - Added helper/test coverage for graph candidate merge semantics and storage-relative graph path resolution.
  - Added integration coverage asserting graph-mode recall writes a snapshot.
- v8.2 PR 19C (graph explainability slice):
  - Added `memory_graph_explain_last_recall` tool to inspect the latest graph-recall snapshot (seed paths + expanded candidates).
  - Added orchestrator APIs `getLastGraphRecallSnapshot()` and `explainLastGraphRecall()` for stable snapshot parsing and operator-friendly explain output.
  - Updated retrieval dispute helper hints to include graph-recall explainability guidance.
  - Added tests for snapshot read + explain formatting behavior.

### Docs
- Updated v8.2 and v8.3 implementation plans to split large releases into smaller PR slices (A-D) for safer review and rollout.
- Documented v8.3 lifecycle retrieval integration and staged rollout guidance in `docs/architecture/memory-lifecycle.md`, `docs/config-reference.md`, and `docs/setup-config-tuning.md`.

## [8.2.0-pr18] — v8.2 PR 18: Multi-Graph Memory

### Added
- Multi-graph memory (MAGMA/SYNAPSE-inspired, behind `multiGraphMemoryEnabled`, default off):
  - New `src/graph.ts`: maintains three typed edge graphs — entity co-reference (`entity.jsonl`), temporal sequence (`time.jsonl`), and causal inference (`causal.jsonl`) — stored under `memory/state/graphs/`.
  - **Entity graph**: edges written during `persistExtraction` when a new memory shares an `entityRef` with existing memories (capped at `maxEntityGraphEdgesPerMemory`, default 10).
  - **Time graph**: edges written between consecutive memories within the same conversation thread.
  - **Causal graph**: edges written when new memory content contains causal signal phrases (`because`, `therefore`, `led to`, `as a result`, `caused`, `because of`).
  - **Spreading activation** (`GraphIndex.spreadingActivation`): SYNAPSE-inspired BFS traversal from seed nodes across all enabled graph types with configurable per-hop decay. Ready for use by PR 19 (graph recall mode).
  - All graph writes are fail-open: any error is caught and logged; memory writes succeed regardless.
  - New config: `multiGraphMemoryEnabled`, `entityGraphEnabled`, `timeGraphEnabled`, `causalGraphEnabled`, `maxGraphTraversalSteps` (default 3), `graphActivationDecay` (default 0.7), `maxEntityGraphEdgesPerMemory` (default 10).

## [8.2.0-pr17] — v8.2 PR 17: Temporal Memory Tree

### Added
- Temporal Memory Tree (TiMem-inspired, behind `temporalMemoryTreeEnabled`, default off):
  - New `src/tmt.ts`: builds a hierarchy of summarised memory nodes — hour → day → week → persona — stored under `memory/tmt/` as markdown files with YAML frontmatter.
  - **Hour nodes** (`tmt/YYYY-MM-DD/hour-HH.md`): consolidated when `>= tmtHourlyMinMemories` new memories exist for that hour.
  - **Day nodes** (`tmt/YYYY-MM-DD/day.md`): built/updated from hour nodes during daily consolidation.
  - **Week nodes** (`tmt/week-YYYY-WW.md`): rolled up from day nodes when the ISO week turns.
  - **Persona node** (`tmt/persona.md`): synthesised from the 4 most recent week-node summaries.
  - **Recall injection**: the most temporally relevant TMT node is injected between Memory Boxes and QMD results when `temporalMemoryTreeEnabled=true`. Injection is skipped on `no_recall`/`minimal` planner modes.
  - Uses existing `LocalLlmClient` for summarisation via a callback — no additional API cost by default.
  - All node writes are fail-open: errors are caught and logged; consolidation and recall continue regardless.
  - New config: `temporalMemoryTreeEnabled` (default `false`), `tmtHourlyMinMemories` (default `3`), `tmtSummaryMaxTokens` (default `300`).

## [8.1.1-ai-readiness] — AI Readiness Improvements (PR #19)

### Added
- `.env.example` with documented environment variable placeholders
- `.editorconfig` for consistent cross-editor formatting
- `.nvmrc` and `.node-version` pinning Node to 22
- `biome.json` for lint/format tooling integration
- `eslint.config.js` for editor ESLint integration (ignores `dist/`, primary gate remains `tsc --noEmit`)
- `Makefile` with `make test`, `make build`, `make check` targets
- `.cursorignore` to exclude generated/build artifacts from Cursor indexing
- `llms.txt` — machine-readable project summary for AI assistants
- `src/AGENTS.md` — source-level guide for AI agents working on the codebase
- `.agents/` directory with per-agent context and reusable skills (`run-tests`, `add-config-property`)
- `prompts/extraction.prompt.md` and `prompts/consolidation.prompt.md` — documented LLM prompt templates
- `docs/ARCHITECTURE.md`, `docs/tech-stack.md`, `docs/CONVENTIONS.md`, `docs/api.md`, `docs/requirements/README.md`
- `tests/fixtures/` directory with synthetic test fixtures

## [8.1.0] - 2026-02-22

> Plan codename: **v8.1 — Intent + Temporal Indexing** (PR #15)

### Added
- Query-aware indexing (SwiftMem-inspired, behind `queryAwareIndexingEnabled`, default off):
  - New `src/temporal-index.ts`: maintains `state/index_time.json` (date buckets → memory paths) and `state/index_tags.json` (frontmatter tags → memory paths) after each extraction.
  - Adaptive retrieval prefilter: temporal queries receive a +0.08 score boost; `#tag` tokens in the prompt receive a +0.06 score boost. Additive and fail-open — index absence never breaks recall.
  - Batch indexing runs fire-and-forget after extraction to avoid blocking the write path.
  - New config: `queryAwareIndexingEnabled`, `queryAwareIndexingMaxCandidates`.

## [8.0.3] - 2026-02-22

> Plan codename: **v8.0 Phase 2C — Docs IA Overhaul** (PR #14)

### Added
- Docs IA overhaul foundation:
  - Rewrote `README.md` to be short (value prop, quick install, 5-minute setup, docs table).
  - New `docs/getting-started.md` — install, QMD setup, 5-minute config, verification.
  - New `docs/operations.md` — backup/export, CLI, hourly summaries, file hygiene, logs.
  - New `docs/config-reference.md` — single source of truth for all config flags and defaults.
  - New `docs/architecture/overview.md` — system design, components, storage layout, frontmatter schema.
  - New `docs/architecture/retrieval-pipeline.md` — full retrieval pipeline diagram and stage descriptions.
  - New `docs/architecture/memory-lifecycle.md` — write path, consolidation, expiry, dedup, box lifecycle, HiMem.
  - Updated `docs/README.md` to reflect the new IA with links to all new docs.

## [8.0.2] - 2026-02-22

> Plan codename: **v8.0 Phase 2B — Episode/Note Dual Store (HiMem)** (PR #13)

### Added
- Experimental Episode/Note dual store (HiMem, all behind config flags, default off):
  - **Episode/Note classification** (`episodeNoteModeEnabled`): each extracted memory is tagged with `memoryKind: episode` (time-specific event) or `memoryKind: note` (stable belief, preference, decision, constraint). Uses heuristic signals (temporal language, stable-belief keywords, tags, category).
  - New config: `episodeNoteModeEnabled`.

## [8.0.1] - 2026-02-22

> Plan codename: **v8.0 Phase 2A — Memory Boxes + Trace Weaving** (PR #12)

### Added
- Experimental Memory Boxes + Trace Weaving (all behind config flags, default off):
  - **Memory Boxes** (`memoryBoxesEnabled`): groups extracted memories into topic-bounded windows stored in `memory/boxes/YYYY-MM-DD/box-<id>.md`. Boxes seal on topic shift, time gap, or max-memory count.
  - **Trace Weaving** (`traceWeaverEnabled`): assigns a shared `traceId` to boxes that repeatedly revisit the same topic cluster, enabling cross-session topic continuity.
  - Recall injection: recent topic windows appear as `## Recent Topic Windows` section after verbatim artifacts when `memoryBoxesEnabled=true`.
  - New config: `boxTopicShiftThreshold`, `boxTimeGapMs`, `boxMaxMemories`, `traceWeaverLookbackDays`, `traceWeaverOverlapThreshold`, `boxRecallDays`.

## [8.0.0] - 2026-02-22

> Plan codename: **v8.0 Phase 1 — Memory OS Core** (PR #11)

### Added
- Experimental memory-os capabilities (all behind config flags, default off):
  - Recall planner (`recallPlannerEnabled`) to choose `no_recall` / `minimal` / `full` / `graph_mode`.
  - Intent-grounded memory routing metadata (`intentGoal`, `intentActionType`, `intentEntityTypes`) with configurable ranking boost.
  - Verbatim artifact persistence + recall injection (`memoryDir/artifacts/**`) for quote-first anchors.
  - New docs entrypoint: `docs/README.md` for the docs reorganization rollout.
- npm-first distribution + release automation:
  - New `Release and Publish` workflow (`.github/workflows/release-and-publish.yml`) that runs on `main` merges, verifies quality gates, bumps version, tags, creates GitHub release, and publishes to npm.
  - Package publish metadata in `package.json`: `engines.node`, `prepack`, and `publishConfig` (`access: public`, `provenance: true`).
  - npm package name scoped to `@joshuaswarren/openclaw-engram`.
- Contributor onboarding and contribution governance docs:
  - New `CONTRIBUTING.md` with standards for issues/PRs, testing, changelog policy, and AI-assisted contributions.
  - New `CONTRIBUTORS.md` with contributor recognition.
  - New GitHub issue templates for bug reports and feature requests.
  - New pull request template with validation and risk checklist.
- Changelog/release process automation:
  - `Changelog Guard` workflow requiring `CHANGELOG.md` updates for source/config/plugin changes (with `skip-changelog` maintainer bypass label).
  - `Release Drafter` workflow + config for automated draft release notes from merged PRs.
  - `Review Thread Guard` workflow that fails PR checks when active review threads are unresolved.
  - Release Drafter autolabeling adjusted so `src/**` changes no longer auto-label as `feature` (avoids accidental minor version bumps for fixes/refactors).
- GitHub Actions quality and security checks for pull requests:
  - `CI` (typecheck, tests, build on Node 22/24)
  - `Dependency Review` (blocks high+ severity dependency risks)
  - `Secret Scan` (Gitleaks on PRs and main pushes)
  - `CodeQL` analysis (PR + weekly schedule)
- `AI Review Gate` workflow requiring review activity from KiloConnect, Codex, and Cursor Bugbot bot groups before merge.

### Changed
- Extraction persistence now infers and stores intent metadata per memory/chunk, enabling intent-compatible recall boosts when enabled.
- Recall assembly now supports optional artifact section injection and planner-driven QMD result caps in minimal mode.
- `no_recall` now short-circuits before preamble fetches (shared context/profile/knowledge index), avoiding unnecessary reads and injection on acknowledgement turns.
- Artifact recall now honors minimal planner caps via `computeArtifactRecallLimit(...)`.
- Intent planner/inference now safely handle non-string/nullish runtime inputs without throwing.
- Embedding fallback recall paths now apply the same `boostSearchResults` ranking stage as primary QMD recall.
- `no_recall` planner mode now hard-sets `recallResultLimit=0` for stronger path-safety invariants.
- Release automation hardening:
  - Protected-branch-safe flow: sync + validate latest `origin/main`, compute next version from tags, create a local release commit (not pushed to `main`), tag that commit, push only the release tag, then create GitHub release and publish to npm.
  - Release tags are annotated tags; annotated tags include `source-main-sha` metadata for idempotency.
  - npm publish uses npm trusted publishing (OIDC via GitHub Actions) instead of `NPM_TOKEN` secrets.
  - Next-version tag discovery ignores non-`vX.Y.Z` tags to avoid malformed version parsing.
- Node version alignment with OpenClaw: `engines.node` is now `>=22.12.0`.
- Installation docs now lead with `openclaw plugins install @joshuaswarren/openclaw-engram --pin`.
- `agent_end` ingestion now ignores non-`user`/`assistant` message roles.
- Recall keeps fail-open headroom: hard recall guard reduced to 75s to stay above QMD worst cases.

### Fixed
- Runtime hardening for missing QMD collections: disables retrieval features when collections are confirmed absent, treats transient failures as `unknown`.
- Recall timeout/failure logs throttled to reduce warning spam.
- Conversation-index paths now use their own availability flag independent of primary `qmdEnabled`.

## [7.2.4] - 2026-02-21

### Fixed
- Fail-open recall improvements + missing QMD collection guards.

## [7.2.3] - 2026-02-20

### Added
- npm package scoped to `@joshuaswarren/openclaw-engram`; trusted OIDC publishing configured.

## [7.2.2] - 2026-02-20

### Fixed
- Release pipeline workflow parser failure; version split uses shell parameter expansion.

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

## [2.3.0] - 2026-02-13

### Added
- Optional file hygiene (off by default):
  - Lint selected workspace markdown files (e.g. `IDENTITY.md`, `MEMORY.md`) and warn before truncation risk.
  - Rotate oversized markdown files into `archiveDir`, replacing the original with a lean index plus a small tail excerpt.
  - Config: `fileHygiene.*`

## [2.2.5] - 2026-02-13

### Fixed
- Reduced background extraction crashes by defensively skipping malformed entity payloads.
- Improved structured JSON extraction from LLM outputs when responses contain multiple JSON blocks.
- Reduced QMD update/embed flakiness by serializing QMD CLI calls within the process and retrying on transient SQLite lock errors.

## [2.2.4] - 2026-02-11

### Fixed
- Prevented background extraction crashes when local LLM entity output omits or malforms `entities[].facts`.

### Changed
- Hourly summary cron auto-registration now targets `sessionTarget: "isolated"` with `payload.kind: "agentTurn"`.

## [2.2.3] - 2026-02-10

### Added
- Disagreement heuristic (suggestion-only): when the user pushes back, Engram injects a short helper section encouraging use of `memory_last_recall` and (optionally) `memory_feedback_last_recall`. Never records negative examples automatically.

## [2.2.2] - 2026-02-10

### Added
- Negative examples (retrieved-but-not-useful) feedback loop (opt-in):
  - Config: `negativeExamplesEnabled`, `negativeExamplesPenaltyPerHit`, `negativeExamplesPenaltyCap`
  - Storage: `memoryDir/state/negative_examples.json`
- Last recall snapshot + impression log for debugging/feedback workflows:
  - Storage: `memoryDir/state/last_recall.json`, `memoryDir/state/recall_impressions.jsonl`
  - Tools: `memory_last_recall`, `memory_feedback_last_recall`

### Changed
- Signal scan now treats phrases like "that's not right" / "why did you say that" as high-signal.

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
- Configurable local LLM hard timeout (`localLlmTimeoutMs`, default 180000ms).
- Optional slow query logging (`slowLogEnabled`, `slowLogThresholdMs`) for local LLM + QMD operations.

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
- CLI: `engram access`, `engram flush-access`, `engram importance`
- **Automatic Chunking (Phase 2A)**: Sentence-boundary chunking for long memories
  - New frontmatter fields: `parentId`, `chunkIndex`, `chunkTotal`
  - Configurable target tokens (default 200) and overlap (default 2 sentences)
  - Disabled by default, enable with `chunkingEnabled: true`
- CLI: `engram chunks`
- **Contradiction Detection (Phase 2B)**: LLM-verified contradiction resolution
  - Auto-resolve when confidence > 0.9 (configurable)
  - Full audit trail via `status: superseded` and correction entries
  - Disabled by default, enable with `contradictionDetectionEnabled: true`
- **Memory Linking (Phase 3A)**: Build knowledge graph between memories
  - Link types: follows, references, contradicts, supports, related
  - Disabled by default, enable with `memoryLinkingEnabled: true`
- **Conversation Threading (Phase 3B)**: Group memories into threads
  - Auto-detect thread boundaries (session change or 30min gap)
  - Threads stored in `threads/` directory
  - Disabled by default, enable with `threadingEnabled: true`
- CLI: `engram threads`
- **Memory Summarization (Phase 4A)**: Compress old memories into summaries
  - Triggered when memory count exceeds threshold (default 1000)
  - Archives source memories (`status: archived`)
  - Summaries stored in `summaries/` directory
  - Disabled by default, enable with `summarizationEnabled: true`
- **Topic Extraction (Phase 4B)**: TF-IDF topic analysis
  - Topics stored in `state/topics.json`
  - Enabled by default
- CLI: `engram topics`, `engram summaries`

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
