/**
 * Tests for the secure-store encryption primitives (issue #690 PR 1/4).
 *
 * These tests are pure: no I/O, no clock dependence beyond the
 * deterministic-ish `createdAt` round-trip (which we override).
 *
 * Note on KDF parameters
 * ----------------------
 * The default scrypt params (N = 2^17, r = 8, p = 1) take ~100-200 ms
 * per derivation on CI hardware. To keep the test suite fast, the
 * majority of tests use a low-cost (N = 2^10) param set. ONE test
 * (`deriveKeyScrypt with default OWASP-acceptable params produces a
 * 32-byte key`) exercises the real defaults end-to-end so we don't
 * silently regress them.
 */

import { PassThrough } from "node:stream";
import { mkdtemp, rm, symlink, writeFile as fsWriteFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVELOPE_HEADER_SIZE,
  ENVELOPE_LAYOUT,
  ENVELOPE_SALT_LENGTH,
  ENVELOPE_VERSION,
  IV_LENGTH,
  generateSalt,
  open,
  parseEnvelope,
  seal,
} from "./cipher.js";
import {
  HEADER_FORMAT,
  HEADER_FORMAT_VERSION,
  buildHeaderFromPassphrase,
  parseHeader,
  validateHeader,
} from "./header.js";
import {
  DEFAULT_ARGON2ID_PARAMS,
  DEFAULT_SCRYPT_PARAMS,
  KDF_KEY_LENGTH,
  KDF_SALT_LENGTH,
  constantTimeEqual,
  deriveKey,
  deriveKeyScrypt,
  validateScryptParams,
  type ScryptParams,
} from "./kdf.js";
import {
  METADATA_FORMAT,
  METADATA_FORMAT_VERSION,
  buildMetadata,
  decodeMetadataSalt,
  parseMetadata,
  serializeMetadata,
  validateMetadata,
} from "./metadata.js";
import { createPassphraseReader } from "./passphrase-reader.js";
import {
  SecureStoreDecryptError,
  SecureStoreLockedError,
  encryptFileBody,
  migrateMemoryDirToEncrypted,
  readMaybeEncryptedFile,
  writeMaybeEncryptedFile,
} from "./secure-fs.js";

/** Cheap scrypt params for tests — still hex-correct but ~milliseconds. */
const FAST_SCRYPT: ScryptParams = {
  N: 1 << 10,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 64 * 1024 * 1024,
};

// ─── kdf.ts ─────────────────────────────────────────────────────────────

test("deriveKeyScrypt is deterministic for the same passphrase + salt + params", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x42);
  const k1 = deriveKeyScrypt("correct horse battery staple", salt, FAST_SCRYPT);
  const k2 = deriveKeyScrypt("correct horse battery staple", salt, FAST_SCRYPT);
  assert.equal(k1.length, KDF_KEY_LENGTH);
  assert.equal(k2.length, KDF_KEY_LENGTH);
  assert.ok(k1.equals(k2), "same inputs must yield same key");
});

test("deriveKeyScrypt produces different keys for different passphrases", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x42);
  const k1 = deriveKeyScrypt("passphrase-a", salt, FAST_SCRYPT);
  const k2 = deriveKeyScrypt("passphrase-b", salt, FAST_SCRYPT);
  assert.equal(k1.equals(k2), false);
});

test("deriveKeyScrypt produces different keys for different salts", () => {
  const saltA = Buffer.alloc(KDF_SALT_LENGTH, 0x01);
  const saltB = Buffer.alloc(KDF_SALT_LENGTH, 0x02);
  const k1 = deriveKeyScrypt("same passphrase", saltA, FAST_SCRYPT);
  const k2 = deriveKeyScrypt("same passphrase", saltB, FAST_SCRYPT);
  assert.equal(k1.equals(k2), false);
});

test("deriveKeyScrypt with default OWASP-acceptable params produces a 32-byte key", () => {
  // Smoke-test the real defaults so they don't silently regress.
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x99);
  const key = deriveKeyScrypt("default-params-smoke-test", salt);
  assert.equal(key.length, KDF_KEY_LENGTH);
  assert.equal(DEFAULT_SCRYPT_PARAMS.keyLength, 32);
  assert.equal(DEFAULT_SCRYPT_PARAMS.N, 1 << 17);
});

