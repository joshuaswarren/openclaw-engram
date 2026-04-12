## Summary

<!-- What changed and why? -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Refactor
- [ ] Security / hardening

## Validation

- [ ] `npm run check-types`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `bash scripts/check-review-patterns.sh`
- [ ] Added/updated tests for behavior changes
- [ ] For retrieval/planner/cache/config changes: ran `docs/ops/pr-review-hardening-playbook.md`

## Changelog

- [ ] Added/updated `CHANGELOG.md` under `## [Unreleased]`
- [ ] Not needed (explain why)

## Risk assessment

- [ ] No secrets/tokens added
- [ ] Backwards compatibility considered
- [ ] Migration/config impact documented (if applicable)
- [ ] Zero-value semantics validated (`0` limits stay disabled, never coerced)
- [ ] Flag symmetry validated (`enabled=false` disables both write and read-path effects)
- [ ] Cache invalidation/coherency reviewed (cross-instance + concurrent updates)
- [ ] Promise chain resilience verified (serialized `.then()` chains recover from rejection)
- [ ] Loop iterator matches needed data (`.entries()` if key is used, not `.values()`)
- [ ] Namespace consistency verified (read/write paths use same resolution layer)
- [ ] Direct-write paths trigger reindex (bypassing extraction pipeline must update search index)

## Notes for reviewers

<!-- Anything specific you want reviewed closely -->
