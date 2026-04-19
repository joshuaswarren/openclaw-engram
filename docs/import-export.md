# Import / Export / Backup (v2.3)

Engram stores memory as plain files. v2.3 adds portable export/import and safe backups via the `openclaw engram` CLI.

## Export

```bash
openclaw engram export --format json --out /tmp/engram-export
openclaw engram export --format md --out /tmp/engram-md
openclaw engram export --format sqlite --out /tmp/engram.sqlite
```

Options:
- `--include-transcripts` includes `memoryDir/transcripts` in the bundle (default: off).
- `--namespace <ns>` exports a namespace root when namespaces are enabled (v3.0+).

Formats:
- `json`: directory bundle with `manifest.json` and record files.
- `md`: directory copy of the memory directory (plus `manifest.json`).
- `sqlite`: single file export for analysis/import.

## Import

```bash
openclaw engram import --from /tmp/engram-export --format auto
openclaw engram import --from /tmp/engram.sqlite --format sqlite
openclaw engram import --from /tmp/engram-md --format md
```

Options:
- `--conflict skip|overwrite|dedupe` (default: `skip`)
- `--dry-run` validates without writing
- `--namespace <ns>` imports into a namespace root when namespaces are enabled (v3.0+)

## Backup

Backups are timestamped directory copies of the memory store:

```bash
openclaw engram backup --out-dir /tmp/engram-backups --retention-days 14
```

Notes:
- Backups are intended to be driven by your scheduler (OpenClaw cron, launchd, systemd, etc.).
- Use `--include-transcripts` only if you are comfortable backing up full transcripts.

## Training-data Export (issue #459)

Remnic can emit its structured memories as a fine-tuning dataset, skipping
the noisy raw-chat-log step that format-specific trainers normally need.

The pipeline lives in `@remnic/core` (generic) with format-specific
adapters in separate packages. Today the WeClone adapter
(`@remnic/export-weclone`) is shipped; additional adapters (Axolotl, MLX,
etc.) can implement the same `TrainingExportAdapter` interface.

```bash
# Export all memories as a WeClone-compatible Alpaca JSON dataset
remnic training:export --format weclone --output ./weclone-dataset.json

# Restrict to high-confidence memories in a date window
remnic training:export \
  --format weclone \
  --output ./weclone-dataset.json \
  --since 2026-01-01 --until 2027-01-01 \
  --min-confidence 0.7

# Only a few categories
remnic training:export \
  --format weclone \
  --output ./weclone-dataset.json \
  --categories preference,fact,skill

# Generate conversational Q/A pairs instead of raw fact records
remnic training:export \
  --format weclone \
  --output ./weclone-dataset.json \
  --synthesize

# Preview only (no file written) — useful for CI
remnic training:export \
  --format weclone \
  --output /tmp/preview.json \
  --dry-run
```

Key flags:
- `--format <name>` — required; must name a registered adapter. `weclone`
  is registered as a side-effect of loading `@remnic/export-weclone`.
- `--output <path>` / `--out <path>` — required (unless `--dry-run`).
- `--memory-dir <path>` — override the resolved memoryDir.
- `--since` / `--until` — strict ISO 8601 filters on `created`; half-open
  `[since, until)` semantics (CLAUDE.md #35).
- `--min-confidence <0..1>` — inclusive lower bound on memory confidence.
- `--categories <csv>` — only export matching categories.
- `--include-entities` — also read from `entities/` (off by default).
- `--synthesize` — emit conversational Q/A pairs via the adapter's
  synthesizer (WeClone-optimised question templates, category-driven).
- `--max-pairs-per-record <n>` — when `--synthesize` is on, cap the
  number of pairs generated per memory.
- `--no-privacy-sweep` — disable the final PII redaction pass (default:
  on). Only use when you have a compensating control.
- `--dry-run` — print statistics (record count, per-category breakdown,
  redaction count) without writing the output file.

Privacy posture:
- The output file contains only the Alpaca fields (`instruction`,
  `input`, `output`). Memory IDs, confidences, and source ranges stay in
  the memory store.
- The core converter refuses to follow `.md` symlinks or hard-linked
  files under `memoryDir`, blocking exfiltration vectors.
- Date and confidence filters run before any record is materialised in
  memory.

See
[`packages/export-weclone/README.md`](../packages/export-weclone/README.md)
for the adapter-specific docs and programmatic API.

## Migration Helpers (v8.16 Task 1)

Engram includes bounded migration helpers under `openclaw engram migrate`:

```bash
openclaw engram migrate normalize-frontmatter
openclaw engram migrate rescore-importance
openclaw engram migrate rechunk
openclaw engram migrate reextract --model gpt-5-mini
```

All migration helpers default to dry-run. Add `--write` to apply changes and `--limit <n>` to cap scanned items.

`reextract` behavior:
- Requires explicit `--model`.
- Queues requests into `state/reextract-jobs.jsonl`.
- Applies a hard queue cap for safety; it does not directly run extraction in the CLI process.
