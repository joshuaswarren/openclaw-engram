# Contributing to openclaw-engram

Thanks for contributing. We welcome both issues and pull requests from humans and AI-assisted contributors.

## Ways to contribute

- Report bugs via GitHub Issues
- Propose features via GitHub Issues
- Submit pull requests for fixes, docs, tests, and improvements
- Improve examples/docs to help adoption

## Before opening a PR

1. Search existing issues/PRs to avoid duplicates.
2. For non-trivial changes, open an issue first and propose approach/scope.
3. Keep changes focused and small when possible.

## Development setup

Requires Node.js `>=22.12.0` (aligned with OpenClaw engine support).

```bash
npm ci
npm run check-types
npm test
npm run build
```

## Install path for users

Use npm install via OpenClaw as the primary install path in docs:

```bash
openclaw plugins install openclaw-engram --pin
```

## PR quality bar

A good PR should:

- Include tests for behavior changes
- Keep backwards compatibility unless intentionally changed
- Avoid unrelated refactors in the same PR
- Update docs for user-facing/config changes
- Update `CHANGELOG.md` (see changelog policy below)

## Changelog policy

This repository uses `CHANGELOG.md` as the public source of release notes.

- Add a concise entry in `## [Unreleased]` for user-facing changes.
- Use one of the standard sections when possible: `Added`, `Changed`, `Fixed`, `Security`.
- Keep entries short and outcome-focused.

A CI check enforces changelog updates when source/config files change.
Maintainers can bypass for exceptional cases by applying label `skip-changelog`.

## AI-assisted contributions

AI-assisted and agent-assisted PRs are welcome.

Please ensure:

- A human reviews and stands behind the final PR
- Generated code is understood, minimal, and tested
- No secrets, tokens, or private data are introduced
- Tooling or automation changes include clear rationale

## Security

- Do not submit secrets in code, issues, or PRs.
- If you find a sensitive vulnerability, open a private security report where possible instead of posting exploit details publicly.

## Review and merge process

- Maintainers may request changes for scope, safety, tests, and documentation.
- PRs require passing checks and at least one maintainer approval.
- Significant changes may be merged in follow-up slices to reduce risk.

## Release process

- Merges to `main` trigger an automated release workflow.
- The workflow validates (`check-types`, `test`, `build`), bumps a patch version, tags `vX.Y.Z`, creates a GitHub release, and publishes to npm.
- Configure repository secret `NPM_TOKEN` (npm automation token) for publish.
- If `NPM_TOKEN` is missing, release creation still runs but npm publish is skipped.

## Good first contributions

Useful high-impact contributions include:

- Better error messages and docs
- Additional regression tests
- Example configs for common providers
- Performance/safety improvements with benchmarks/tests

Thanks again for improving openclaw-engram.
