# Namespaces (v3.0)

Namespaces allow multiple agents to share one Engram installation while keeping most memories isolated per agent, with a curated shared namespace.

## Key Config

- `namespacesEnabled` (default: false)
- `defaultNamespace` (default: `default`)
- `sharedNamespace` (default: `shared`)
- `namespacePolicies`: list of namespaces and read/write principals
- `principalFromSessionKeyMode` + `principalFromSessionKeyRules`: derive a principal from `sessionKey`
- `defaultRecallNamespaces`: typically `["self", "shared"]`

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
