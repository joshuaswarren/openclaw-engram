/**
 * Transparent at-rest encryption for memory files (issue #690 PR 3/4).
 *
 * Layered on top of the PR 1/4 cipher primitives + PR 2/4 keyring, this
 * module provides drop-in replacements for `readFile`/`writeFile` that
 * emit and consume an "encrypted memory file" envelope on disk.
 *
 * On-disk shape
 * -------------
 *
 *   [MAGIC:8][VERSION:1][RESERVED:3][SEALED-ENVELOPE...]
 *
 *   - MAGIC (8 bytes): the ASCII bytes "RMSF\x00\x01\x00\x00". The
 *     leading "RMSF" stands for Remnic Memory Secure File. The four
 *     trailing bytes give us a nul terminator + a 16-bit minor format
 *     hint + a reserved byte for future stamping (e.g. wrap kind).
 *     Magic is at byte 0 so a sniff is `buf.subarray(0, 8) ===
 *     ENCRYPTED_FILE_MAGIC`.
 *   - VERSION (1 byte): wrap format version. Currently 1.
 *   - RESERVED (3 bytes): zero. Reserved for future per-file flags
 *     (compression kind, AAD profile, etc.).
 *   - SEALED-ENVELOPE: a `cipher.seal(...)` envelope (see `cipher.ts`).
 *     The seal embeds its own salt + IV + auth tag, so the only state
 *     this module owns is the magic + version bytes.
 *
 * The magic is intentionally distinct from the YAML-frontmatter
 * `---\n` prefix that plaintext memory files start with, which lets a
 * single read path detect the file's shape with one `subarray` compare
 * and decide whether to decrypt.
 *
 * Backward compatibility
 * ----------------------
 * `readMaybeEncryptedFile()` returns plaintext for any file that
 * doesn't start with the magic bytes — a freshly-installed daemon
 * with `secureStoreEnabled: false` keeps reading legacy markdown
 * files exactly as before. Only writes through `writeMaybeEncryptedFile`
 * with a key produce encrypted output.
 *
 * Migration
 * ---------
 * `migrateMemoryDirToEncrypted()` walks a memory directory, snapshots
 * each `.md` file via the page-versioning callback (CLAUDE.md gotcha
 * #54: snapshot before atomic re-write), then re-writes the file in
 * encrypted form. The walker is the canonical bulk-rotate entry point
 * for going from a plaintext store to an encrypted one.
 *
 * What this module does NOT do
 * ----------------------------
 * - It does not own a keyring. Callers pass in a `Buffer` master key
 *   (typically `keyring.getKey(secureStoreId)`).
 * - It does not own KDF state. `header.ts` is the system of record;
 *   the per-file salt embedded in each envelope is fresh from
 *   `cipher.seal()`'s random IV pathway.
 * - It does not enforce policy on which files to encrypt — callers
 *   decide based on the file's role (memory `.md` vs. ledger / index).
 */

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ENVELOPE_HEADER_SIZE as SEALED_ENVELOPE_HEADER_SIZE,
  generateSalt,
  open as openSealed,
  seal as sealEnvelope,
} from "./cipher.js";

/**
 * Magic bytes that prefix every encrypted memory file.
 *
 * The exact byte sequence is `R M S F \x00 \x01 \x00 \x00`. The
 * trailing nul is intentional: it terminates the printable prefix so
 * a casual `cat` of an encrypted file shows "RMSF" and then nothing
 * else legible.
 */
// Note: Object.freeze cannot be applied to Buffer (ArrayBufferView).
// We expose this as a plain const — callers MUST NOT mutate it.
export const ENCRYPTED_FILE_MAGIC: Buffer = Buffer.from([
  0x52, 0x4d, 0x53, 0x46, 0x00, 0x01, 0x00, 0x00,
]);

/** Length of the leading magic block in bytes. */
export const ENCRYPTED_FILE_MAGIC_LENGTH = ENCRYPTED_FILE_MAGIC.length;

/** Wrap format version. Bump on a breaking layout change. */
export const ENCRYPTED_FILE_VERSION = 1 as const;

/** Reserved bytes between the version byte and the sealed envelope. */
export const ENCRYPTED_FILE_RESERVED_LENGTH = 3;

/** Total wrap header size: magic + version + reserved. */
export const ENCRYPTED_FILE_HEADER_SIZE =
  ENCRYPTED_FILE_MAGIC_LENGTH + 1 + ENCRYPTED_FILE_RESERVED_LENGTH;