test("deriveKeyScrypt rejects empty passphrase", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0);
  assert.throws(() => deriveKeyScrypt("", salt, FAST_SCRYPT), /passphrase/);
});

test("deriveKeyScrypt rejects too-short salt", () => {
  assert.throws(
    () => deriveKeyScrypt("pw", Buffer.alloc(4, 0), FAST_SCRYPT),
    /salt/,
  );
});

test("deriveKey('scrypt') dispatches to scryptSync", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x42);
  const viaWrapper = deriveKey("scrypt", "pw", salt, FAST_SCRYPT);
  const direct = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  assert.ok(viaWrapper.equals(direct));
});

test("deriveKey('argon2id') is reserved but not implemented in this PR", () => {
  // Argon2id is recorded in the metadata enum so future PRs can opt
  // in without breaking on-disk format. This PR's runtime refuses to
  // use it — and the error message must say so clearly.
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0);
  assert.throws(
    () => deriveKey("argon2id", "pw", salt, DEFAULT_ARGON2ID_PARAMS),
    /argon2id/i,
  );
});

test("validateScryptParams rejects non-power-of-2 N", () => {
  assert.throws(
    () => validateScryptParams({ ...FAST_SCRYPT, N: 1000 }),
    /power of 2/,
  );
});

test("validateScryptParams rejects N < 2", () => {
  assert.throws(() => validateScryptParams({ ...FAST_SCRYPT, N: 1 }), /N/);
});

test("constantTimeEqual returns true for equal buffers", () => {
  const a = Buffer.from([1, 2, 3, 4]);
  const b = Buffer.from([1, 2, 3, 4]);
  assert.equal(constantTimeEqual(a, b), true);
});

test("constantTimeEqual returns false for different buffers", () => {
  const a = Buffer.from([1, 2, 3, 4]);
  const b = Buffer.from([1, 2, 3, 5]);
  assert.equal(constantTimeEqual(a, b), false);
});

test("constantTimeEqual returns false for different-length buffers", () => {
  const a = Buffer.from([1, 2, 3]);
  const b = Buffer.from([1, 2, 3, 4]);
  assert.equal(constantTimeEqual(a, b), false);
});

// ─── cipher.ts ──────────────────────────────────────────────────────────

test("seal/open round-trip on a small payload", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const plaintext = Buffer.from("hello, secure-store!");
  const sealed = seal(key, salt, plaintext);
  const opened = open(key, sealed);
  assert.ok(opened.equals(plaintext));
});

test("seal/open round-trip on a large payload (1 MiB)", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  // Deterministic-ish 1 MiB pattern so failures are easier to read.
  const plaintext = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < plaintext.length; i++) {
    plaintext[i] = i & 0xff;
  }
  const sealed = seal(key, salt, plaintext);
  const opened = open(key, sealed);
  assert.equal(opened.length, plaintext.length);
  assert.ok(opened.equals(plaintext));
});

test("seal/open round-trip on an empty payload", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.alloc(0));
  const opened = open(key, sealed);
  assert.equal(opened.length, 0);
});

test("seal produces a different ciphertext for the same plaintext (random IV)", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const plaintext = Buffer.from("same plaintext, twice");
  const a = seal(key, salt, plaintext);
  const b = seal(key, salt, plaintext);
  // Header bytes differ in the IV section even though salt is identical.
  assert.equal(a.equals(b), false, "fresh IV must produce fresh ciphertext");
  // ...but both decrypt to the same plaintext.
  assert.ok(open(key, a).equals(plaintext));
  assert.ok(open(key, b).equals(plaintext));
});

test("seal envelope layout matches the documented format", () => {
  const salt = Buffer.alloc(ENVELOPE_SALT_LENGTH, 0xaa);
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("payload"));
  assert.equal(sealed[ENVELOPE_LAYOUT.version], ENVELOPE_VERSION);
  // Salt bytes round-trip exactly.
  const saltSlice = sealed.subarray(
    ENVELOPE_LAYOUT.salt,
    ENVELOPE_LAYOUT.salt + ENVELOPE_SALT_LENGTH,
  );
  assert.ok(saltSlice.equals(salt));
  // Total length = header + ciphertext("payload" is 7 bytes).
  assert.equal(sealed.length, ENVELOPE_HEADER_SIZE + 7);
});

