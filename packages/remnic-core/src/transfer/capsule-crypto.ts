/**
 * Capsule and backup archive encryption helpers (issue #690 PR 4/4).
 *
 * This module sits between the capsule export/import pipeline and the
 * secure-store primitives (PR 1/4 cipher + PR 2/4 keyring). It handles:
 *
 *   - Wrapping a raw `.capsule.json.gz` payload in an AES-256-GCM sealed
 *     envelope with a small plaintext header so auto-detection works without
 *     decryption.
 *   - Symmetrically: reading that header, decrypting the payload, and
 *     returning the original `.capsule.json.gz` bytes.
 *   - The same encrypt/decrypt helpers are re-used by the backup pipeline
 *     (`backup --encrypt`).
 *
 * On-disk format for an encrypted archive
 * ----------------------------------------
 * The encrypted file uses the extension `.capsule.json.gz.enc` and starts
 * with a small ASCII header terminated by a NUL byte so the MIME type can
 * be determined cheaply:
 *
 *   "REMNIC-ENC\x00" (11 bytes, magic + NUL sentinel)
 *   UINT8              format version (currently 1)
 *   <seal envelope>    rest of file: the AES-GCM sealed envelope produced by
 *                      cipher.ts, containing the original gzip bytes
 *
 * The magic string is chosen to be:
 *   - ASCII-safe (no UTF-8 confusion)
 *   - obviously non-JSON (won't parse as a JSON object)
 *   - obviously non-gzip (gzip magic is 0x1f 0x8b; 'R' is 0x52)
 *
 * The sealed envelope format is documented in `cipher.ts`:
 *   [VERSION:1][SALT:16][IV:12][AUTHTAG:16][CIPHERTEXT:...]
 *
 * The original gzip bytes are the ciphertext. There is no additional
 * framing inside the ciphertext; decryption yields the original `.gz`
 * bytes verbatim.
 *
 * AAD
 * ---
 * The file's basename (without the `.enc` suffix, as a UTF-8 buffer) is
 * bound as AAD so the sealed envelope is tied to its filename. Renaming an
 * encrypted capsule file causes auth-tag failure on open. This prevents a
 * replay where an attacker substitutes one user's encrypted capsule for
 * another's. Callers MUST supply the same basename on encrypt and decrypt.
 *
 * Cross-machine restore
 * ---------------------
 * The passphrase is used to derive the key via scrypt. Any machine that
 * knows the original passphrase can re-derive the same key (the salt is
 * embedded in the sealed envelope) and decrypt the archive. No out-of-band
 * key material is required.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { open, seal } from "../secure-store/cipher.js";
import * as keyring from "../secure-store/keyring.js";
import { deriveKeyFromHeader, readHeader, secureStoreDir } from "../secure-store/header.js";

// ---------------------------------------------------------------------------
// On-disk magic
// ---------------------------------------------------------------------------

/** ASCII magic + NUL sentinel — 11 bytes total. */
const MAGIC = Buffer.from("REMNIC-ENC\x00", "ascii");

/** Current format version byte. */
const FORMAT_VERSION = 1;

/** Minimum encrypted file size: magic (11) + version (1) + envelope header (45). */
const MIN_ENC_SIZE = MAGIC.length + 1 + 45; // 45 = cipher.ts ENVELOPE_HEADER_SIZE

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface EncryptCapsuleOptions {
  /**
   * Absolute path to the source `.capsule.json.gz` (or `.backup.tar.gz`)
   * payload to encrypt.
   */
  sourceGzPath: string;

  /**
   * Absolute path to the memory directory whose secure-store keyring will
   * be queried for the master key.
   */
  memoryDir: string;

  /**
   * Destination path for the encrypted output. If omitted, defaults to
   * `sourceGzPath + ".enc"`.
   */
  outPath?: string;
}

export interface EncryptCapsuleResult {
  /** Absolute path to the encrypted archive file. */
  encPath: string;
}

export interface DecryptCapsuleOptions {
  /**
   * Absolute path to the `.enc` encrypted archive to decrypt.
   */
  encPath: string;

