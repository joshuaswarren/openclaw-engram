# PR Review Hardening Playbook

Use this for any PR that touches behavior, performance, safety, or compatibility.

Reference patterns:
`docs/ops/plugin-engineering-patterns.md`

## Why this exists

PR #11 showed a repeated pattern: fixing one review comment introduced or exposed adjacent regressions. This playbook defines a reusable pre-push gate so changes land cleanly with fewer follow-up commits.

## Higher-Level Principles (Generalizable)

These apply to any subsystem.

1. Invariants before implementation:
Write down behavioral invariants first (what must never break), then code to them.

2. System over patch:
When comments touch the same subsystem, redesign the subsystem path once instead of stacking local fixes.

3. Configuration is contract:
Flags and numeric limits are part of public API behavior. Treat their semantics (`enabled=false`, `0`) as compatibility guarantees.

4. Cohesion over drift:
Keep core decision logic in one place. Duplicate branches create divergence and recurring review churn.

5. Concurrency realism:
Any cache/state optimization must be designed assuming concurrent reads/writes and multiple instances.

6. Test the failure class, not only the instance:
For each bug, add tests that cover the category of failure so adjacent variants are caught automatically.

## Abstraction Layer: Change Classes

Every review item should be classified before coding:

1. Contract change:
Behavior exposed to users/config/integrations.

2. Control-flow change:
Planner/mode/routing logic that chooses paths.

3. Data lifecycle change:
Write/update/delete/cache/index/status behavior.

4. Operational change:
CI/release/versioning/automation or rollout logic.

5. Documentation change:
User expectations, migration notes, constraints.

For each class touched, require:
- explicit invariant list
- at least one test or verification artifact
- release/upgrade note if external behavior changes

## Abstraction Layer: Blast-Radius Sweep

Before pushing, run this sweep for each touched class:

1. Input edges:
Flags, default values, zero/empty values, disabled paths.

2. Internal edges:
Shared helpers, duplicated branches, cache/index dependencies.

3. Output edges:
User-visible behavior, logs, docs, telemetry, CI gates.

4. Time edges:
Concurrency, stale state, ordering, retries, eventual consistency.

## Mandatory Pre-Push Gate

Run this before every push:

1. `npm run check-types`
2. `npm test`
3. `npm run build`
4. Self-review staged diff for invariant classes below
5. Add/adjust tests for each new invariant touched

## Invariant Classes (must be checked)

1. Flag symmetry:
`enabled=false` must disable both write-time and read-time effects.

2. Zero semantics:
A configured `0` must remain `0` (never coerced to `1`).

3. Cap-after-filter:
Do not apply top-K before validity/status filtering when the filtered set is what users consume.

4. Cache coherence:
Cache invalidation must work:
- across instances
- across status transitions
- under concurrent writes/rebuilds

5. Single-path logic:
Avoid duplicated filtering logic branches that can drift.

6. Reachability:
Every documented mode/flag path must be reachable in runtime logic and covered by tests.

7. Fallback parity:
Primary and fallback retrieval paths must apply equivalent policy constraints.

8. Recall pipeline ordering:
Retrieve headroom -> filter -> rerank/boost -> cap -> format.
Never apply final cap before policy/path/status filtering.

9. Heuristic robustness:
Regex/heuristic classifiers must support common language variants and avoid malformed stems.

10. TTL correctness:
Cache `loadedAt` timestamps must represent completion time of cache rebuild, not start time.

## Required Tests for These Changes

When relevant, add tests for:

- planner mode reachability (`no_recall`, `minimal`, `full`, `graph_mode`)
- zero-limit behavior (`qmdMaxResults=0`, `verbatimArtifactsMaxRecall=0`)
- cache invalidation across instances
- concurrent write during cache rebuild
- post-filter cap fill behavior
- fallback path policy parity
- artifact path isolation from generic memory recall
- intent variant coverage (`decision`, `decided`, `chose`, `chosen`, etc.)

## PR Batch Strategy

If multiple comments touch the same subsystem:

1. Fix all related issues in one cohesive patch set.
2. Re-run full verification once.
3. Push once.

Avoid serial micro-fixes unless comments are independent.

## Review Loop Discipline

Before every push in an active review loop:

1. Re-scan all unresolved comments and group by subsystem.
2. Apply one coherent patch per subsystem group.
3. Run full verification.
4. Run one manual “second-order regression” pass over touched paths.
5. Push once and re-check.