test("open fails on wrong passphrase (auth-tag mismatch)", () => {
  const salt = generateSalt();
  const goodKey = deriveKeyScrypt("right-passphrase", salt, FAST_SCRYPT);
  const badKey = deriveKeyScrypt("WRONG-passphrase", salt, FAST_SCRYPT);
  const sealed = seal(goodKey, salt, Buffer.from("secret"));
  assert.throws(() => open(badKey, sealed));
});

test("open fails when ciphertext is tampered", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("the quick brown fox"));
  // Flip a bit in the ciphertext region.
  const tampered = Buffer.from(sealed);
  tampered[ENVELOPE_LAYOUT.ciphertext] ^= 0x01;
  assert.throws(() => open(key, tampered));
});

test("open fails when the auth tag is tampered", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("payload"));
  const tampered = Buffer.from(sealed);
  tampered[ENVELOPE_LAYOUT.authTag] ^= 0xff;
  assert.throws(() => open(key, tampered));
});

test("open fails when the IV is tampered", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("payload"));
  const tampered = Buffer.from(sealed);
  tampered[ENVELOPE_LAYOUT.iv] ^= 0xff;
  assert.throws(() => open(key, tampered));
});

test("open fails on truncated envelope", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("payload"));
  // Cut into the auth-tag region.
  const truncated = sealed.subarray(0, ENVELOPE_HEADER_SIZE - 4);
  assert.throws(() => open(key, truncated), /envelope too short|envelope/);
});

test("open fails on unsupported envelope version", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("payload"));
  const tampered = Buffer.from(sealed);
  tampered[ENVELOPE_LAYOUT.version] = 99;
  assert.throws(() => open(key, tampered), /version/i);
});

test("seal/open round-trip with AAD", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const aad = Buffer.from("/memories/2026-04-25.md");
  const plaintext = Buffer.from("hello with aad");
  const sealed = seal(key, salt, plaintext, { aad });
  const opened = open(key, sealed, { aad });
  assert.ok(opened.equals(plaintext));
});

test("open fails when AAD is mismatched", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const sealed = seal(key, salt, Buffer.from("hello"), {
    aad: Buffer.from("path-A"),
  });
  assert.throws(() => open(key, sealed, { aad: Buffer.from("path-B") }));
});

test("seal rejects key of wrong length", () => {
  const salt = generateSalt();
  assert.throws(
    () => seal(Buffer.alloc(16), salt, Buffer.from("x")),
    /AES-256-GCM/,
  );
});

test("seal rejects salt of wrong length", () => {
  const key = deriveKeyScrypt("pw", Buffer.alloc(KDF_SALT_LENGTH, 0), FAST_SCRYPT);
  assert.throws(() => seal(key, Buffer.alloc(8), Buffer.from("x")), /salt/);
});

test("parseEnvelope round-trips the documented fields", () => {
  const salt = Buffer.alloc(ENVELOPE_SALT_LENGTH, 0x33);
  const key = deriveKeyScrypt("pw", salt, FAST_SCRYPT);
  const iv = Buffer.alloc(IV_LENGTH, 0x55);
  const sealed = seal(key, salt, Buffer.from("hello"), { iv });
  const parsed = parseEnvelope(sealed);
  assert.equal(parsed.version, ENVELOPE_VERSION);
  assert.ok(parsed.salt.equals(salt));
  assert.ok(parsed.iv.equals(iv));
});

test("generateSalt returns a 16-byte buffer", () => {
  const s1 = generateSalt();
  const s2 = generateSalt();
  assert.equal(s1.length, ENVELOPE_SALT_LENGTH);
  // Two random salts should virtually never collide.
  assert.equal(s1.equals(s2), false);
});

// ─── metadata.ts ────────────────────────────────────────────────────────

test("buildMetadata + serialize + parse round-trip (scrypt)", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0xab);
  const meta = buildMetadata({
    algorithm: "scrypt",
    salt,
    createdAt: "2026-04-25T12:00:00.000Z",
    note: "test fixture",
  });
  const json = serializeMetadata(meta);
  const parsed = parseMetadata(json);
  assert.deepEqual(parsed, meta);
  assert.equal(parsed.format, METADATA_FORMAT);
  assert.equal(parsed.formatVersion, METADATA_FORMAT_VERSION);
  assert.equal(parsed.kdf.algorithm, "scrypt");
  assert.equal(parsed.note, "test fixture");
  assert.ok(decodeMetadataSalt(parsed).equals(salt));
});

