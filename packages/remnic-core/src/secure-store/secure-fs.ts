/**
 * Transparent file-level encryption for the secure-store module.
 *
 * Issue #690 (PR 3/4) — storage.ts integration layer.
 *
 * This module sits between the raw filesystem and StorageManager.
 * Every memory file is either:
 *   - a plain UTF-8 text file (legacy, back-compat), or
 *   - a REMNIC-ENC sealed file (AES-256-GCM, see format below).
 *
 * On-disk format
 * --------------
 * Encrypted files begin with a 9-byte magic header:
 *
 *   REMNIC-ENC  (7 ASCII bytes)
 *   VER         (1 byte, currently 0x01)
 *   FLAGS       (1 byte, reserved, must be 0x00)
 *
 * Followed immediately by a `seal()` envelope from `cipher.ts`:
 *
 *   [VERSION:1][SALT:16][IV:12][AUTHTAG:16][CIPHERTEXT:...]
 *
 * The magic header makes encrypted files sniffable without attempting
 * a full `open()` call and gives operators a clear signal that the
 * file cannot be read by opening it in an editor.
 *
 * AAD
 * ---
 * The file path relative to the memory root is bound as Associated
 * Authenticated Data (AAD) on both encrypt and decrypt. This means
 * moving or renaming an encrypted file without re-encrypting it will
 * cause auth-tag failure on the next read — the file is tied to its
 * path. Callers that move files must re-encrypt them.
 *
 * Back-compat
 * -----------
 * `readMaybeEncryptedFile` transparently handles both formats: if the
 * file does NOT start with the magic bytes, it is returned as-is (plain
 * text). This lets an operator migrate incrementally: newly-written
 * files are encrypted while existing files continue to be read in plain
 * form until `migrateMemoryDirToEncrypted` is run.
 *
 * Naming: `secure-fs.ts` (not `vault-fs.ts`) — see `kdf.ts` naming note.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { generateSalt, open, seal } from "./cipher.js";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when a read is attempted but the keyring entry for this
 * store is absent (i.e. `secure-store unlock` has not been run
 * since the last daemon start).
 */
export class SecureStoreLockedError extends Error {
  constructor(message = "secure-store is locked — run `remnic secure-store unlock` to decrypt") {
    super(message);
    this.name = "SecureStoreLockedError";
  }
}

/**
 * Thrown when `open()` fails because the auth tag does not validate.
 * This covers both wrong-key and tampered-ciphertext scenarios —
 * intentionally indistinguishable from the caller's perspective.
 */
export class SecureStoreDecryptError extends Error {
  constructor(message = "secure-store decryption failed — wrong key or tampered ciphertext") {
    super(message);
    this.name = "SecureStoreDecryptError";
  }
}

// ---------------------------------------------------------------------------
// Magic header
// ---------------------------------------------------------------------------

/** Magic bytes: the ASCII string "REMNIC-ENC" (10 bytes). */
export const MAGIC_BYTES = Buffer.from("REMNIC-ENC", "ascii");

/** Current on-disk version byte. */
export const FILE_FORMAT_VERSION = 0x01;

/** Reserved flags byte — must be 0x00. */
export const FILE_FORMAT_FLAGS = 0x00;

/** Total size of the magic header prefix (magic + version + flags). */
export const MAGIC_HEADER_SIZE = MAGIC_BYTES.length + 2; // 12 bytes

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Return true iff `buf` begins with the REMNIC-ENC magic header.
 * Does not validate the envelope; just identifies the format.
 */
