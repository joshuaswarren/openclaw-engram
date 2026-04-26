/**
 * Key-derivation functions for the secure-store module.
 *
 * Issue #690 (PR 1/4) — pure primitives, no I/O.
 *
 * Naming note
 * -----------
 * The directory is named `secure-store/` — NOT `vault/` — because
 * `vault` is already a content-source concept in `native-knowledge.ts`
 * (Obsidian vaults: `ObsidianVaultState`, `vaultId`, `obsidianVaults`
 * config, etc.). Reusing the `vault` namespace for at-rest encryption
 * would cause symbol collisions and reader confusion.
 *
 * KDF choice — scrypt today, Argon2id tomorrow
 * ---------------------------------------------
 * Issue #690 specifies Argon2id (OWASP m=64 MiB, t=3, p=4) as the
 * preferred KDF. Argon2id is not available via Node's built-in
 * `node:crypto`; it requires a third-party native module (`argon2` or
 * `@node-rs/argon2`) that has historically broken cross-platform
 * builds in this monorepo's CI matrix.
 *
 * Per the issue's "prefer scrypt with strong params over a broken
 * Argon2id" guidance, this PR ships **scrypt** (Node built-in) with
 * strong parameters (N = 2^17, r = 8, p = 1 — RFC 7914 / OWASP
 * acceptable for 2024+). The `KdfAlgorithm` enum and metadata format
 * are designed so a future PR can add `"argon2id"` without breaking
 * existing stores: the algorithm name + params are persisted in the
 * metadata file, so old stores keep deriving with scrypt while new
 * ones can opt into Argon2id.
 *
 * Trade-off summary:
 *   - scrypt N=2^17, r=8, p=1 → ~128 MiB memory, ~150 ms on a modern
 *     laptop. Memory-hard. Resists GPU/ASIC attacks meaningfully.
 *   - Argon2id m=64 MiB, t=3, p=4 → ~64 MiB memory, similar wall
 *     time. Considered the modern best-in-class but requires native
 *     bindings.
 *
 * Both produce a 32-byte key suitable for AES-256-GCM.
 */

import { scryptSync, timingSafeEqual } from "node:crypto";

/** KDF algorithms supported by the secure-store metadata format. */
export type KdfAlgorithm = "scrypt" | "argon2id";

/** Parameters for the scrypt KDF (RFC 7914). */
export interface ScryptParams {
  /** CPU/memory cost. Must be a power of 2. Default 2^17 = 131072. */
  N: number;
  /** Block size. Default 8. */
  r: number;
  /** Parallelization. Default 1. */
  p: number;
  /** Output key length in bytes. Default 32 (AES-256). */
  keyLength: number;
  /** maxmem ceiling for scrypt; defaults to 256 MiB. */
  maxmem: number;
}

/** Parameters for the Argon2id KDF (reserved for future PR). */
export interface Argon2idParams {
  /** Memory cost in KiB. OWASP default 65536 (64 MiB). */
  memoryKiB: number;
  /** Time cost (iterations). OWASP default 3. */
  iterations: number;
  /** Parallelism. OWASP default 4. */
  parallelism: number;
  /** Output key length in bytes. Default 32 (AES-256). */
  keyLength: number;
}

/** Strong scrypt defaults (OWASP-acceptable for 2024+). */
export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({
  // 2^17. Hex-coding the literal would obscure the doubling chain.
  N: 1 << 17,
  r: 8,
  p: 1,
  keyLength: 32,
  // 256 MiB ceiling — comfortably above the 128 MiB scrypt needs at N=2^17.
  maxmem: 256 * 1024 * 1024,
});

/** OWASP Argon2id defaults — used when/if Argon2id support lands. */
export const DEFAULT_ARGON2ID_PARAMS: Readonly<Argon2idParams> = Object.freeze({
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 4,
  keyLength: 32,
});

/** Salt length in bytes. 128 bits is the modern minimum. */
export const KDF_SALT_LENGTH = 16;

/** Required derived-key length for AES-256 (32 bytes). */
export const KDF_KEY_LENGTH = 32;

/**
 * Validate that scrypt parameters are within sane bounds and that
 * `N` is a power of 2 (required by RFC 7914).
 */
export function validateScryptParams(params: ScryptParams): void {
  const { N, r, p, keyLength, maxmem } = params;
  if (!Number.isInteger(N) || N < 2) {
    throw new Error(`scrypt N must be an integer ≥ 2, got ${N}`);
  }
  // Cursor Low + codex P2: a `(N & (N - 1)) !== 0` check truncates
  // to 32-bit semantics for `N >= 2**31`, so values like `5 * 2**30`
  // would pass even though they are not powers of two, and absurdly
  // large values like `2**33` would silently lock up the KDF. Use
  // Math.log2-based detection plus an explicit upper bound at 2**30
  // (already orders of magnitude past any practical memory budget)
  // so out-of-range or non-power-of-two values are rejected loudly.
  if (N > 2 ** 30) {
    throw new Error(`scrypt N is unreasonably large (max 2^30), got ${N}`);
  }
  if (!Number.isInteger(Math.log2(N))) {
    throw new Error(`scrypt N must be a power of 2, got ${N}`);
  }
  if (!Number.isInteger(r) || r < 1) {
    throw new Error(`scrypt r must be a positive integer, got ${r}`);
  }
  if (!Number.isInteger(p) || p < 1) {
    throw new Error(`scrypt p must be a positive integer, got ${p}`);
  }
  if (!Number.isInteger(keyLength) || keyLength < 16) {
    throw new Error(
      `scrypt keyLength must be ≥ 16 (need 32 for AES-256), got ${keyLength}`,
    );
  }
  if (!Number.isInteger(maxmem) || maxmem < 1024) {
    throw new Error(`scrypt maxmem must be a sane positive integer, got ${maxmem}`);
  }
}

/**
 * Derive a key from a passphrase + salt using scrypt.
 *
 * Pure: no I/O, no global state, deterministic for a given
 * (passphrase, salt, params) tuple.
 *
 * @throws if params are invalid.
 */
export function deriveKeyScrypt(
  passphrase: string,
  salt: Uint8Array,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Buffer {
  if (typeof passphrase !== "string") {
    throw new Error("passphrase must be a string");
  }
  if (passphrase.length === 0) {
    throw new Error("passphrase must not be empty");
  }
  if (!(salt instanceof Uint8Array) || salt.length < 8) {
    throw new Error(
      `salt must be a Uint8Array of at least 8 bytes, got ${salt?.length ?? "non-buffer"}`,
    );
  }
  validateScryptParams(params);
  return scryptSync(passphrase, Buffer.from(salt), params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
}

/**
 * Algorithm-dispatching KDF. Today only `scrypt` is implemented; a
 * future PR can add `argon2id` here without breaking on-disk metadata
 * because the algorithm name is recorded in the metadata file.
 */
export function deriveKey(
  algorithm: KdfAlgorithm,
  passphrase: string,
  salt: Uint8Array,
  params: ScryptParams | Argon2idParams,
): Buffer {
  if (algorithm === "scrypt") {
    return deriveKeyScrypt(passphrase, salt, params as ScryptParams);
  }
  if (algorithm === "argon2id") {
    throw new Error(
      "argon2id KDF is reserved in the metadata format but not yet wired " +
        "in this build. Use 'scrypt' until Argon2id native support lands.",
    );
  }
  throw new Error(`unknown KDF algorithm: ${algorithm as string}`);
}

/**
 * Constant-time equality for two derived keys / MACs. Re-exported so
 * callers don't reach into `node:crypto` directly for this primitive.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
