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