/** Byte offsets inside the wrap header. */
export const ENCRYPTED_FILE_LAYOUT = Object.freeze({
  magic: 0,
  version: ENCRYPTED_FILE_MAGIC_LENGTH,
  reserved: ENCRYPTED_FILE_MAGIC_LENGTH + 1,
  envelope: ENCRYPTED_FILE_HEADER_SIZE,
} as const);

/**
 * Return true when `bytes` starts with the encrypted-file magic. The
 * caller is expected to have read at least `ENCRYPTED_FILE_HEADER_SIZE`
 * bytes; shorter inputs are treated as plaintext.
 */
export function isEncryptedFile(bytes: Uint8Array | Buffer | string): boolean {
  if (typeof bytes === "string") {
    if (bytes.length < ENCRYPTED_FILE_MAGIC_LENGTH) return false;
    // Compare byte-by-byte without allocating a fresh Buffer for each
    // call — the magic includes a nul which `Buffer.from(s, "utf8")`
    // would not emit cleanly anyway.
    for (let i = 0; i < ENCRYPTED_FILE_MAGIC_LENGTH; i++) {
      if (bytes.charCodeAt(i) !== ENCRYPTED_FILE_MAGIC[i]) return false;
    }
    return true;
  }
  if (!(bytes instanceof Uint8Array) || bytes.length < ENCRYPTED_FILE_MAGIC_LENGTH) {
    return false;
  }
  for (let i = 0; i < ENCRYPTED_FILE_MAGIC_LENGTH; i++) {
    if (bytes[i] !== ENCRYPTED_FILE_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Encrypt `plaintext` under `key` and return the full encrypted-file
 * buffer (magic + version + reserved + sealed envelope). Pure: no I/O.
 *
 * @param key 32-byte AES-256 master key. Caller-owned; the keyring
 *   passes its registered buffer through unchanged.
 * @param plaintext UTF-8 text or raw bytes to encrypt.
 * @param options optional `aad` to bind into the envelope's GCM
 *   auth tag (typically the file's basename so a tampering operator
 *   cannot rename one encrypted file over another).
 */
export function encryptFileBody(
  key: Buffer,
  plaintext: string | Uint8Array,
  options: { aad?: Uint8Array } = {},
): Buffer {
  const plainBytes =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
  const salt = generateSalt();
  const sealOpts = options.aad !== undefined ? { aad: options.aad } : {};
  const envelope = sealEnvelope(key, salt, plainBytes, sealOpts);
  const out = Buffer.alloc(ENCRYPTED_FILE_HEADER_SIZE + envelope.length);
  ENCRYPTED_FILE_MAGIC.copy(out, ENCRYPTED_FILE_LAYOUT.magic);
  out.writeUInt8(ENCRYPTED_FILE_VERSION, ENCRYPTED_FILE_LAYOUT.version);
  // Reserved bytes already zeroed by `Buffer.alloc`.
  envelope.copy(out, ENCRYPTED_FILE_LAYOUT.envelope);
  return out;
}

/**
 * Decrypt an encrypted-file buffer produced by `encryptFileBody`.
 * Throws on bad magic, unsupported version, truncated input, or
 * authentication failure.
 *
 * The error message intentionally collapses "wrong key" and "tampered
 * ciphertext" into the same surface — both are non-recoverable from
 * the caller's standpoint and revealing which one happened leaks
 * information about the key state.
 */
export function decryptFileBody(
  key: Buffer,
  bytes: Uint8Array | Buffer,
  options: { aad?: Uint8Array } = {},
): Buffer {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("encrypted file body must be a Uint8Array");
  }
  if (bytes.length < ENCRYPTED_FILE_HEADER_SIZE + SEALED_ENVELOPE_HEADER_SIZE) {
    throw new Error(
      `encrypted file too short: need ≥ ${
        ENCRYPTED_FILE_HEADER_SIZE + SEALED_ENVELOPE_HEADER_SIZE
      } bytes, got ${bytes.length}`,
    );
  }
  if (!isEncryptedFile(bytes)) {
    throw new Error("encrypted file: bad magic bytes");
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = buf.readUInt8(ENCRYPTED_FILE_LAYOUT.version);
  if (version !== ENCRYPTED_FILE_VERSION) {
    throw new Error(
      `unsupported encrypted-file version: ${version} (this build supports ${ENCRYPTED_FILE_VERSION})`,
    );
  }
  // Reserved bytes are not validated — they're reserved precisely so
  // that a future writer can stamp them without breaking a current
  // reader. A future reader may tighten this.
  const envelope = buf.subarray(ENCRYPTED_FILE_LAYOUT.envelope);
  const openOpts = options.aad !== undefined ? { aad: options.aad } : {};
  return openSealed(key, envelope, openOpts);
}

/** Options shared by the read/write helpers. */
export interface SecureFsOptions {
  /**
   * Master key. When `null` or omitted on a read, encrypted files
   * raise `SecureStoreLockedError`; on a write, the file is written
   * as plaintext (callers gate on `secureStoreEncryptOnWrite`).
   */
  key?: Buffer | null;
  /**
   * Optional AAD bound into the envelope. When provided, the same AAD
   * must be supplied at decrypt time. Common pattern: pass the file's
   * basename so a tampering operator cannot rename one encrypted file
   * onto another. This module does not auto-derive AAD; callers opt
   * in explicitly.
   */
  aad?: Uint8Array;
}

/**
 * Error raised when a read encounters an encrypted file but no key is
 * available (locked store). Distinct from a generic `Error` so
 * orchestrator code can match `instanceof` and surface a clear
 * "secure store is locked" message rather than a corruption error.
 */
export class SecureStoreLockedError extends Error {
  override readonly name = "SecureStoreLockedError";
  readonly filePath: string;
  constructor(filePath: string) {
    super(
      `secure store is locked: cannot read encrypted memory file ${filePath}. Run 'remnic secure-store unlock' to unlock.`,
    );
    this.filePath = filePath;
  }
}

/**
 * Read a memory file and return its UTF-8 plaintext, transparently
 * decrypting if the file is encrypted.
 *
 * Behavior matrix:
 *   - file does not exist → propagates `ENOENT`
 *   - file is plaintext (no magic) → returned as-is (back-compat)
 *   - file is encrypted + key present → decrypted, returned as UTF-8
 *   - file is encrypted + no key → throws `SecureStoreLockedError`
 *   - file is encrypted + wrong key / tampered → throws (auth failure)
 */
export async function readMaybeEncryptedFile(
  filePath: string,
  options: SecureFsOptions = {},
): Promise<string> {
  const raw = await readFile(filePath);
  if (!isEncryptedFile(raw)) {
    return raw.toString("utf8");
  }
  if (!options.key) {
    throw new SecureStoreLockedError(filePath);
  }
  const decryptOpts = options.aad !== undefined ? { aad: options.aad } : {};
  const plaintext = decryptFileBody(options.key, raw, decryptOpts);
  return plaintext.toString("utf8");
}

/**
 * Write a memory file. Encrypted iff `key` is provided, plaintext
 * otherwise. Always writes via temp + atomic rename — never delete-
 * before-write (CLAUDE.md gotcha #54).
 *
 * The caller is responsible for snapshotting the prior content via
 * page-versioning before invoking this helper. We don't reach into
 * page-versioning here so this module stays free of cross-cutting
 * dependencies (it can be unit-tested in isolation against a tmpdir).
 */
export async function writeMaybeEncryptedFile(
  filePath: string,
  content: string | Uint8Array,
  options: SecureFsOptions = {},
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    if (options.key) {
      const encryptOpts = options.aad !== undefined ? { aad: options.aad } : {};
      const wrapped = encryptFileBody(options.key, content, encryptOpts);
      await writeFile(tempPath, wrapped);
    } else {
      const plain =
        typeof content === "string" ? content : Buffer.from(content).toString("utf8");
      await writeFile(tempPath, plain, "utf8");
    }
    await rename(tempPath, filePath);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // best-effort temp cleanup
    }
    throw err;
  }
}

/**
 * Outcome record for `migrateMemoryDirToEncrypted`. Returned so the
 * CLI / operator can present a summary and so tests can assert
 * deterministic counts.
 */
export interface SecureFsMigrationReport {
  /** Total `.md` files inspected. */
  scanned: number;
  /** Files re-written as encrypted. */
  encrypted: number;
  /** Files skipped because they were already encrypted. */
  alreadyEncrypted: number;
  /** Files skipped because they failed to read (e.g. permissions). */
  skipped: number;
  /** Per-file errors keyed by absolute path. */
  errors: Array<{ filePath: string; message: string }>;
}

/**
 * Optional snapshot callback. Invoked once per file BEFORE the
 * encrypted re-write, with the current plaintext content. Lets the
 * caller (e.g. `Storage`) plug in `page-versioning.createPageVersion`
 * so every migrated file has a recoverable plaintext snapshot.
 *
 * Failures inside the snapshot callback abort the per-file rewrite and
 * are recorded in `errors`. The callback contract is "snapshot must
 * succeed before encryption proceeds", matching CLAUDE.md gotcha #25
 * (don't destroy old state before confirming new state succeeds).
 */
export type SecureFsSnapshotFn = (filePath: string, plaintext: string) => Promise<void>;

export interface MigrateMemoryDirOptions extends SecureFsOptions {
  /** Filename suffixes considered "memory files". Defaults to `[".md"]`. */
  fileSuffixes?: ReadonlyArray<string>;
  /**
   * Subdirectories to skip during the walk. Always skips the
   * `.secure-store/` and `.versions/` directories regardless of this
   * setting; values supplied here are added on top.
   */
  skipDirs?: ReadonlyArray<string>;
  /** Optional pre-rewrite snapshot hook (page-versioning). */
  snapshot?: SecureFsSnapshotFn;
}

const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  ".secure-store",
  ".versions",
  ".git",
]);

