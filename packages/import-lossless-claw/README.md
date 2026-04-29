# @remnic/import-lossless-claw

Migrate a [lossless-claw](https://github.com/martian-engineering/lossless-claw)
LCM SQLite database into Remnic's LCM mode.

## Why this exists

Remnic ships its own *lossless context management* mode whose schema is
near-isomorphic to lossless-claw's. This package is a SQLite→SQLite
importer for users who want to switch from lossless-claw to Remnic without
losing session history.

For coexistence (running both side-by-side) and the full migration story,
see [`docs/lcm-to-remnic-migration.md`](../../docs/lcm-to-remnic-migration.md).

## Install

```bash
npm install -g @remnic/import-lossless-claw
# or
pnpm add @remnic/import-lossless-claw
```

The CLI command lives in `@remnic/cli`; this package is loaded lazily on
demand via the à-la-carte loader (CLAUDE.md gotcha #57).

## Usage

```bash
remnic import-lossless-claw --src ~/.openclaw/lcm.db
remnic import-lossless-claw --src ~/.openclaw/lcm.db --dry-run
remnic import-lossless-claw --src ~/.openclaw/lcm.db --session-filter sess-A
```

The destination is `<memoryDir>/state/lcm.sqlite`, which Remnic creates
automatically when `lcmEnabled: true` is set in plugin config.

## Programmatic API

```ts
import {
  importLosslessClaw,
  openSourceDatabase,
} from "@remnic/import-lossless-claw";
import { ensureLcmStateDir, openLcmDatabase } from "@remnic/core";

const sourceDb = openSourceDatabase("/path/to/lcm.db");
await ensureLcmStateDir("/path/to/memoryDir");
const destDb = openLcmDatabase("/path/to/memoryDir");

const result = importLosslessClaw({
  sourceDb,
  destDb,
  dryRun: false,
  sessionFilter: new Set(["sess-A"]),
  onLog: (line) => console.log(line),
});

sourceDb.close();
destDb.close();
```

## Idempotency

Re-running the importer inserts zero new rows. Messages dedupe on
`(session_id, turn_index)`; summary nodes dedupe on `id`.

## What's lossy

- Multi-parent summary DAG → single-parent (lowest `ordinal` wins,
  lexicographic tie-break). Count reported in result.
- `message_parts`, `large_files`, compaction telemetry — no Remnic LCM
  analog, skipped silently.

See the migration doc for the full mapping table.

## License

MIT