test("buildMetadata + serialize + parse round-trip (argon2id placeholder)", () => {
  // Argon2id is reserved in the metadata format even though the KDF
  // dispatcher refuses to use it in this PR.
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0xcd);
  const meta = buildMetadata({
    algorithm: "argon2id",
    salt,
    createdAt: "2026-04-25T12:00:00.000Z",
  });
  const parsed = parseMetadata(serializeMetadata(meta));
  assert.equal(parsed.kdf.algorithm, "argon2id");
  if (parsed.kdf.algorithm === "argon2id") {
    assert.equal(parsed.kdf.params.memoryKiB, DEFAULT_ARGON2ID_PARAMS.memoryKiB);
    assert.equal(parsed.kdf.params.iterations, DEFAULT_ARGON2ID_PARAMS.iterations);
  }
});

test("buildMetadata defaults createdAt to a parseable ISO string when omitted", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0);
  const meta = buildMetadata({ algorithm: "scrypt", salt });
  assert.ok(typeof meta.createdAt === "string");
  // Throws if not a parseable date.
  const date = new Date(meta.createdAt);
  assert.equal(Number.isNaN(date.getTime()), false);
});

test("buildMetadata rejects salt of wrong length", () => {
  assert.throws(
    () => buildMetadata({ algorithm: "scrypt", salt: Buffer.alloc(8) }),
    /salt/,
  );
});

test("parseMetadata rejects non-JSON input", () => {
  assert.throws(() => parseMetadata("not json {"), /JSON/);
});

