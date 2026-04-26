/**
 * On-disk header for an initialized secure-store (issue #690 PR 2/4).
 *
 * The header file is the persistent record that a memory directory
 * has had `remnic secure-store init` run against it. It is a JSON
 * file at `<memoryDir>/.secure-store/header.json` with two parts:
 *
 *   1. The KDF metadata from PR 1/4 (`SecureStoreMetadata`) —
 *      algorithm, params, and salt. Public; safe to read/copy.
 *   2. A "verifier" — a tiny AES-GCM-encrypted envelope sealed under
 *      the derived key at init time. Unlock re-derives the key from
 *      the entered passphrase and tries to `open()` the verifier; if
 *      the auth tag validates, the passphrase is correct.
 *
 * Why a verifier?
 * ---------------
 * Without one, "wrong passphrase" can only be detected when the
 * daemon tries to decrypt actual memory data — too late for a
 * useful CLI error. The verifier gives the unlock command a fast,
 * data-independent passphrase check.
 *
 * The verifier plaintext is a fixed magic string (no secret content).
 * Its only role is to be sealable + openable; the auth-tag check is
 * what proves the key.
 *
 * Naming
 * ------
 * Directory: `.secure-store/` (leading dot — hidden, hints at
 * sensitivity). File: `header.json`. Avoids collision with
 * `.secure-store-metadata.json` from PR 1/4 docs since the header
 * is a strict superset.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { open, seal } from "./cipher.js";
import {
  KDF_KEY_LENGTH,
  KDF_SALT_LENGTH,
  deriveKey,
  type Argon2idParams,
  type ScryptParams,
} from "./kdf.js";
import {
  buildMetadata,
  decodeMetadataSalt,
  parseMetadata,
  serializeMetadata,
  type SecureStoreMetadata,
} from "./metadata.js";

/** Subdirectory under `memoryDir` that holds the header + future state. */
export const SECURE_STORE_DIR_NAME = ".secure-store";

/** Header filename. Stable name so operators can locate it. */
export const HEADER_FILENAME = "header.json";

/** Stable identifier so the file shape is sniffable without parsing JSON. */
export const HEADER_FORMAT = "remnic.secure-store.header" as const;

/** Current header format version. Bump on breaking schema changes. */
export const HEADER_FORMAT_VERSION = 1 as const;

/**
 * Magic bytes sealed under the master key at init time. Constant
 * across stores — there's no value in randomizing it because the
 * salt + IV + auth tag already make every verifier envelope unique.
 *
 * The string never appears in plaintext on disk; it only exists
 * inside an AES-GCM-sealed envelope. Its job is purely to give the
 * cipher something to authenticate.
 */
export const VERIFIER_PLAINTEXT = Buffer.from("remnic-secure-store-v1", "utf8");

/** AAD bound into the verifier envelope. */
const VERIFIER_AAD = Buffer.from("remnic-secure-store/verifier", "utf8");

export interface SecureStoreHeader {
  format: typeof HEADER_FORMAT;
  formatVersion: number;
  /** KDF metadata (algorithm + params + salt). */
  metadata: SecureStoreMetadata;
  /** Hex-encoded sealed envelope. */
  verifier: string;
  /** ISO-8601 timestamp recorded at init time. */
  createdAt: string;
}

/** Resolve the canonical secure-store directory for a memory root. */
export function secureStoreDir(memoryDir: string): string {
  return path.join(memoryDir, SECURE_STORE_DIR_NAME);
}

/** Resolve the canonical header path for a memory root. */
export function headerPath(memoryDir: string): string {
  return path.join(secureStoreDir(memoryDir), HEADER_FILENAME);
}

/**
 * Build a `SecureStoreHeader` in memory from an already-derived key
 * and metadata. Pure: does not touch the filesystem. The clock is
 * read once if `createdAt` is omitted.
 */
