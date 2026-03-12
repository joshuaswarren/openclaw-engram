# Namespaces (v3.0)

Namespaces allow multiple agents to share one Engram installation while keeping most memories isolated per agent, with a curated shared namespace.

## Key Config

- `namespacesEnabled` (default: false)
- `defaultNamespace` (default: `default`)
- `sharedNamespace` (default: `shared`)
- `namespacePolicies`: list of namespaces and read/write principals
- `principalFromSessionKeyMode` + `principalFromSessionKeyRules`: derive a principal from `sessionKey`
- `defaultRecallNamespaces`: typically `["self", "shared"]`

## Cross-Agent Memory Access

Non-generalist agents (any agent besides the one matching the `defaultNamespace`) recall from both their own **self namespace** and the **shared namespace** (as configured via `defaultRecallNamespaces`). Each agent's extracted memories are stored in its `self` namespace, so agents always have access to their own memories. The shared namespace provides cross-agent context — if it is empty, these agents still receive their own memories but miss context extracted by other agents.

**Shared namespace promotion (v9.0.66+):** When `autoPromoteToSharedEnabled: true`, extracted memories are automatically promoted to the shared namespace. This is the primary mechanism for cross-agent memory sharing. Verify promotion is working:

```bash
ls ~/.openclaw/workspace/memory/local/namespaces/shared/facts/
```

If this directory is empty or missing, non-generalist agents will have no cross-agent memory context (they still have their own `self` namespace memories). Check that `autoPromoteToSharedEnabled` is `true` and that `autoPromoteMinConfidenceTier` is set to `"implied"` (recommended) to ensure most extracted memories get promoted. The `"explicit"` tier is more conservative and may miss memories that lack strong confidence signals.

**Categories eligible for promotion:** The `autoPromoteToSharedCategories` setting controls which memory categories are promoted. The default is `["fact", "correction", "decision", "preference"]`. The `"fact"` category was added in v9.0.67 — prior versions defaulted to `["correction", "decision", "preference"]` only.

**Cross-agent recall:** The primary mechanism for cross-agent memory sharing is shared namespace promotion. When promotion is configured, memories extracted by any agent are copied to the shared namespace and become available to all agents during recall.

## QMD Collections for Namespaces

When namespaces are enabled, QMD needs entries for namespace-specific collections in `~/.config/qmd/index.yml`. The collection names follow the pattern `<base-collection>--ns--<namespace>`:

```yaml
# Base collection (legacy / default namespace root)
openclaw-engram:
  path: ~/.openclaw/workspace/memory/local
  extensions: [.md]

# Shared namespace
openclaw-engram-hot-facts--ns--shared:
  path: ~/.openclaw/workspace/memory/local/namespaces/shared
  extensions: [.md]

# Default namespace (if migrated to namespaces/ layout)
openclaw-engram-hot-facts--ns--main:
  path: ~/.openclaw/workspace/memory/local/namespaces/main
  extensions: [.md]
```

After adding entries, rebuild the indexes:

```bash
qmd update && qmd embed
```

## Storage Layout

Compatibility behavior:
- The default namespace continues to use the legacy `memoryDir` root unless `memoryDir/namespaces/<defaultNamespace>` exists.
- Non-default namespaces use `memoryDir/namespaces/<namespace>/`.

This prevents "lost memories" when an install enables namespaces before migrating existing data.

## Tooling

- `memory_store` accepts optional `namespace`.
- `memory_promote` copies a memory into the shared namespace (curated).
- Identity continuity tools accept optional `namespace` to target a specific namespace root.
- Extracted identity reflections are stored per namespace under each namespace root:
  - default namespace: `memoryDir/identity/reflections.md` (or the migrated default namespace root)
  - non-default namespaces: `memoryDir/namespaces/<namespace>/identity/reflections.md`
- Workspace identity synthesis remains namespace-scoped too:
  - default namespace: `workspace/IDENTITY.md`
  - non-default namespaces: `workspace/IDENTITY.<namespace>.md`

## CLI

First-class namespace commands:

```bash
openclaw engram namespaces ls
openclaw engram namespaces verify
openclaw engram namespaces migrate --to default --dry-run
```

When namespaces are enabled, these commands also accept `--namespace <ns>`:

```bash
openclaw engram export --format json --out /tmp/engram-export --namespace shared
openclaw engram import --from /tmp/engram-export --format auto --namespace default
openclaw engram backup --out-dir /tmp/backups --namespace shared
```
