# @remnic/import-weclone

Import [WeClone](https://github.com/xming521/weclone)-preprocessed chat exports
(Telegram, WhatsApp, Discord, Slack) into Remnic to bootstrap a memory store
instantly, rather than waiting for organic memory accumulation through daily AI
tool usage.

Part of [Remnic](https://github.com/joshuaswarren/remnic), the universal memory
layer for AI agents.

## Install

```bash
npm install @remnic/import-weclone
```

Importing this package registers the WeClone adapter with the core
bulk-import registry as a side effect, so `openclaw engram bulk-import
--source weclone ...` works without any explicit setup. Tests that call
`clearBulkImportSources()` can re-register via
`ensureWecloneImportAdapterRegistered()`.

## Why WeClone?

WeClone already handles the hard parts of chat ingestion:

- Platform-specific export parsing (Telegram JSON, WhatsApp, Discord, Slack)
- PII detection and redaction (Microsoft Presidio)
- Message deduplication and basic cleanup

Rather than duplicate that pipeline, this package consumes WeClone's
preprocessed JSON directly and maps it into the bulk-import contract defined by
`@remnic/core`.

## Pipeline

```
WeClone preprocessed JSON
         |
         v
+---------------------------------+
|  parseWeCloneExport             |  parser.ts
|  - platform resolution          |
|  - role inference (self/bot)    |
|  - schema validation            |
+---------------+-----------------+
                | BulkImportSource
                v
+---------------------------------+
|  groupIntoThreads               |  threader.ts
|  - sort by timestamp            |
|  - split on >30 min time gaps   |
|  - merge via reply chains       |
+---------------+-----------------+
                | ThreadGroup[]
                v
+---------------------------------+
|  mapParticipants                |  participant.ts
|  - count messages per sender    |
|  - classify self/frequent/      |
|    occasional                   |
+---------------+-----------------+
                | ParticipantEntity[]
                v
+---------------------------------+
|  chunkThreads                   |  chunker.ts
|  - split long threads with      |
|    overlap for context          |
+---------------+-----------------+
                | ImportTurn[][]
                v
+---------------------------------+
|  runBulkImportPipeline          |  @remnic/core
|  - batch extraction             |
|  - dedup against existing       |
|  - store with trustLevel=import |
+---------------------------------+
```

## CLI usage

The importer is exposed via the `engram bulk-import` subcommand in
`@remnic/core`:

```bash
# Dry-run: parse, validate, and report counts without persisting
openclaw engram bulk-import \
  --source weclone \
  --file ./preprocessed_telegram.json \
  --platform telegram \
  --dry-run

# Persist: run extraction over the export and write memories to disk
openclaw engram bulk-import \
  --source weclone \
  --file ./preprocessed_telegram.json \
  --platform telegram

# Strict mode: fail on any invalid message instead of skipping
openclaw engram bulk-import \
  --source weclone \
  --file ./preprocessed_telegram.json \
  --platform telegram \
  --strict
```

Persistence is wired through the Remnic orchestrator's extraction pipeline.
Each batch is buffered and extracted the same way an organic conversation
would be; memories land under the orchestrator's default-namespace root
(`memoryDir/facts/` by default). Use `--dry-run` to validate an export
before committing to the extraction cost. Per-invocation namespace
override for bulk-import writes is not yet wired — see the note in
[`docs/import-export.md`](../../docs/import-export.md).

## Programmatic usage

```ts
import { readFileSync } from "node:fs";
import {
  parseWeCloneExport,
  groupIntoThreads,
  mapParticipants,
  chunkThreads,
  // Side-effect import also registers the bulk-import adapter; see `index.ts`.
  wecloneImportAdapter,
} from "@remnic/import-weclone";
import {
  getBulkImportSource,
  runBulkImportPipeline,
} from "@remnic/core";

// The adapter is registered automatically on import. Look it up:
const adapter = getBulkImportSource("weclone");

// 1) Parse a WeClone-preprocessed export.
const raw = JSON.parse(readFileSync("./export.json", "utf8"));
const source = parseWeCloneExport(raw, { platform: "telegram" });

// 2) Pre-process into threads, participants, chunks.
const threads = groupIntoThreads(source.turns);
const participants = mapParticipants(source.turns);
const chunks = chunkThreads(threads, { maxTurnsPerChunk: 20 });

// 3) Run the bulk-import pipeline. In dryRun mode `processBatch` is never
//    called; for real persistence the host CLI supplies an `ingestBatch`
//    callback that wraps `orchestrator.ingestBulkImportBatch` (see
//    `openclaw engram bulk-import`).
const result = await runBulkImportPipeline(
  source,
  { batchSize: 20, dryRun: true, dedup: true, trustLevel: "import" },
  async () => ({ memoriesCreated: 0, duplicatesSkipped: 0 }),
);
```

## Supported platforms

| Platform  | `--platform` value |
|-----------|--------------------|
| Telegram  | `telegram`         |
| WhatsApp  | `whatsapp`         |
| Discord   | `discord`          |
| Slack     | `slack`            |

The parser defaults to `telegram` when neither `options.platform` nor an
export-level `platform` field is provided. Unknown platforms are rejected.

## Input schema

The parser accepts either:

1. A wrapper object:

   ```json
   {
     "platform": "telegram",
     "export_date": "2025-01-10T00:00:00.000Z",
     "messages": [
       {
         "sender": "Alice",
         "text": "hello",
         "timestamp": "2025-01-10T08:00:00.000Z",
         "message_id": "m-001",
         "reply_to_id": "m-000"
       }
     ]
   }
   ```

2. A raw array of messages (platform defaults to `telegram`).

Required per-message fields: `sender`, `text`, `timestamp` (ISO-8601). Optional:
`message_id`, `reply_to_id`.

## Role inference

Each `sender` is mapped to one of the `ImportTurn` roles:

- `user` - the "self" sender (first non-bot sender encountered, or override
  via `selfSender`).
- `assistant` - any sender matching a bot heuristic (`bot`, `assistant`, `ai`,
  `chatgpt`, `gpt`, `claude`, `copilot`, `llama`) or listed in
  `assistantSenders`.
- `other` - everyone else.

The heuristic uses word-boundary matching so human names that happen to contain
substrings like `ai` (e.g. `Aidan`, `Caitlin`) are not mis-classified.

## Design notes

- **Imported memories are tagged with `trustLevel: "import"`** in the
  pipeline options so downstream ranking/dedup can reason about their
  provenance. The confidence-weighted ranking discount described in the
  original issue is tracked as a follow-up — today the flag is plumbed but
  not consumed by the recall ranker.
- **Threads are conversation boundaries, not days.** The default 30-minute
  gap with reply-chain merging produces coherent extraction batches without
  relying on calendar boundaries.
- **Entity bootstrapping is best-effort.** `mapParticipants` emits
  lightweight `ParticipantEntity` records; the core entity graph is populated
  as the pipeline processes chunks.
- **Idempotent re-imports.** The pipeline's dedup pass (when wired)
  fingerprint-matches against existing memories, so re-running the importer
  after appending new messages is safe.

## License

MIT. See [LICENSE](https://github.com/joshuaswarren/remnic/blob/main/LICENSE).
