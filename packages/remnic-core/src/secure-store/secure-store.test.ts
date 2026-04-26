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