export function isEncryptedFile(buf: Uint8Array): boolean {
  if (buf.length < MAGIC_HEADER_SIZE) return false;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.subarray(0, MAGIC_BYTES.length).equals(MAGIC_BYTES);
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt file body
// ---------------------------------------------------------------------------

/**
 * Encrypt `plain` (UTF-8 content of a memory file) and return a
 * Buffer ready to write to disk.
 *
 * @param plain  Plain-text file content (UTF-8 string or Buffer).
 * @param key    32-byte AES-256 key from the keyring.
 * @param aad    Optional associated data — defaults to empty if omitted.
 *               Callers should pass the file path relative to memoryDir
 *               so the ciphertext is bound to its location.
 */
export function encryptFileBody(plain: string | Buffer, key: Buffer, aad?: Buffer): Buffer {
  const plainBuf = typeof plain === "string" ? Buffer.from(plain, "utf8") : plain;
  const salt = generateSalt();
  const envelope = seal(key, salt, plainBuf, aad ? { aad } : {});

  const header = Buffer.alloc(MAGIC_HEADER_SIZE);
  MAGIC_BYTES.copy(header, 0);
  header.writeUInt8(FILE_FORMAT_VERSION, MAGIC_BYTES.length);
  header.writeUInt8(FILE_FORMAT_FLAGS, MAGIC_BYTES.length + 1);

  return Buffer.concat([header, envelope]);
}

/**
 * Decrypt a buffer produced by `encryptFileBody` and return the
 * original UTF-8 content.
 *
 * Throws `SecureStoreDecryptError` on auth failure (wrong key or
 * tampered ciphertext). Throws a plain `Error` for structural problems
 * (truncated buffer, wrong magic, unsupported version).
 */
export function decryptFileBody(buf: Buffer, key: Buffer, aad?: Buffer): Buffer {
  if (!isEncryptedFile(buf)) {
    throw new Error("decryptFileBody: buffer does not start with REMNIC-ENC magic header");
  }
  const version = buf.readUInt8(MAGIC_BYTES.length);
  if (version !== FILE_FORMAT_VERSION) {
    throw new Error(
      `decryptFileBody: unsupported file format version ${version} (this build supports ${FILE_FORMAT_VERSION})`,
    );
  }
  const flags = buf.readUInt8(MAGIC_BYTES.length + 1);
  if (flags !== FILE_FORMAT_FLAGS) {
    throw new Error(`decryptFileBody: unknown flags byte 0x${flags.toString(16).padStart(2, "0")}`);
  }
  const envelope = buf.subarray(MAGIC_HEADER_SIZE);
  try {
    return open(key, envelope, aad ? { aad } : {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SecureStoreDecryptError(
      `secure-store decryption failed: ${msg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Path → AAD helper
// ---------------------------------------------------------------------------

/**
 * Build the AAD buffer for a file at `filePath` relative to
 * `memoryDir`. The AAD binds the ciphertext to its path so a
 * file cannot be silently relocated without re-encryption.
 *
 * When `memoryDir` is supplied and `filePath` is absolute, the
 * relative sub-path is used. Otherwise `filePath` is used verbatim.
 */
export function filePathAad(filePath: string, memoryDir?: string): Buffer {
  let rel = filePath;
  if (memoryDir && path.isAbsolute(filePath)) {
    rel = path.relative(memoryDir, filePath);
  }
  return Buffer.from(rel, "utf8");
}

// ---------------------------------------------------------------------------
// High-level read / write helpers
// ---------------------------------------------------------------------------

/**
 * Read a file from `filePath`.
 *
 * - If the file is plaintext (no magic header), return its content
 *   as-is — back-compat with unencrypted stores.
 * - If the file is encrypted AND `key` is provided, decrypt and return
 *   the plaintext content.
 * - If the file is encrypted AND `key` is null, throw
 *   `SecureStoreLockedError`.
 *
 * @param filePath  Absolute path to the file.
 * @param key       32-byte AES-256 key, or null when the store is locked.
 * @param memoryDir Memory root for path-bound AAD.  Should be absolute.
 */
export async function readMaybeEncryptedFile(
  filePath: string,
  key: Buffer | null,
  memoryDir?: string,
): Promise<string> {
  const buf = await readFile(filePath);
  if (!isEncryptedFile(buf)) {
    // Plain UTF-8 file — legacy or unencrypted store.
    return buf.toString("utf8");
  }
  // Encrypted — key required.
  if (key === null) {
    throw new SecureStoreLockedError(
      `secure-store is locked — cannot read encrypted file at ${filePath}. ` +
        "Run `remnic secure-store unlock` to decrypt.",
    );
  }
  const aad = filePathAad(filePath, memoryDir);
  const plain = decryptFileBody(buf, key, aad);
  return plain.toString("utf8");
}

export interface WriteMaybeEncryptedFileOptions {
  /**
   * File mode bits. Default 0o600 (owner read/write only).
   * Applied only on create; existing files inherit their existing mode.
   */
  mode?: number;
  /**
   * If true, write atomically via a temp file + rename (CLAUDE.md gotcha #54).
   * Default true.
   */
  atomic?: boolean;
}

/**
 * Write `content` to `filePath`.
 *
 * - If `key` is provided and non-null, encrypt the content first.
 * - If `key` is null, write the content as plain UTF-8 (unencrypted store).
 *
 * Writes atomically: content is written to a `.tmp-<pid>-<ts>` file
 * first, then renamed into place (CLAUDE.md gotcha #54 — never delete
 * before write).
 */
export async function writeMaybeEncryptedFile(
  filePath: string,
  content: string,
  key: Buffer | null,
  options: WriteMaybeEncryptedFileOptions = {},
  memoryDir?: string,
): Promise<void> {
  const { mode = 0o600, atomic = true } = options;
  await mkdir(path.dirname(filePath), { recursive: true });

  let data: Buffer | string;
  if (key !== null) {
    const aad = filePathAad(filePath, memoryDir);
    data = encryptFileBody(content, key, aad);
  } else {
    data = content;
  }

  if (atomic) {
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tempPath, data, { mode });
      await rename(tempPath, filePath);
    } catch (err) {
      // Best-effort cleanup of the temp file.
      try {
        await unlink(tempPath);
      } catch {
        // ignore
      }
      throw err;
    }
  } else {
    await writeFile(filePath, data, { mode });
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface MigrateResult {
  /** Number of files successfully encrypted. */
  encrypted: number;
  /** Number of files already encrypted (skipped). */
  skipped: number;
  /** Files that failed to encrypt (path → error message). */
  errors: Array<{ filePath: string; error: string }>;
}

/**
 * Walk `dir` recursively, find all `.md` files that are not yet
 * encrypted, and re-write them as encrypted files under `key`.
 *
 * Safety rules per CLAUDE.md gotchas #54 and #25:
 *   1. A page-version snapshot is taken (via `createVersion`) BEFORE
 *      each overwrite so the plaintext version is preserved in history.
 *      Since this module has no direct access to `page-versioning.ts`
 *      internals, callers who have page-versioning configured should
 *      pass `onBeforeEncrypt` to take the snapshot.
 *   2. The new encrypted content is written to a temp file first,
 *      then renamed atomically — never deleted before written.
 *   3. If encryption of any file fails, the error is recorded and the
 *      original file is left intact (partial migration is safe).
 *
 * @param dir              Absolute path to the memory directory.
 * @param key              32-byte AES-256 key.
 * @param onBeforeEncrypt  Optional callback invoked before encrypting
 *                         each file. Can be used to take page-version
 *                         snapshots. Errors here are non-fatal.
 */
export async function migrateMemoryDirToEncrypted(
  dir: string,
  key: Buffer,
  onBeforeEncrypt?: (filePath: string) => Promise<void>,
): Promise<MigrateResult> {
  const result: MigrateResult = { encrypted: 0, skipped: 0, errors: [] };

  const mdFiles = await collectMdFiles(dir);
  for (const filePath of mdFiles) {
    try {
      const buf = await readFile(filePath);
      if (isEncryptedFile(buf)) {
        result.skipped++;
        continue;
      }
      // Call optional pre-encryption hook (e.g. page-version snapshot).
      if (onBeforeEncrypt) {
        try {
          await onBeforeEncrypt(filePath);
        } catch {
          // Non-fatal — continue with encryption even if snapshot fails.
        }
      }
      const content = buf.toString("utf8");
      const aad = filePathAad(filePath, dir);
      const encrypted = encryptFileBody(content, key, aad);

      // Atomic write: temp → rename (gotcha #54).
      const tempPath = `${filePath}.enc-tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(tempPath, encrypted, { mode: 0o600 });
        await rename(tempPath, filePath);
        result.encrypted++;
      } catch (writeErr) {
        // Clean up temp file, leave original intact.
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(tempPath);
        } catch {
          // ignore
        }
        throw writeErr;
      }
    } catch (err) {
      result.errors.push({
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all `.md` files under `dir`, excluding
 * `.secure-store/` subdirectory (header files are not memory files).
 */
async function collectMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".secure-store")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectMdFiles(full);
      results.push(...sub);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}
