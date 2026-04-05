# Release Process

## Versioning Strategy

Each package is versioned independently using [Changesets](https://github.com/changesets/changesets).

### Adding a Changeset

When your PR changes a package's public API or behavior:

```bash
pnpm changeset
```

This prompts you to select which packages changed and whether the change is a patch, minor, or major bump. It creates a markdown file in `.changeset/` describing the change.

### Version Bumping

On merge to `main`, the release workflow:

1. Collects all changesets since last release
2. Bumps versions in each affected `package.json`
3. Updates `CHANGELOG.md` per package
4. Creates a "Version Packages" PR
5. Merging that PR triggers publishing

## Publishing

### npm Packages

Published automatically by `.github/workflows/release-and-publish.yml`:

| Package | npm Name | Registry |
|---------|----------|----------|
| `packages/engram-core` | `@engram/core` | npm |
| `packages/engram-server` | `@engram/server` | npm |
| `packages/engram-cli` | `engram` | npm |
| `packages/plugin-openclaw` | `openclaw-engram` | npm |
| `packages/plugin-claude-code` | `@engram/plugin-claude-code` | npm |
| `packages/plugin-codex` | `@engram/plugin-codex` | npm |
| `packages/connector-replit` | `@engram/replit` | npm |
| `packages/bench` | `@engram/bench` | npm |
| `packages/hermes-provider` | `@engram/hermes-provider` | npm |

All npm publishes include provenance attestations.

### PyPI Package

`packages/plugin-hermes` is published separately by `.github/workflows/hermes-python.yml`:

```bash
# Manual publish (maintainers only)
cd packages/plugin-hermes
python -m build
twine upload dist/*
```

### Marketplace Publishing

- **Claude Code plugin** → Anthropic marketplace (manual submission)
- **Codex plugin** → OpenAI Codex marketplace (manual submission)

## Backward Compatibility

### The `openclaw-engram` Package

The `packages/plugin-openclaw/` directory publishes as `openclaw-engram` on npm. This is critical — OpenClaw's plugin loader resolves this name. Renaming it would break all existing installations.

### The Root Package

The root `package.json` is a workspace root and is NOT published. It exists only for workspace management.

### Deprecation Notice

The old `@joshuaswarren/openclaw-engram` scope package has a deprecation notice pointing users to the new `@engram/*` packages.

## Emergency Hotfix

For critical fixes that can't wait for the normal changeset flow:

```bash
git checkout -b hotfix/critical-fix main
# make fix
pnpm changeset   # create changeset with patch bump
git push
# merge PR → auto-publishes
```
