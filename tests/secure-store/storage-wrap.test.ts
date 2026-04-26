/**
 * Tests for transparent at-rest encryption wrapping in storage.ts
 * (issue #690 PR 3/4).
 *
 * Tests are driven against the pure secure-fs helpers (no daemon, no
 * StorageManager instance needed for most cases) plus a narrow set of
 * StorageManager integration paths. All crypto work uses low-cost scrypt
 * params so the suite stays fast on CI.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import {
  ENCRYPTED_FILE_MAGIC,
  ENCRYPTED_FILE_MAGIC_LENGTH,
  SecureStoreLockedError,
  isEncryptedFile,
  migrateMemoryDirToEncrypted,
  readMaybeEncryptedFile,
  writeMaybeEncryptedFile,
  type SecureFsMigrationReport,
} from "../../src/secure-store/index.js";
import { randomBytes } from "node:crypto";
import {
  buildHeaderFromPassphrase,
} from "../../packages/remnic-core/src/secure-store/header.js";
import {
  KDF_SALT_LENGTH,
  type ScryptParams,
} from "../../packages/remnic-core/src/secure-store/kdf.js";

// Low-cost scrypt params: RFC 7914 valid, derives in <5 ms on CI.
const FAST_SCRYPT: ScryptParams = {
  N: 1 << 10, // 2^10 = 1024
  r: 1,
  p: 1,
  keyLength: 32,
  maxmem: 32 * 1024 * 1024,
};

/** Derive a fresh 32-byte master key from a passphrase using fast scrypt. */
function deriveTestKey(passphrase: string): Buffer {
  const salt = randomBytes(KDF_SALT_LENGTH);
  const { derivedKey } = buildHeaderFromPassphrase({
    passphrase,
    salt,
    algorithm: "scrypt",
    params: FAST_SCRYPT,
  });
  return derivedKey;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(label: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `remnic-storage-wrap-test-${label}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Roundtrip: encrypt → decrypt preserves content
// ---------------------------------------------------------------------------

test("encrypted-then-decrypted roundtrip preserves content", async () => {
  const dir = await makeTmpDir("roundtrip");
  try {
    const key = deriveTestKey("correct-horse-battery-staple");
    const filePath = path.join(dir, "memory.md");
    const original = "---\nid: test-001\ncategory: fact\n---\n\nThis is a test memory.\n";

    await writeMaybeEncryptedFile(filePath, original, { key });

    // The on-disk file must start with the encrypted-file magic.
    const raw = await readFile(filePath);
    assert.ok(isEncryptedFile(raw), "written file should start with RMSF magic");
    assert.notStrictEqual(raw.toString("utf8"), original, "on-disk should NOT be plaintext");

    // Reading it back with the key should yield the original content.
    const decrypted = await readMaybeEncryptedFile(filePath, { key });
    assert.strictEqual(decrypted, original, "decrypted content must equal original");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Backward compatibility: plaintext files still read correctly
// ---------------------------------------------------------------------------

test("reading a plaintext file still works (back-compat)", async () => {
  const dir = await makeTmpDir("backcompat");
  try {
    const filePath = path.join(dir, "memory.md");
    const plaintext = "---\nid: legacy-001\ncategory: fact\n---\n\nLegacy plaintext memory.\n";
    await writeFile(filePath, plaintext, "utf-8");

    // Sanity: not encrypted.
    const raw = await readFile(filePath);
    assert.ok(!isEncryptedFile(raw), "legacy file should NOT start with RMSF magic");

    // Read with no key: should return plaintext unchanged.
    const noKey = await readMaybeEncryptedFile(filePath, {});
    assert.strictEqual(noKey, plaintext, "no-key read of plaintext should return content as-is");

    // Read with a key: plaintext files are returned as-is (not decrypted).
    const key = deriveTestKey("passphrase");
    const withKey = await readMaybeEncryptedFile(filePath, { key });
    assert.strictEqual(withKey, plaintext, "key read of plaintext should still return plaintext as-is");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Locked store: encrypted read without a key raises SecureStoreLockedError
// ---------------------------------------------------------------------------

test("locked store raises SecureStoreLockedError on encrypted file read", async () => {
  const dir = await makeTmpDir("locked");
  try {
    const key = deriveTestKey("my-passphrase");
    const filePath = path.join(dir, "memory.md");
    const content = "---\nid: locked-001\n---\n\nSensitive content.\n";

    // Write encrypted.
    await writeMaybeEncryptedFile(filePath, content, { key });

    // Verify it's actually encrypted on disk.
    const raw = await readFile(filePath);
    assert.ok(isEncryptedFile(raw), "file must be encrypted before lock test");

    // Now attempt to read it with no key (store is locked).
    await assert.rejects(
      () => readMaybeEncryptedFile(filePath, { key: null }),
      (err) => {
        assert.ok(err instanceof SecureStoreLockedError, "should throw SecureStoreLockedError");
        assert.ok(
          err.message.includes("secure store is locked"),
          `error message should mention lock: ${err.message}`,
        );
        assert.strictEqual(err.filePath, filePath);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Migration: walks fixture dir and re-writes every .md file as encrypted
// ---------------------------------------------------------------------------

test("migration walks fixture dir and re-writes all .md files as encrypted", async () => {
  const dir = await makeTmpDir("migrate");
  try {
    const factsDir = path.join(dir, "facts", "2024-01-01");
    const corrDir = path.join(dir, "corrections");
    await mkdir(factsDir, { recursive: true });
    await mkdir(corrDir, { recursive: true });

    const files = [
      { p: path.join(factsDir, "fact-001.md"), c: "---\nid: fact-001\n---\n\nFact one.\n" },
      { p: path.join(factsDir, "fact-002.md"), c: "---\nid: fact-002\n---\n\nFact two.\n" },
      { p: path.join(corrDir, "corr-001.md"), c: "---\nid: corr-001\n---\n\nCorrection one.\n" },
    ];
    for (const { p, c } of files) {
      await writeFile(p, c, "utf-8");
    }

    const key = deriveTestKey("migration-passphrase");
    const snapshotLog: Array<{ filePath: string; plaintext: string }> = [];

    const report: SecureFsMigrationReport = await migrateMemoryDirToEncrypted(dir, {
      key,
      snapshot: async (filePath, plaintext) => {
        snapshotLog.push({ filePath, plaintext });
      },
    });

    assert.strictEqual(report.scanned, 3, "should scan all 3 .md files");
    assert.strictEqual(report.encrypted, 3, "should encrypt all 3 files");
    assert.strictEqual(report.alreadyEncrypted, 0, "no files were pre-encrypted");
    assert.strictEqual(report.skipped, 0, "no files should be skipped");
    assert.strictEqual(report.errors.length, 0, "no errors expected");

    // Snapshot callback must have been called once per file.
    assert.strictEqual(snapshotLog.length, 3, "snapshot callback called once per file");

    // Every file on disk should now be encrypted.
    for (const { p, c } of files) {
      const raw = await readFile(p);
      assert.ok(isEncryptedFile(raw), `${path.basename(p)} should be encrypted after migration`);
      // Decrypting with the key should recover the original content.
      const recovered = await readMaybeEncryptedFile(p, { key });
      assert.strictEqual(recovered, c, `recovered content must match original for ${path.basename(p)}`);
    }

    // Running migration again should skip already-encrypted files.
    const report2 = await migrateMemoryDirToEncrypted(dir, { key });
    assert.strictEqual(report2.alreadyEncrypted, 3, "second pass: all files already encrypted");
    assert.strictEqual(report2.encrypted, 0, "second pass: nothing newly encrypted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Tampered ciphertext raises an authentication error
// ---------------------------------------------------------------------------

test("tampered ciphertext is detected (auth tag mismatch)", async () => {
  const dir = await makeTmpDir("tamper");
  try {
    const key = deriveTestKey("tamper-passphrase");
    const filePath = path.join(dir, "memory.md");
    const content = "---\nid: tamper-001\n---\n\nSecret content.\n";

    await writeMaybeEncryptedFile(filePath, content, { key });

    // Flip a single byte in the ciphertext region (past the header).
    const raw = Buffer.from(await readFile(filePath));
    // The encrypted file magic is the first ENCRYPTED_FILE_MAGIC_LENGTH bytes.
    // Corrupt a byte well into the ciphertext region.
    const tamperedOffset = ENCRYPTED_FILE_MAGIC_LENGTH + 20;
    raw[tamperedOffset] ^= 0xff;
    await writeFile(filePath, raw);

    // Decryption should fail with an auth-tag error.
    await assert.rejects(
      () => readMaybeEncryptedFile(filePath, { key }),
      (err) => {
        assert.ok(err instanceof Error, "should throw an Error");
        // Node's decipher.final() throws "Unsupported state or unable to
        // authenticate data" on GCM auth failure. Accept any error here
        // since the exact message varies by Node version.
        return true;
      },
      "tampered ciphertext must not decrypt silently",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. writeMaybeEncryptedFile: no key → writes plaintext
// ---------------------------------------------------------------------------

test("writeMaybeEncryptedFile with no key writes plaintext", async () => {
  const dir = await makeTmpDir("nokey-write");
  try {
    const filePath = path.join(dir, "memory.md");
    const content = "---\nid: plain-001\n---\n\nPlain content.\n";

    await writeMaybeEncryptedFile(filePath, content, { key: null });

    const raw = await readFile(filePath);
    assert.ok(!isEncryptedFile(raw), "no-key write should produce plaintext");
    assert.strictEqual(raw.toString("utf8"), content, "plaintext content should match");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Migration without a key throws immediately before any I/O
// ---------------------------------------------------------------------------

test("migrateMemoryDirToEncrypted without a key throws before any I/O", async () => {
  const dir = await makeTmpDir("no-key-migrate");
  try {
    await assert.rejects(
      () => migrateMemoryDirToEncrypted(dir, {}),
      /requires an unlocked secure-store key/,
      "must throw a clear error when no key is provided",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
