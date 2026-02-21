# PR Review Hardening Playbook

Use this for any PR that touches retrieval, planner logic, caching, or config flags.

## Why this exists

PR #11 showed a repeated pattern: fixing one review comment introduced or exposed adjacent regressions. This playbook defines a pre-push gate so changes land cleanly with fewer follow-up commits.

## Mandatory Pre-Push Gate

Run this before every push for behavior/config/cache changes:

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

## Required Tests for These Changes

When relevant, add tests for:

- planner mode reachability (`no_recall`, `minimal`, `full`, `graph_mode`)
- zero-limit behavior (`qmdMaxResults=0`, `verbatimArtifactsMaxRecall=0`)
- cache invalidation across instances
- concurrent write during cache rebuild
- post-filter cap fill behavior

## PR Batch Strategy

If multiple comments touch the same subsystem:

1. Fix all related issues in one cohesive patch set.
2. Re-run full verification once.
3. Push once.

Avoid serial micro-fixes unless comments are independent.