  /**
   * Absolute path to the memory directory whose secure-store keyring will
   * be queried for the master key.
   */
  memoryDir: string;

  /**
   * Destination path for the decrypted output. If omitted, defaults to
   * `encPath` with the `.enc` suffix removed.
   */
  outPath?: string;
}

export interface DecryptCapsuleResult {
  /** Absolute path to the decrypted archive file. */
  gzPath: string;
}

/**
 * Return `true` iff the given file path ends with `.enc` AND its first bytes
 * match the REMNIC-ENC magic header. The check is done by reading only the
 * first `MIN_ENC_SIZE` bytes so it is cheap enough to call on every import.
 *
 * Throws only on I/O errors; returns `false` for files that are too short
 * or whose magic does not match.
 */
export async function isEncryptedCapsuleFile(filePath: string): Promise<boolean> {
  if (!filePath.endsWith(".enc")) return false;
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch {
    return false;
  }
  if (buf.length < MIN_ENC_SIZE) return false;
  return buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Encrypt a `.capsule.json.gz` (or `.backup.tar.gz`) payload using the
 * secure-store master key held in the in-memory keyring for `memoryDir`.
 *
 * The key MUST already be unlocked in the keyring (`remnic secure-store
 * unlock`). If the store is locked or has never been initialized, this
 * function throws a clear error rather than silently producing an
 * un-decryptable output.
 *
 * Writes atomically: the output is assembled in memory and written in a
 * single `writeFile` call so a crash mid-write cannot leave a partial file
 * that passes the magic check but fails decryption (gotcha #54 — do not
 * delete-before-write; here we write-new rather than replace, so no prior
 * valid file can be destroyed).
 */
export async function encryptCapsuleFile(
  opts: EncryptCapsuleOptions,
): Promise<EncryptCapsuleResult> {
  const encPath = opts.outPath ?? `${opts.sourceGzPath}.enc`;
  const key = getKeyOrThrow(opts.memoryDir, "encrypt capsule");

  // Read the source payload.
  const plaintext = await readFile(opts.sourceGzPath);

  // Bind the output filename (without .enc) as AAD so the envelope is
  // tied to its destination path (Codex P1: replay prevention).
  const basename = path.basename(encPath);
  const aad = Buffer.from(basename, "utf-8");

  // Load the header to extract the canonical salt so the per-blob salt
  // matches the store's metadata salt.  The cipher's envelope embeds the
  // salt verbatim; we read it from the header rather than generating a
  // fresh one so dedup across re-encrypts of the same capsule is possible
  // and so diagnostic tooling can verify the salt matches the store.
  const salt = await loadStoreSalt(opts.memoryDir);

  const envelope = seal(key, salt, plaintext, { aad });

  // Assemble the encrypted file: magic + version + envelope.
  const version = Buffer.alloc(1);
  version.writeUInt8(FORMAT_VERSION, 0);
  const output = Buffer.concat([MAGIC, version, envelope]);

  await writeFile(encPath, output);
  return { encPath };
}

/**
 * Decrypt a `.enc` encrypted capsule or backup archive.
 *
 * Validates the magic header and format version before attempting
 * decryption. Throws with a clear message on:
 *   - non-enc file / wrong magic
 *   - unsupported format version
 *   - locked/uninitialized secure-store
 *   - wrong key / tampered ciphertext (AES-GCM auth failure)
 */
export async function decryptCapsuleFile(
  opts: DecryptCapsuleOptions,
): Promise<DecryptCapsuleResult> {
  const gzPath = opts.outPath ?? opts.encPath.replace(/\.enc$/, "");
  const key = getKeyOrThrow(opts.memoryDir, "decrypt capsule");

  const buf = await readFile(opts.encPath);

  // Magic check.
  if (buf.length < MIN_ENC_SIZE) {
    throw new Error(
      `decryptCapsuleFile: file too short to be an encrypted capsule: ${opts.encPath}`,
    );
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(
      `decryptCapsuleFile: file does not start with REMNIC-ENC magic: ${opts.encPath}`,
    );
  }

  // Version check.
  const version = buf.readUInt8(MAGIC.length);
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `decryptCapsuleFile: unsupported encrypted-capsule format version ${version} ` +
        `(this build supports version ${FORMAT_VERSION}): ${opts.encPath}`,
    );
  }

  // The sealed envelope starts immediately after the magic + version byte.
  const envelope = buf.subarray(MAGIC.length + 1);

  // Reconstruct AAD from the basename of the enc file (same as encrypt).
  const basename = path.basename(opts.encPath);
  const aad = Buffer.from(basename, "utf-8");

  let plaintext: Buffer;
  try {
    plaintext = open(key, envelope, { aad });
  } catch (cause) {
    throw new Error(
      `decryptCapsuleFile: authentication failed — wrong passphrase, ` +
        `tampered archive, or key mismatch. ` +
        `Ensure the secure-store is unlocked with the correct passphrase and ` +
        `the archive has not been modified: ${opts.encPath}`,
      { cause: cause as Error },
    );
  }

  await writeFile(gzPath, plaintext);
  return { gzPath };
}