/**
 * Walk `dir` recursively and re-write every memory file as encrypted.
 * Already-encrypted files are detected via the magic bytes and
 * skipped. Per-file errors are collected and returned rather than
 * aborting the whole walk — partial migration is recoverable; a
 * mid-walk throw is not.
 *
 * Requires an unlocked key. Calling with `key` unset throws
 * synchronously before any I/O so a misconfigured invocation cannot
 * silently produce a half-migrated tree.
 */
export async function migrateMemoryDirToEncrypted(
  dir: string,
  options: MigrateMemoryDirOptions,
): Promise<SecureFsMigrationReport> {
  if (!options.key) {
    throw new Error(
      "migrateMemoryDirToEncrypted requires an unlocked secure-store key (options.key)",
    );
  }
  const fileSuffixes = options.fileSuffixes ?? [".md"];
  const skipDirs = new Set<string>(DEFAULT_SKIP_DIRS);
  if (options.skipDirs) {
    for (const name of options.skipDirs) skipDirs.add(name);
  }
  const report: SecureFsMigrationReport = {
    scanned: 0,
    encrypted: 0,
    alreadyEncrypted: 0,
    skipped: 0,
    errors: [],
  };

  // Iterative DFS so we can skip subdirectories cheaply.
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch (err) {
      report.errors.push({ filePath: current, message: errMsg(err) });
      continue;
    }
    for (const name of entries) {
      if (skipDirs.has(name)) continue;
      const full = path.join(current, name);
      let entryStat;
      try {
        entryStat = await stat(full);
      } catch (err) {
        report.errors.push({ filePath: full, message: errMsg(err) });
        continue;
      }
      if (entryStat.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entryStat.isFile()) continue;
      if (!fileSuffixes.some((sfx) => name.endsWith(sfx))) continue;

      report.scanned += 1;
      let raw: Buffer;
      try {
        raw = await readFile(full);
      } catch (err) {
        report.skipped += 1;
        report.errors.push({ filePath: full, message: errMsg(err) });
        continue;
      }
      if (isEncryptedFile(raw)) {
        report.alreadyEncrypted += 1;
        continue;
      }
      const plaintext = raw.toString("utf8");
      if (options.snapshot) {
        try {
          await options.snapshot(full, plaintext);
        } catch (err) {
          // Don't proceed to re-write if the snapshot failed: we'd
          // lose the recoverable plaintext copy.
          report.skipped += 1;
          report.errors.push({
            filePath: full,
            message: `snapshot failed: ${errMsg(err)}`,
          });
          continue;
        }
      }
      try {
        const writeOpts: SecureFsOptions = { key: options.key };
        if (options.aad !== undefined) writeOpts.aad = options.aad;
        await writeMaybeEncryptedFile(full, plaintext, writeOpts);
        report.encrypted += 1;
      } catch (err) {
        report.skipped += 1;
        report.errors.push({ filePath: full, message: errMsg(err) });
      }
    }
  }
  return report;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
