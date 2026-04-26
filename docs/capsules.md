# Memory Capsules — CLI Reference (issue #676 PR 6/6 + issue #690 PR 4/4)

Capsules are portable, versioned archives of a Remnic memory directory. They
use the V2 bundle format (issue #676) which carries a `capsule` metadata block
alongside the memory records. Unlike the older `export` / `import` commands,
capsules are designed for:

- **Sharing** — a capsule can be imported on a different machine or namespace.
- **Reproducibility** — the capsule manifest records SHA-256 checksums for
  every file, so imports are tamper-evident.
- **Encryption** — with the `--encrypt` flag, the archive payload is sealed
  with AES-256-GCM using the secure-store master key (issue #690). Encrypted
  capsules can be transferred across machines as long as the same passphrase is
  available on the destination.

---

## Quick start

### 1. Initialize a secure store (once per memory directory)

```bash
remnic secure-store init
# Prompts for a passphrase; writes .secure-store/header.json
```

### 2. Unlock the store before any encrypt / decrypt operation

```bash
remnic secure-store unlock
# Prompts for the passphrase; registers the key in the daemon's keyring
```

### 3. Export an encrypted capsule

```bash
remnic capsule export \
  --name my-capsule \
  --encrypt
# Writes: <memoryDir>/.capsules/my-capsule.capsule.json.gz.enc
# Sidecar: <memoryDir>/.capsules/my-capsule.manifest.json
```

### 4. Import a capsule (auto-detects encryption)

```bash
remnic capsule import /path/to/my-capsule.capsule.json.gz.enc
```

The import command reads the REMNIC-ENC magic header and automatically
decrypts the archive before unpacking. The secure-store must be unlocked on
the destination machine.

---

## Commands

### `remnic capsule export`

```
remnic capsule export <name> [options]

Arguments:
  name                    Capsule id (alphanumeric + dashes, max 64 chars). Required.

Options:
  --out <dir>             Output directory. Default: <memoryDir>/.capsules
  --since <iso8601>       Only include files modified on or after this date.
                          Accepts YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ (explicit timezone required).
  --include-kinds <list>  Comma-separated top-level subdirectory allow-list
                          (e.g. facts,entities,corrections). When set, only files
                          whose first path segment is in the list are exported.
                          Pass "transcripts" here to include transcripts (excluded by default).
  --peers <list>          Comma-separated peer id allow-list for the peers/ subtree.
  --encrypt               Seal the archive with the secure-store master key.
                          The store must be unlocked before running this command.
```

**Output files:**

- `<name>.capsule.json.gz` — the archive (plaintext export, not encrypted)
- `<name>.capsule.json.gz.enc` — the encrypted archive (only when `--encrypt`)
- `<name>.manifest.json` — sidecar manifest for inspection without decompression

When `--encrypt` is used, the plaintext `.gz` is written first, then replaced
by the `.enc` file. A crash between the two steps leaves the plaintext `.gz`
on disk (recoverable). The `.manifest.json` sidecar is always plaintext for
cheap inspection.

### `remnic capsule import`

```
remnic capsule import <archive> [options]

Arguments:
  archive                 Path to a .capsule.json.gz or .capsule.json.gz.enc archive.

Options:
  --mode <mode>           Conflict resolution: skip (default), overwrite, fork.
  --namespace <ns>        Target namespace (v3.0+, default: config defaultNamespace).
```

**Conflict modes:**

| Mode | Behaviour |
|------|-----------|
| `skip` | Existing files are left untouched; the record is reported as skipped. |
| `overwrite` | Existing files are snapshotted via page-versioning, then overwritten. |
| `fork` | Records are rebased under `forks/<capsule-id>/` so the original tree is never modified. |

**Encryption auto-detection:**

The import command checks the first bytes of the archive file for the
`REMNIC-ENC` magic header. When found, it decrypts in-memory before unpacking.
The secure-store must be unlocked on the destination machine before importing.

### `remnic capsule merge`

Three-way merge a capsule archive into the current memory directory.

- Files that **exist only in the archive** are always written.
- Files that are **byte-identical** (same SHA-256) are skipped silently.
- Files that **differ** are conflicts, resolved by `--conflict-mode`.

```
remnic capsule merge <archive> [options]

Arguments:
  archive                   Path to a .capsule.json.gz (or .enc) archive.

Options:
  --conflict-mode <mode>    Conflict resolution: skip-conflicts (default), prefer-source, prefer-local.
```

**Conflict modes:**

| Mode | Behaviour |
|------|-----------|
| `skip-conflicts` | Keep local file; skip the archive entry; continue processing. |
| `prefer-source` | Snapshot the local file via page-versioning, then overwrite with the archive content. |
| `prefer-local` | Keep the local file; skip the archive entry (explicitly chosen, not just a fallback). |

**Example:**

```bash
# Merge a peer's capsule, keeping your local changes on conflict
remnic capsule merge shared.capsule.json.gz --conflict-mode prefer-local

# Merge and take the incoming version on conflict (with local snapshot)
remnic capsule merge update.capsule.json.gz --conflict-mode prefer-source
```

---

### `remnic capsule list`

List all capsule archives in the capsule store directory. Reads each sidecar `.manifest.json` for metadata — no decompression needed.

```
remnic capsule list [options]

Options:
  --dir <path>     Override the capsule store directory. Default: <memoryDir>/.capsules
  --format <fmt>   Output format: text (default), markdown, json.
```

**Example output (text):**

```
daily-backup  [2026-04-26] [47 files]  Daily backup capsule
weekly-facts  [2026-04-21] [12 files]  Facts only
shared-bundle [2026-04-15] [83 files]
```

**Example output (json):**

```json
{
  "capsules": [
    {
      "id": "daily-backup",
      "archivePath": "/path/to/.capsules/daily-backup.capsule.json.gz",
      "manifestPath": "/path/to/.capsules/daily-backup.manifest.json",
      "createdAt": "2026-04-26T00:00:00.000Z",
      "pluginVersion": "9.3.68",
      "fileCount": 47,
      "description": "Daily backup capsule"
    }
  ]
}
```

---

### `remnic capsule inspect`

Show a capsule manifest without extracting the archive. Reads the sidecar `.manifest.json` when present (cheap, no decompression); decompresses the archive only if the sidecar is absent.

The `<archive>` argument accepts:
- An absolute or relative file path to a `.capsule.json.gz` (or `.enc`) file.
- A capsule **id** — looked up as `<capsulesDir>/<id>.capsule.json.gz`.

```
remnic capsule inspect <archive> [options]

Arguments:
  archive         Path to a .capsule.json.gz archive, or a capsule id.

Options:
  --format <fmt>  Output format: text (default), markdown, json.
```

**Example:**

```bash
# By id (looks up <memoryDir>/.capsules/daily-backup.capsule.json.gz)
remnic capsule inspect daily-backup

# By path
remnic capsule inspect /path/to/daily-backup.capsule.json.gz --format json
```

---

### `remnic backup --encrypt`

```bash
remnic backup --out-dir /path/to/backups --encrypt
```

The `--encrypt` flag produces a single encrypted `.backup.json.gz.enc` file
instead of a plaintext timestamped directory. The secure-store must be
unlocked before running the backup.

---

## Encrypted archive format

Encrypted capsule and backup files use a simple binary format:

```
[MAGIC: 11 bytes]  "REMNIC-ENC\x00" — ASCII magic + NUL sentinel
[VERSION: 1 byte]  Format version (currently 1)
[ENVELOPE: rest]   AES-256-GCM sealed envelope (cipher.ts format):
                     [VERSION:1][SALT:16][IV:12][AUTHTAG:16][CIPHERTEXT:...]
                   The ciphertext is the original .gz payload.
```

The REMNIC-ENC magic is:

- ASCII-safe — no UTF-8 confusion.
- Obviously non-JSON — will not parse as `{...}`.
- Obviously non-gzip — gzip magic is `0x1f 0x8b`; `R` is `0x52`.

The KDF salt (16 bytes, scrypt) is embedded inside the AES-GCM envelope, so
the file is self-contained: any machine that knows the original passphrase can
re-derive the same key and decrypt without any external metadata.

The destination file's basename (without the `.enc` suffix) is bound into
the AES-GCM AAD. Renaming an encrypted archive triggers an authentication
failure on open.

---

## Cross-machine restore

To restore an encrypted capsule on a different machine:

1. Copy the `.enc` archive and (optionally) the `.manifest.json` sidecar to
   the destination.
2. Initialize the secure store on the destination with the **same passphrase**:
   ```bash
   remnic secure-store init
   ```
   Scrypt is deterministic: the same passphrase + the salt embedded in the
   envelope produces the same key, so you do not need to transfer any key
   material out-of-band.
3. Unlock the store:
   ```bash
   remnic secure-store unlock
   ```
4. Import the capsule:
   ```bash
   remnic capsule import /path/to/my-capsule.capsule.json.gz.enc
   ```

> **Important:** The passphrase must match. The key is derived from the
> passphrase using scrypt with the parameters and salt stored inside the
> encrypted envelope. A different passphrase produces a different key and
> decryption fails with an authentication error.

---

## Key requirements

- The secure-store must be **initialized** (`remnic secure-store init`) before
  any encrypt or decrypt operation.
- The secure-store must be **unlocked** (`remnic secure-store unlock`) in the
  currently running daemon before `capsule export --encrypt`, `capsule import`
  (on encrypted archives), or `backup --encrypt`.
- The daemon's in-memory key is **cleared on restart**. Re-run `unlock` after
  any daemon restart.
- If you lose the passphrase you cannot recover the encrypted archive. Store
  the passphrase in a password manager.

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Secure-store is locked or not initialized` | The daemon does not hold a key for this memory directory. | Run `remnic secure-store unlock` (or `init` if not yet set up). |
| `authentication failed — wrong passphrase, tampered archive` | Wrong passphrase on the destination, or the archive bytes were modified. | Verify the passphrase matches the one used during `init`. If the archive was transferred, check the hash. |
| `unsupported encrypted-capsule format version N` | The archive was produced by a newer version of Remnic. | Upgrade Remnic on the destination machine. |
| `'memoryDir' is required when 'encrypt' is true` | The export API was called programmatically without providing `memoryDir`. | Pass `memoryDir` to `exportCapsule()`. |