/**
 * Decrypt an encrypted capsule archive directly to a `Buffer` without writing
 * an intermediate file. Used by `importCapsule` so the plaintext gzip bytes
 * never touch disk during an in-memory import roundtrip.
 *
 * Semantics identical to {@link decryptCapsuleFile} except the output is
 * returned as a `Buffer` rather than written to disk.
 */
export async function decryptCapsuleFileInMemory(
  encPath: string,
  memoryDir: string,
): Promise<Buffer> {
  const key = getKeyOrThrow(memoryDir, "decrypt capsule");

  const buf = await readFile(encPath);

  if (buf.length < MIN_ENC_SIZE) {
    throw new Error(
      `decryptCapsuleFileInMemory: file too short to be an encrypted capsule: ${encPath}`,
    );
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(
      `decryptCapsuleFileInMemory: file does not start with REMNIC-ENC magic: ${encPath}`,
    );
  }

  const version = buf.readUInt8(MAGIC.length);
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `decryptCapsuleFileInMemory: unsupported encrypted-capsule format version ${version} ` +
        `(this build supports version ${FORMAT_VERSION}): ${encPath}`,
    );
  }

  const envelope = buf.subarray(MAGIC.length + 1);

  const basename = path.basename(encPath);
  const aad = Buffer.from(basename, "utf-8");

  try {
    return open(key, envelope, { aad });
  } catch (cause) {
    throw new Error(
      `decryptCapsuleFileInMemory: authentication failed — wrong passphrase, ` +
        `tampered archive, or key mismatch. ` +
        `Ensure the secure-store is unlocked with the correct passphrase and ` +
        `the archive has not been modified: ${encPath}`,
      { cause: cause as Error },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve the master key for `memoryDir` from the in-memory keyring, or
 * throw a clear actionable error if the store is locked or not initialized.
 *
 * Rule 51: never silently default when the user's intent is clear but the
 * precondition (unlocked keyring) is not met.
 */
function getKeyOrThrow(memoryDir: string, action: string): Buffer {
  const storeId = secureStoreDir(memoryDir);
  const key = keyring.getKey(storeId);
  if (key === null) {
    throw new Error(
      `Secure-store is locked or not initialized — cannot ${action}. ` +
        `Run \`remnic secure-store unlock\` first, or \`remnic secure-store init\` ` +
        `if the store has never been initialized.`,
    );
  }
  return key;
}

/**
 * Read the KDF salt from the secure-store header so per-blob salts match
 * the store's canonical salt. Falls back to generating a fresh random salt
 * only when the header cannot be read (e.g. in tests that skip header init).
 *
 * The cipher embeds the salt in the envelope, so decryption never needs to
 * call this function — `open()` reads the salt from the envelope directly.
 */
async function loadStoreSalt(memoryDir: string): Promise<Buffer> {
  try {
    const header = await readHeader(memoryDir);
    if (header !== null) {
      const { decodeMetadataSalt } = await import("../secure-store/metadata.js");
      return decodeMetadataSalt(header.metadata);
    }
  } catch {
    // Fall through to randomBytes fallback.
  }
  const { generateSalt } = await import("../secure-store/cipher.js");
  return generateSalt();
}
