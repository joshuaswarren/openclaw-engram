# At-Rest Encryption (Secure Store)

Issue #690 — AES-256-GCM transparent storage encryption.

## Threat Model

### What at-rest encryption protects against

- **Physical disk compromise** — if the device's storage is read by an attacker (stolen laptop, forensic image, decommissioned SSD) the memory files are unreadable without the passphrase.
- **Cloud backup exfiltration** — if memory files are included in a cloud backup and that backup is accessed by a third party, the ciphertext is opaque.
- **Accidental exposure** — a `cat` of a memory file or a leaked backup tarball reveals only ciphertext.

### What it does NOT protect against

- **A running, unlocked daemon** — once `remnic secure-store unlock` is called, the decryption key is held in memory. Any process that can communicate with the daemon (localhost MCP, HTTP, CLI) can retrieve plaintext memories.
- **Memory dumps** — the kernel or a privileged process can read the key from process memory. This is a fundamental limitation of software-only encryption.
- **Passphrase at rest** — the passphrase is never stored by Remnic, but if your passphrase manager is compromised, so is your memory store.
- **QMD search index** — the search backend indexes content in its own data store (BM25, vector embeddings). Index files are NOT currently encrypted by this module. Disable QMD or use `secureStoreEnabled: true` with awareness of this gap.

### Scope

Only memory files in `facts/`, `corrections/`, `procedures/`, `reasoning-traces/`, `artifacts/`, `archive/`, and `profile.md` are encrypted by this module. Entity files, state files, JSON indexes, and continuity records are not yet covered.

---

## Recovery

**Passphrase loss equals data loss.**

Remnic does not store your passphrase anywhere. There is no "forgot my passphrase" recovery path. If you lose your passphrase:

- Your encrypted memory files cannot be decrypted.
- The only recovery path is restoring a **non-encrypted backup** taken before `migrateMemoryDirToEncrypted` was run.

**Recommendation:** Before enabling encryption, take a full backup of your memory directory:

```bash
cp -r ~/.openclaw/memories ~/.openclaw/memories-backup-plaintext
```

Store the backup somewhere safe and non-encrypted (e.g. an encrypted external drive with a separately remembered passphrase).

---

## Naming Disambiguation

Remnic uses the term **"secure-store"** for its at-rest encryption module. This is intentional — it avoids collision with:

- **Obsidian Vault** — an Obsidian workspace directory (`vaultId`, `obsidianVaults` config)
- **Key Vault** (Azure/AWS/GCP) — cloud secret stores
- **macOS Keychain** — system credential storage

When reading docs or config, `secure-store` always means Remnic's at-rest encryption layer.

---

## CLI Reference

All `secure-store` commands take the `--memory-dir` flag (defaults to configured memory directory).

### Initialize

```bash
remnic secure-store init
```

Creates a `.secure-store/header.json` metadata file in your memory directory. You will be prompted for a passphrase (twice for confirmation).

**Minimum passphrase length:** 12 characters.

This command does NOT encrypt existing memory files. Run `remnic secure-store migrate` after init to encrypt existing files.

### Unlock

```bash
remnic secure-store unlock
```

Derives the AES-256 key from your passphrase and stores it in the in-memory keyring. The daemon can then read and write encrypted memory files.

**The key is never persisted to disk.** You must run `unlock` after every daemon restart.

### Lock

```bash
remnic secure-store lock
```

Zeros the in-memory key and removes it from the keyring. The daemon can no longer read or write encrypted files until `unlock` is run again.

### Status

```bash
remnic secure-store status
```

Shows whether the store is initialized, locked, or unlocked. Prints no secret material.

---

## Enabling Encryption in Config

Set these keys in your config (via `--config` or `openclaw.plugin.json`):

```json
{
  "secureStoreEnabled": true,
  "secureStoreEncryptOnWrite": true
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `secureStoreEnabled` | `false` | Enable the secure-fs layer for reads and writes. |
| `secureStoreEncryptOnWrite` | `true` | Encrypt new writes when `secureStoreEnabled` is true. Set to `false` to pause new encryptions while still decrypting existing files (useful during incremental migration). |

When `secureStoreEnabled` is `true` and the store is locked, `recall` returns a clear error message:

```
[secure-store locked] Memory store is encrypted and locked.
Run `remnic secure-store unlock` then restart the daemon to decrypt.
```

---

## Encryption Format

**Algorithm:** AES-256-GCM (NIST SP 800-38D).

**KDF:** scrypt with strong parameters:

| Parameter | Value | Notes |
|-----------|-------|-------|
| N | 2^17 = 131072 | CPU/memory cost |
| r | 8 | Block size |
| p | 1 | Parallelism |
| Memory | ~128 MiB | During key derivation |
| Output | 32 bytes | AES-256 key |

**On-disk format per file:**

```
[MAGIC:10][VER:1][FLAGS:1] — 12-byte file header
[CIPHER_VER:1][SALT:16][IV:12][AUTHTAG:16][CIPHERTEXT:...] — AES-GCM envelope
```

- `MAGIC` = ASCII `"REMNIC-ENC"` (10 bytes) — sniffable without decryption.
- `VER` = `0x01` — file format version.
- `FLAGS` = `0x00` — reserved.
- `SALT` — per-file KDF salt (matches the metadata salt in normal operation).
- `IV` — random 96-bit GCM nonce, unique per write.
- `AUTHTAG` — 128-bit GCM authentication tag.
- `CIPHERTEXT` — AES-CTR encrypted content.

**Path-bound AAD:** The file path relative to the memory root is bound as GCM associated authenticated data. Moving or renaming an encrypted file without re-encrypting it will cause an auth failure on next read.

---

## Performance

Key derivation (scrypt N=2^17) takes approximately 100–300 ms on modern laptop hardware. This cost is paid once per `unlock` call, not per file read.

Per-file encrypt/decrypt overhead is negligible (~microseconds) compared to disk I/O.

---

## Cross-Links

- [Capsule Export Encryption](capsules.md) — `remnic capsule export --encrypt` uses the same `seal()`/`open()` primitives from `secure-store/cipher.ts`.
- [Config Reference](config-reference.md) — `secureStoreEnabled`, `secureStoreEncryptOnWrite`.
- [Operations](operations.md) — backup recommendations when using encryption.