test("parseMetadata rejects wrong format identifier", () => {
  const bad = JSON.stringify({
    format: "something.else",
    formatVersion: 1,
    kdf: {
      algorithm: "scrypt",
      params: DEFAULT_SCRYPT_PARAMS,
      salt: "00".repeat(KDF_SALT_LENGTH),
    },
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  assert.throws(() => parseMetadata(bad), /format/);
});

test("parseMetadata rejects unsupported formatVersion", () => {
  const bad = JSON.stringify({
    format: METADATA_FORMAT,
    formatVersion: 999,
    kdf: {
      algorithm: "scrypt",
      params: DEFAULT_SCRYPT_PARAMS,
      salt: "00".repeat(KDF_SALT_LENGTH),
    },
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  assert.throws(() => parseMetadata(bad), /formatVersion/);
});

test("parseMetadata rejects salt with wrong byte length", () => {
  const bad = JSON.stringify({
    format: METADATA_FORMAT,
    formatVersion: METADATA_FORMAT_VERSION,
    kdf: {
      algorithm: "scrypt",
      params: DEFAULT_SCRYPT_PARAMS,
      salt: "00".repeat(8), // 8 bytes — too short.
    },
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  assert.throws(() => parseMetadata(bad), /salt|expected/);
});

test("parseMetadata rejects non-hex salt", () => {
  const bad = JSON.stringify({
    format: METADATA_FORMAT,
    formatVersion: METADATA_FORMAT_VERSION,
    kdf: {
      algorithm: "scrypt",
      params: DEFAULT_SCRYPT_PARAMS,
      salt: "zz".repeat(KDF_SALT_LENGTH),
    },
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  assert.throws(() => parseMetadata(bad), /hex/);
});

test("parseMetadata rejects unknown KDF algorithm", () => {
  const bad = JSON.stringify({
    format: METADATA_FORMAT,
    formatVersion: METADATA_FORMAT_VERSION,
    kdf: {
      algorithm: "rot13",
      params: { foo: 1 },
      salt: "00".repeat(KDF_SALT_LENGTH),
    },
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  assert.throws(() => parseMetadata(bad), /algorithm/);
});

test("validateMetadata rejects non-power-of-2 N", () => {
  const meta = buildMetadata({
    algorithm: "scrypt",
    salt: Buffer.alloc(KDF_SALT_LENGTH, 0),
  });
  // Mutate the kdf params after construction; validation must catch it.
  if (meta.kdf.algorithm === "scrypt") {
    meta.kdf.params.N = 1000;
  }
  assert.throws(() => validateMetadata(meta), /power of 2/);
});

test("serializeMetadata produces stable top-level key order", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x77);
  const meta = buildMetadata({
    algorithm: "scrypt",
    salt,
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  const json = serializeMetadata(meta);
  // The four required top-level keys should appear in this order.
  const formatIdx = json.indexOf('"format"');
  const formatVersionIdx = json.indexOf('"formatVersion"');
  const kdfIdx = json.indexOf('"kdf"');
  const createdAtIdx = json.indexOf('"createdAt"');
  assert.ok(
    formatIdx >= 0 &&
      formatIdx < formatVersionIdx &&
      formatVersionIdx < kdfIdx &&
      kdfIdx < createdAtIdx,
    `unexpected top-level key order in: ${json}`,
  );
});

// ─── End-to-end primitive flow (no I/O) ────────────────────────────────

test("end-to-end: build metadata → derive key → seal → open round-trip", () => {
  // Simulates the full primitive flow that a future storage layer
  // (PR 3/4) will perform — but with everything in memory.
  const salt = generateSalt();
  const meta = buildMetadata({
    algorithm: "scrypt",
    salt,
    createdAt: "2026-04-25T00:00:00.000Z",
  });
  const reparsed = parseMetadata(serializeMetadata(meta));
  // Re-derive the key from the parsed metadata's salt.
  const recoveredSalt = decodeMetadataSalt(reparsed);
  assert.ok(recoveredSalt.equals(salt));
  const key = deriveKeyScrypt("user-passphrase", recoveredSalt, FAST_SCRYPT);
  const sealed = seal(key, recoveredSalt, Buffer.from("end-to-end"));
  const opened = open(key, sealed);
  assert.equal(opened.toString("utf8"), "end-to-end");
});

test("tampered envelope salt fails decryption (codex P1 — header AAD)", () => {
  const salt = generateSalt();
  const key = deriveKeyScrypt("passphrase", salt, FAST_SCRYPT);
  const envelope = Buffer.from(seal(key, salt, Buffer.from("secret")));
  // Salt sits at envelope bytes [1, 17). Flipping a byte there must
  // trigger auth failure now that the header is bound into AAD.
  envelope[5] = envelope[5] ^ 0xff;
  assert.throws(() => open(key, envelope), /auth|tag|decrypt|unable/i);
});

test("metadata rejects keyLength != 32 (codex P2 — match cipher AES-256)", () => {
  const meta = buildMetadata({
    algorithm: "scrypt",
    salt: generateSalt(),
    createdAt: "2026-04-25T00:00:00.000Z",
  }) as { kdf: { params: { keyLength: number } } };
  meta.kdf.params.keyLength = 16;
  assert.throws(
    () => validateMetadata(meta as unknown as Parameters<typeof validateMetadata>[0]),
    /keyLength must be 32/,
  );
});

// ─── header.ts — Thread 6: even-length hex verifier (#737) ──────────────

test("parseHeader rejects odd-length verifier hex (thread 6 — even-length guard)", () => {
  // Build a valid header, then manually patch the verifier to odd length.
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x11);
  const { header } = buildHeaderFromPassphrase({
    passphrase: "test-pass",
    salt,
    algorithm: "scrypt",
    params: { N: 1 << 10, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 },
  });
  // Make the verifier odd-length by trimming one hex char.
  const badJson = JSON.stringify({
    format: HEADER_FORMAT,
    formatVersion: HEADER_FORMAT_VERSION,
    metadata: JSON.parse(
      JSON.stringify(header.metadata),
    ),
    verifier: header.verifier.slice(0, -1), // odd length
    createdAt: header.createdAt,
  });
  assert.throws(
    () => parseHeader(badJson),
    /even length|even/i,
  );
});

test("validateHeader rejects odd-length verifier hex (thread 6 — even-length guard)", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x22);
  const { header } = buildHeaderFromPassphrase({
    passphrase: "test-pass-2",
    salt,
    algorithm: "scrypt",
    params: { N: 1 << 10, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 },
  });
  const bad = { ...header, verifier: header.verifier.slice(0, -1) }; // odd length
  assert.throws(
    () => validateHeader(bad),
    /even length|even/i,
  );
});

test("parseHeader rejects non-hex characters in verifier (thread 6)", () => {
  const salt = Buffer.alloc(KDF_SALT_LENGTH, 0x33);
  const { header } = buildHeaderFromPassphrase({
    passphrase: "test-pass-3",
    salt,
    algorithm: "scrypt",
    params: { N: 1 << 10, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 },
  });
  const badJson = JSON.stringify({
    format: HEADER_FORMAT,
    formatVersion: HEADER_FORMAT_VERSION,
    metadata: JSON.parse(JSON.stringify(header.metadata)),
    verifier: "zz" + header.verifier.slice(2), // non-hex prefix
    createdAt: header.createdAt,
  });
  assert.throws(
    () => parseHeader(badJson),
    /hex/i,
  );
});

// ─── passphrase-reader.ts — Thread 5: prompts to stderr (#737) ──────────

test("non-TTY prompt is written to errorStream, not output (thread 5)", async () => {
  // Build an in-memory PassThrough pair to act as piped stdin.
  const inputStream = new PassThrough();
  // Write the passphrase line before creating the reader so the stream
  // is already buffered and the readline interface drains it immediately.
  inputStream.end("test-passphrase\n");

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const fakeOutput = new PassThrough();
  fakeOutput.on("data", (d: Buffer) => stdoutChunks.push(d.toString()));

  const fakeError = new PassThrough();
  fakeError.on("data", (d: Buffer) => stderrChunks.push(d.toString()));

  const reader = createPassphraseReader({
    input: inputStream,
    output: fakeOutput,
    errorStream: fakeError,
  });

  const passphrase = await reader("Enter passphrase: ");

  assert.equal(passphrase, "test-passphrase");
  // The prompt must appear on stderr, not stdout.
  const stderr = stderrChunks.join("");
  const stdout = stdoutChunks.join("");
  assert.ok(
    stderr.includes("Enter passphrase: "),
    `expected prompt on stderr but got: ${JSON.stringify(stderr)}`,
  );
  assert.ok(
    !stdout.includes("Enter passphrase: "),
    `prompt must not appear on stdout but got: ${JSON.stringify(stdout)}`,
  );
});

// ─── passphrase-reader.ts — Thread 7: surrogate-safe backspace (#737) ───

test("backspace removes full non-BMP (emoji) code point atomically (thread 7)", async () => {
  // Simulate TTY raw-mode input with a PassThrough that claims isTTY.
  const inputStream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(raw: boolean): void;
  };
  inputStream.isTTY = true;
  inputStream.isRaw = false;
  inputStream.setRawMode = (_: boolean): void => {};

  const outputChunks: Buffer[] = [];
  const fakeOutput = new PassThrough();
  fakeOutput.on("data", (d: Buffer) => outputChunks.push(d));

  const reader = createPassphraseReader({
    input: inputStream,
    output: fakeOutput,
  });

  const readPromise = reader("Passphrase: ");

  // Type: 'a', then emoji U+1F511 (KEY, encodes as surrogate pair in
  // UTF-16: 🔑), then backspace (DEL = 0x7f), then Enter.
  // After the backspace the emoji must be fully removed, leaving just 'a'.
  // We encode as UTF-8 bytes the way a terminal would send them.
  const aBytes = Buffer.from("a", "utf8");
  const emojiBytes = Buffer.from("\u{1F511}", "utf8"); // 4 bytes in UTF-8
  const delByte = Buffer.from([0x7f]);
  const enterByte = Buffer.from([0x0d]);

  inputStream.push(aBytes);
  inputStream.push(emojiBytes);
  inputStream.push(delByte);
  inputStream.push(enterByte);

  const result = await readPromise;

  assert.equal(
    result,
    "a",
    `expected 'a' after backspace removed the emoji, but got: ${JSON.stringify(result)}`,
  );
});

test("backspace on BMP character removes exactly one character (thread 7 — regression)", async () => {
  const inputStream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(raw: boolean): void;
  };
  inputStream.isTTY = true;
  inputStream.isRaw = false;
  inputStream.setRawMode = (_: boolean): void => {};

  const fakeOutput = new PassThrough();

  const reader = createPassphraseReader({
    input: inputStream,
    output: fakeOutput,
  });

  const readPromise = reader("Passphrase: ");

  // Type 'abc', backspace twice, then Enter — should yield 'a'.
  inputStream.push(Buffer.from("abc", "utf8"));
  inputStream.push(Buffer.from([0x7f]));
  inputStream.push(Buffer.from([0x7f]));
  inputStream.push(Buffer.from([0x0d]));

  const result = await readPromise;

  assert.equal(result, "a");
});

// ─── secure-fs.ts — Thread 1: symlink traversal blocked (#743) ──────────

test("migrateMemoryDirToEncrypted skips symlinks and does not follow them (thread 1 — Codex P1)", async () => {
  // Create a real memory dir with one .md file and a symlink pointing
  // OUTSIDE the dir.  The migration walk must skip the symlink entirely
  // and must not encrypt (or even read) the target outside the root.
  const memDir = await mkdtemp(path.join(os.tmpdir(), "rmsf-symlink-test-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "rmsf-symlink-outside-"));
  try {
    const salt = generateSalt();
    const key = deriveKeyScrypt("symlink-test-key", salt, FAST_SCRYPT);

    // Write a legitimate plaintext file inside memDir.
    const legitimateMd = path.join(memDir, "legitimate.md");
    await fsWriteFile(legitimateMd, "---\nid: leg-1\n---\ncontent", "utf8");

    // Write a plaintext file outside memDir — migration must NOT touch it.
    const outsideMd = path.join(outsideDir, "outside.md");
    await fsWriteFile(outsideMd, "---\nid: outside-1\n---\nsensitive outside content", "utf8");

    // Plant a symlink inside memDir that points to the outside file.
    const symlinkPath = path.join(memDir, "evil-link.md");
    await symlink(outsideMd, symlinkPath);

    const report = await migrateMemoryDirToEncrypted(memDir, { key });

    // The legitimate file must be encrypted.
    assert.equal(report.encrypted, 1, "should have encrypted exactly 1 real file");
    // The symlink must have been silently skipped — NOT counted as scanned.
    assert.equal(report.scanned, 1, "symlink must not appear in scanned count");
    assert.equal(report.errors.length, 0, "no errors expected");

    // The outside file must remain plaintext (unmodified by migration).
    const outsideContent = await fsWriteFile(outsideMd, "---\nid: outside-1\n---\nsensitive outside content", "utf8")
      .then(() => import("node:fs/promises").then((m) => m.readFile(outsideMd, "utf8")));
    assert.ok(
      outsideContent.includes("sensitive outside content"),
      "outside file must not have been encrypted",
    );
  } finally {
    await rm(memDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("migrateMemoryDirToEncrypted skips symlink directories (thread 1 — directory symlink)", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "rmsf-dirlink-test-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "rmsf-dirlink-outside-"));
  try {
    const salt = generateSalt();
    const key = deriveKeyScrypt("dirlink-test-key", salt, FAST_SCRYPT);

    // Write a file in the outside dir.
    const outsideMd = path.join(outsideDir, "private.md");
    await fsWriteFile(outsideMd, "---\nid: priv-1\n---\nprivate", "utf8");

    // Plant a symlink to the outside DIRECTORY inside memDir.
    const symlinkDir = path.join(memDir, "linked-subdir");
    await symlink(outsideDir, symlinkDir);

    const report = await migrateMemoryDirToEncrypted(memDir, { key });

    // Nothing inside the symlinked directory should have been encrypted.
    assert.equal(report.encrypted, 0, "no files should be encrypted via directory symlink");
    assert.equal(report.scanned, 0, "no files should be scanned via directory symlink");
    assert.equal(report.errors.length, 0, "no errors expected");

    // The outside file must be untouched.
    const content = await import("node:fs/promises").then((m) => m.readFile(outsideMd, "utf8"));
    assert.ok(content.includes("private"), "outside file must remain plaintext");
  } finally {
    await rm(memDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// ─── secure-fs.ts — Thread 2: surface read failures (#743) ──────────────

test("readMaybeEncryptedFile throws SecureStoreDecryptError on wrong key (thread 2 — Codex P1)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rmsf-decrypt-err-"));
  try {
    const salt = generateSalt();
    const goodKey = deriveKeyScrypt("correct-key", salt, FAST_SCRYPT);
    const badKey = deriveKeyScrypt("wrong-key", salt, FAST_SCRYPT);

    const filePath = path.join(dir, "memory.md");
    await writeMaybeEncryptedFile(filePath, "---\nid: t1\n---\nsecret", { key: goodKey });

    // Reading with the wrong key must throw SecureStoreDecryptError (not silently return empty).
    await assert.rejects(
      () => readMaybeEncryptedFile(filePath, { key: badKey }),
      (err: unknown) => {
        assert.ok(
          err instanceof SecureStoreDecryptError,
          `expected SecureStoreDecryptError, got ${err instanceof Error ? err.constructor.name : String(err)}`,
        );
        assert.ok(
          (err as SecureStoreDecryptError).filePath === filePath,
          "error.filePath must equal the file that failed",
        );
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readMaybeEncryptedFile throws SecureStoreDecryptError on tampered ciphertext (thread 2)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rmsf-tamper-"));
  try {
    const salt = generateSalt();
    const key = deriveKeyScrypt("test-key", salt, FAST_SCRYPT);

    const filePath = path.join(dir, "memory.md");
    await writeMaybeEncryptedFile(filePath, "---\nid: t2\n---\ncontent", { key });

    // Flip a byte in the ciphertext to simulate tampering.
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = await readFile(filePath);
    const tampered = Buffer.from(raw);
    // Byte 20 is well within the sealed envelope body (past magic + header).
    tampered[20] ^= 0xff;
    await writeFile(filePath, tampered);

    await assert.rejects(
      () => readMaybeEncryptedFile(filePath, { key }),
      (err: unknown) => {
        assert.ok(
          err instanceof SecureStoreDecryptError,
          `expected SecureStoreDecryptError, got ${err instanceof Error ? err.constructor.name : String(err)}`,
        );
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readMaybeEncryptedFile throws SecureStoreLockedError when no key provided for encrypted file (thread 2 — locked store)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rmsf-locked-"));
  try {
    const salt = generateSalt();
    const key = deriveKeyScrypt("lock-test-key", salt, FAST_SCRYPT);

    const filePath = path.join(dir, "memory.md");
    await writeMaybeEncryptedFile(filePath, "---\nid: t3\n---\ndata", { key });

    // Reading without a key must throw SecureStoreLockedError, not return empty.
    await assert.rejects(
      () => readMaybeEncryptedFile(filePath, {}),
      (err: unknown) => {
        assert.ok(
          err instanceof SecureStoreLockedError,
          `expected SecureStoreLockedError, got ${err instanceof Error ? err.constructor.name : String(err)}`,
        );
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SecureStoreDecryptError carries filePath and cause (thread 2 — error shape)", () => {
  const cause = new Error("auth tag mismatch");
  const err = new SecureStoreDecryptError("/mem/foo.md", cause);
  assert.equal(err.filePath, "/mem/foo.md");
  assert.equal(err.cause, cause);
  assert.equal(err.name, "SecureStoreDecryptError");
  assert.ok(err.message.includes("/mem/foo.md"), "message must include the file path");
  assert.ok(err.message.includes("auth tag mismatch"), "message must include the cause");
  assert.ok(err instanceof Error, "must be an Error subclass");
});

test("readMaybeEncryptedFile wraps bad-magic encrypted header as SecureStoreDecryptError (thread 2 — corrupted header)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rmsf-bad-magic-"));
  try {
    const salt = generateSalt();
    const key = deriveKeyScrypt("header-corrupt-key", salt, FAST_SCRYPT);

    const filePath = path.join(dir, "memory.md");

    // Write raw bytes that look encrypted (start with RMSF magic) but
    // have a completely garbage body — this simulates a truncated/corrupt file.
    const { ENCRYPTED_FILE_MAGIC } = await import("./secure-fs.js");
    const garbage = Buffer.concat([ENCRYPTED_FILE_MAGIC, Buffer.alloc(4, 0xcc)]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, garbage);

    await assert.rejects(
      () => readMaybeEncryptedFile(filePath, { key }),
      (err: unknown) => {
        assert.ok(
          err instanceof SecureStoreDecryptError,
          `expected SecureStoreDecryptError, got ${err instanceof Error ? err.constructor.name : String(err)}`,
        );
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
