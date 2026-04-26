# Live Connectors

Live connectors are the **continuous** ingest path: they run on a schedule,
remember where they left off, and pull *new* documents from external services
(Google Drive, Notion, Gmail, GitHub, …) into the user's memory directory.

This page documents the framework contract that landed in issue #683 PR 1/N.
Concrete connector implementations ship in PRs 2–5. The maintenance scheduler
hookup and the `remnic connector …` CLI surface land in later PRs.

## How live connectors differ from importers

Remnic already ships **importers** (`packages/remnic-core/src/importers/`) that
transform a one-shot export file (ChatGPT export, Claude export, mem0 dump)
into memories in a single pass. Importers are not stateful — once the file is
ingested, the importer's job is done.

Live connectors are different in two ways:

1. **Continuous, not one-shot.** A live connector is invoked on a schedule by
   the maintenance loop. Every invocation is an *incremental* sync that picks
   up where the previous one stopped.
2. **Cursor-based.** Each connector persists an opaque cursor (`pageToken`,
   `historyId`, `since` timestamp, etc.) so the next pass only fetches
   documents the source considers new.

If you have a single export file in hand, write an **importer**. If you have a
service you want Remnic to keep watching, write a **live connector**.

## The contract

```ts
import type {
  LiveConnector,
  ConnectorConfig,
  ConnectorCursor,
  ConnectorDocument,
} from "@remnic/core";
```

Every connector implements:

```ts
interface LiveConnector {
  readonly id: string;          // /^[a-z0-9][a-z0-9-]{0,63}$/
  readonly displayName: string;
  readonly description?: string;

  validateConfig(raw: unknown): ConnectorConfig;
  syncIncremental(args: {
    cursor: ConnectorCursor | null;
    config: ConnectorConfig;
    abortSignal?: AbortSignal;
  }): Promise<{ newDocs: ConnectorDocument[]; nextCursor: ConnectorCursor }>;
}
```

Connectors **must** be:

- **Idempotent.** Re-running with the same cursor never duplicates documents.
  Documents carry `source.externalId` and (optionally) `source.externalRevision`
  so downstream dedup can de-duplicate by stable upstream identity.
- **Read-only on the source.** Live connectors never mutate the upstream
  service: no marking emails read, no editing pages, no archiving.
- **Cancellable.** Long-running syncs check `abortSignal.aborted` and bail
  cleanly when the scheduler cancels them.
- **Privacy-aware.** Connectors never log document content. Counts, ids, and
  timing are fine; bodies are not.

## Cursor + state persistence

Cursors and per-connector sync metadata live at:

```
<memoryDir>/state/connectors/<id>.json
```

Use the public helpers:

```ts
import {
  readConnectorState,
  writeConnectorState,
  listConnectorStates,
} from "@remnic/core";
```

Writes are atomic (temp file + rename) and never destroy the previous good
state on failure. Files that fail to parse are skipped by `listConnectorStates`
rather than failing the whole listing — operators inspecting the directory
can still see the corrupt file by hand.

The state record shape:

```ts
interface ConnectorState {
  id: string;
  cursor: ConnectorCursor | null;
  lastSyncAt: string | null;
  lastSyncStatus: "success" | "error" | "never";
  lastSyncError?: string;          // truncated to 1 KB
  totalDocsImported: number;
  updatedAt: string;
}
```

`"never"` is intentionally distinct from `"success"` so callers can detect
"registered but never run" without inspecting timestamps.

## Registry

```ts
import { LiveConnectorRegistry } from "@remnic/core";

const reg = new LiveConnectorRegistry();
reg.register(myConnector);
reg.list();         // sorted by id
reg.get("drive");
reg.unregister("drive");
```

The registry is pure in-memory and one-instance-per-orchestrator. Duplicate
ids are rejected (rather than silently overwritten) so plugin loading bugs
fail loudly and a malicious extension cannot shadow a built-in connector.

`unregister()` does **not** touch the on-disk state file. Fully decommission a
connector by also deleting `<memoryDir>/state/connectors/<id>.json`.

## Privacy posture

The framework is built around three rules:

1. **Read-only scopes.** Each concrete connector documents the minimum OAuth
   scope it requires. The framework itself never exposes write APIs to
   upstream services.
2. **Opt-in per connector.** Connectors are off until a user explicitly
   configures them. There is no "enable everything" switch.
3. **Local cursors.** Cursor state lives in the user's memory directory on
   disk. Nothing is uploaded to a Remnic-controlled service.

Credential storage (OAuth tokens, refresh tokens) is **not** part of this PR
— that's the design surface for PR 2. Connectors that need credentials will
read them from the OS keychain or a user-supplied secret store, never from
the connector state file.

## What's deferred

- **Concrete connectors** — Drive, Notion, Gmail, GitHub (PRs 2–5).
- **Maintenance scheduler integration** — wiring connectors into the periodic
  sync loop (separate PR).
- **CLI surface** — `remnic connector list/status/sync/disable` (PR 6).
- **OAuth helpers and credential storage** — PR 2 design.

## File map

```
packages/remnic-core/src/connectors/live/
├── framework.ts         # LiveConnector interface + ConnectorConfig/Cursor/Document
├── registry.ts          # LiveConnectorRegistry (pure, in-memory)
├── state-store.ts       # readConnectorState / writeConnectorState / listConnectorStates
├── index.ts             # Public barrel
└── live-connectors.test.ts
```

The new framework lives under `connectors/live/` because the parent
`connectors/` directory is already scoped to the existing Codex marketplace
integration (`codex-marketplace.ts`, `codex-materialize-runner.ts`,
`codex-materialize.ts`). Keep the namespaces distinct.