export function buildHeader(options: {
  metadata: SecureStoreMetadata;
  derivedKey: Buffer;
  createdAt?: string;
}): SecureStoreHeader {
  const { metadata, derivedKey } = options;
  if (!Buffer.isBuffer(derivedKey) || derivedKey.length !== KDF_KEY_LENGTH) {
    throw new Error(
      `derivedKey must be a ${KDF_KEY_LENGTH}-byte Buffer, got length=${derivedKey?.length ?? "non-buffer"}`,
    );
  }
  const salt = decodeMetadataSalt(metadata);
  if (salt.length !== KDF_SALT_LENGTH) {
    throw new Error(`metadata salt is ${salt.length} bytes, expected ${KDF_SALT_LENGTH}`);
  }
  const envelope = seal(derivedKey, salt, VERIFIER_PLAINTEXT, { aad: VERIFIER_AAD });
  return {
    format: HEADER_FORMAT,
    formatVersion: HEADER_FORMAT_VERSION,
    metadata,
    verifier: envelope.toString("hex"),
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

/** Stable JSON serialization with locked top-level key order. */
export function serializeHeader(header: SecureStoreHeader): string {
  validateHeader(header);
  // Inline metadata as a parsed object so it shares the same
  // canonical key ordering as the standalone metadata file.
  const metadataString = serializeMetadata(header.metadata);
  const metadataObject = JSON.parse(metadataString) as Record<string, unknown>;
  const ordered = {
    format: header.format,
    formatVersion: header.formatVersion,
    metadata: metadataObject,
    verifier: header.verifier,
    createdAt: header.createdAt,
  };
  return JSON.stringify(ordered, null, 2);
}

/** Parse a header JSON string. Throws on any structural problem. */
export function parseHeader(json: string): SecureStoreHeader {
  if (typeof json !== "string") {
    throw new Error("header input must be a string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`header is not valid JSON: ${msg}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("header must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== HEADER_FORMAT) {
    throw new Error(
      `unexpected header format: ${String(obj.format)} (expected ${HEADER_FORMAT})`,
    );
  }
  if (obj.formatVersion !== HEADER_FORMAT_VERSION) {
    throw new Error(
      `unsupported header formatVersion: ${String(obj.formatVersion)} (this build supports ${HEADER_FORMAT_VERSION})`,
    );
  }
  if (typeof obj.verifier !== "string" || obj.verifier.length === 0) {
    throw new Error("header.verifier must be a non-empty hex string");
  }
  if (!/^[0-9a-f]+$/i.test(obj.verifier)) {
    throw new Error("header.verifier must be a hex-encoded string");
  }
  if (typeof obj.createdAt !== "string" || obj.createdAt.length === 0) {
    throw new Error("header.createdAt must be a non-empty string");
  }
  if (typeof obj.metadata !== "object" || obj.metadata === null) {
    throw new Error("header.metadata must be an object");
  }
  // Reuse the metadata parser for nested validation. We re-stringify
  // the nested object and feed it through `parseMetadata` so any
  // schema drift is caught in one place.
  const metadata = parseMetadata(JSON.stringify(obj.metadata));
  const header: SecureStoreHeader = {
    format: HEADER_FORMAT,
    formatVersion: HEADER_FORMAT_VERSION,
    metadata,
    verifier: obj.verifier,
    createdAt: obj.createdAt,
  };
  validateHeader(header);
  return header;
}

/** Validate a header object's invariants. Throws on the first problem. */
export function validateHeader(header: SecureStoreHeader): void {
  if (header.format !== HEADER_FORMAT) {
    throw new Error(`header.format must be ${HEADER_FORMAT}`);
  }
  if (header.formatVersion !== HEADER_FORMAT_VERSION) {
    throw new Error(`header.formatVersion must be ${HEADER_FORMAT_VERSION}`);
  }
  if (typeof header.createdAt !== "string" || header.createdAt.length === 0) {
    throw new Error("header.createdAt must be a non-empty ISO-8601 string");
  }
  if (typeof header.verifier !== "string" || header.verifier.length === 0) {
    throw new Error("header.verifier must be a non-empty hex string");
  }
  if (!/^[0-9a-f]+$/i.test(header.verifier)) {
    throw new Error("header.verifier must be a hex-encoded string");
  }
  // The nested metadata object is already validated by `parseMetadata`
  // when read from disk; on the build path, `buildHeader` constructs
  // it via `buildMetadata`. We still re-run shape validation here as
  // a belt-and-braces guard for callers that hand-construct headers.
  if (header.metadata.format !== "remnic.secure-store.metadata") {
    throw new Error("header.metadata.format must be remnic.secure-store.metadata");
  }
}

/**
 * Verify a candidate key against the header's verifier envelope.
 *
 * Returns true iff the AES-GCM auth tag validates. Wrong passphrase,
 * tampered envelope, and tampered AAD all return false.
 */
export function verifyKey(header: SecureStoreHeader, candidateKey: Buffer): boolean {
  if (!Buffer.isBuffer(candidateKey) || candidateKey.length !== KDF_KEY_LENGTH) {
    return false;
  }
  const envelope = Buffer.from(header.verifier, "hex");
  try {
    const plaintext = open(candidateKey, envelope, { aad: VERIFIER_AAD });
    return plaintext.equals(VERIFIER_PLAINTEXT);
  } catch {
    return false;
  }
}

/**
 * Derive a key from the passphrase using the algorithm + params +
 * salt recorded in the header. Pure: no I/O.
 */
export function deriveKeyFromHeader(header: SecureStoreHeader, passphrase: string): Buffer {
  const salt = decodeMetadataSalt(header.metadata);
  const params: ScryptParams | Argon2idParams =
    header.metadata.kdf.algorithm === "scrypt"
      ? header.metadata.kdf.params
      : header.metadata.kdf.params;
  return deriveKey(header.metadata.kdf.algorithm, passphrase, salt, params);
}

/**
 * Read and parse the header at `<memoryDir>/.secure-store/header.json`.
 * Returns `null` if the file does not exist; throws on malformed
 * content.
 */
export async function readHeader(memoryDir: string): Promise<SecureStoreHeader | null> {
  const target = headerPath(memoryDir);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw e;
  }
  return parseHeader(raw);
}

/**
 * Write the header atomically: serialize → write to a temp file in
 * the same directory → fsync-by-rename → done.
 *
 * Refuses to overwrite an existing header; the caller must explicitly
 * remove the existing header first. This guards against accidental
 * reinitialization.
 */
export async function writeHeader(memoryDir: string, header: SecureStoreHeader): Promise<string> {
  validateHeader(header);
  const dir = secureStoreDir(memoryDir);
  await mkdir(dir, { recursive: true });
  const target = headerPath(memoryDir);
  // Existence check via readFile: writeFile with `wx` flag would also
  // work, but readFile gives a clearer error message.
  let exists = false;
  try {
    await readFile(target, "utf8");
    exists = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
  if (exists) {
    throw new Error(
      `secure-store header already exists at ${target}. Refusing to overwrite — initialize a fresh store or remove the existing header explicitly.`,
    );
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  // Per CLAUDE.md gotcha #54: write tmp first, rename atomically.
  await writeFile(tmp, serializeHeader(header), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
  return target;
}

/** Convenience: build metadata + header in one call from a passphrase. */
export function buildHeaderFromPassphrase(options: {
  passphrase: string;
  salt: Buffer;
  /** Optional override; defaults to scrypt with `DEFAULT_SCRYPT_PARAMS`. */
  algorithm?: "scrypt" | "argon2id";
  params?: ScryptParams | Argon2idParams;
  createdAt?: string;
  note?: string;
}): { header: SecureStoreHeader; derivedKey: Buffer } {
  const { passphrase, salt } = options;
  const algorithm = options.algorithm ?? "scrypt";
  const metadataOpts: {
    algorithm: "scrypt" | "argon2id";
    salt: Buffer;
    params?: ScryptParams | Argon2idParams;
    createdAt?: string;
    note?: string;
  } = { algorithm, salt };
  if (options.params !== undefined) metadataOpts.params = options.params;
  if (options.createdAt !== undefined) metadataOpts.createdAt = options.createdAt;
  if (options.note !== undefined) metadataOpts.note = options.note;
  const metadata = buildMetadata(metadataOpts);
  const params: ScryptParams | Argon2idParams =
    metadata.kdf.algorithm === "scrypt" ? metadata.kdf.params : metadata.kdf.params;
  const derivedKey = deriveKey(algorithm, passphrase, salt, params);
  const headerOpts: { metadata: SecureStoreMetadata; derivedKey: Buffer; createdAt?: string } = {
    metadata,
    derivedKey,
  };
  if (options.createdAt !== undefined) headerOpts.createdAt = options.createdAt;
  const header = buildHeader(headerOpts);
  return { header, derivedKey };
}
