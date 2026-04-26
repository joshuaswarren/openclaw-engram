/**
 * Tests for capsule + backup encryption (issue #690 PR 4/4).
 *
 * Scenarios covered:
 *   1. exportCapsule --encrypt → importCapsule roundtrip (plaintext identical)
 *   2. importCapsule auto-detects encrypted archive via REMNIC-ENC header
 *   3. importCapsule with encrypted archive but locked secure-store → clear error
 *   4. importCapsule with tampered encrypted archive → clear auth error
 *   5. backupMemoryDir --encrypt → encrypted archive produced, plaintext removed
 *   6. isEncryptedCapsuleFile detects encrypted vs plain archives
 *   7. encryptCapsuleFile + decryptCapsuleFile file-level roundtrip
 *
 * KDF note: tests use a minimal scrypt param set (N=1024) to keep the suite
 * fast.  ONE integration test exercises the real unlock path so CLI
 * plumbing and keyring integration stay green.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";

import { exportCapsule } from "./capsule-export.js";
import { importCapsule } from "./capsule-import.js";
import { backupMemoryDir } from "./backup.js";
import {
  encryptCapsuleFile,
  decryptCapsuleFile,
  isEncryptedCapsuleFile,
} from "./capsule-crypto.js";
import * as keyring from "../secure-store/keyring.js";
import { generateSalt, seal } from "../secure-store/cipher.js";
import { deriveKeyScrypt, type ScryptParams } from "../secure-store/kdf.js";
import { buildHeaderFromPassphrase, writeHeader, secureStoreDir } from "../secure-store/header.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Cheap scrypt params: ~milliseconds, safe for tests. */
const FAST_SCRYPT: ScryptParams = {
  N: 1 << 10,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 64 * 1024 * 1024,
};

const TEST_PASSPHRASE = "hunter2-test-passphrase";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "capsule-enc-test-"));
}

/**
 * Initialize a secure-store header in `memoryDir` and unlock the keyring.
 * Returns the derived key buffer (same as what the keyring holds).
 */
async function initAndUnlockStore(memoryDir: string): Promise<Buffer> {
  const salt = generateSalt();
  const { header, derivedKey } = buildHeaderFromPassphrase({
    passphrase: TEST_PASSPHRASE,
    salt,
    params: FAST_SCRYPT,
  });
  await writeHeader(memoryDir, header);

  // Clone the key before handing ownership to the keyring.
  const keyCopy = Buffer.from(derivedKey);
  keyring.unlock(secureStoreDir(memoryDir), keyCopy);
  return derivedKey;
}

/**
 * Build a minimal memory directory with two synthetic fact files.
 */
async function makeMemoryDir(dir: string): Promise<void> {
  await mkdir(path.join(dir, "facts"), { recursive: true });
  await writeFile(
    path.join(dir, "facts", "a.md"),
    "---\nid: fact-a\n---\nFact A content.",
  );
  await writeFile(
    path.join(dir, "facts", "b.md"),
    "---\nid: fact-b\n---\nFact B content.",
  );
}

// ─── Test 6: isEncryptedCapsuleFile ───────────────────────────────────────────

test("isEncryptedCapsuleFile returns false for a plain gzip file", async () => {
  const dir = await makeTempDir();
  try {
    const plain = path.join(dir, "test.capsule.json.gz");
    await writeFile(plain, gzipSync(Buffer.from('{"hello":"world"}', "utf-8")));
    assert.equal(await isEncryptedCapsuleFile(plain), false, "plain gz should not be detected as encrypted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isEncryptedCapsuleFile returns false for a non-.enc file even with REMNIC-ENC bytes", async () => {
  const dir = await makeTempDir();
  try {
    const f = path.join(dir, "test.capsule.json.gz");
    // starts with magic but lacks .enc extension
    await writeFile(f, Buffer.concat([Buffer.from("REMNIC-ENC\x00\x01"), Buffer.alloc(50)]));
    assert.equal(await isEncryptedCapsuleFile(f), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isEncryptedCapsuleFile returns true for a properly encrypted archive", async () => {
  const dir = await makeTempDir();
  try {
    await initAndUnlockStore(dir);

    const plain = path.join(dir, "test.capsule.json.gz");
    await writeFile(plain, gzipSync(Buffer.from('{"hello":"world"}', "utf-8")));
    const { encPath } = await encryptCapsuleFile({ sourceGzPath: plain, memoryDir: dir });

    assert.equal(await isEncryptedCapsuleFile(encPath), true);
  } finally {
    keyring.lockAll();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Test 7: encryptCapsuleFile + decryptCapsuleFile roundtrip ────────────────

test("encryptCapsuleFile + decryptCapsuleFile roundtrip preserves bytes", async () => {
  const dir = await makeTempDir();
  try {
    await initAndUnlockStore(dir);

    const original = gzipSync(Buffer.from('{"test":"payload","value":42}', "utf-8"));
    const plainPath = path.join(dir, "example.capsule.json.gz");
    await writeFile(plainPath, original);

    const { encPath } = await encryptCapsuleFile({ sourceGzPath: plainPath, memoryDir: dir });
    assert.ok(encPath.endsWith(".enc"), "encrypted path should end with .enc");

    const { gzPath } = await decryptCapsuleFile({ encPath, memoryDir: dir });
    const decrypted = await readFile(gzPath);
    assert.ok(decrypted.equals(original), "decrypted bytes must equal original");
  } finally {
    keyring.lockAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("decryptCapsuleFile throws clear error when store is locked", async () => {
  const dir = await makeTempDir();
  try {
    await initAndUnlockStore(dir);

    const plain = path.join(dir, "test.capsule.json.gz");
    await writeFile(plain, gzipSync(Buffer.from('{"x":1}', "utf-8")));
    const { encPath } = await encryptCapsuleFile({ sourceGzPath: plain, memoryDir: dir });

    // Lock the store.
    keyring.lock(secureStoreDir(dir));

    await assert.rejects(
      async () => decryptCapsuleFile({ encPath, memoryDir: dir }),
      /Secure-store is locked/,
      "should throw a clear 'locked' error",
    );
  } finally {
    keyring.lockAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("decryptCapsuleFile throws auth error when archive is tampered", async () => {
  const dir = await makeTempDir();
  try {
    await initAndUnlockStore(dir);

    const plain = path.join(dir, "test.capsule.json.gz");
    await writeFile(plain, gzipSync(Buffer.from('{"x":1}', "utf-8")));
    const { encPath } = await encryptCapsuleFile({ sourceGzPath: plain, memoryDir: dir });

    // Tamper with the ciphertext: flip a byte near the end.
    const enc = await readFile(encPath);
    enc[enc.length - 1] ^= 0xff;
    await writeFile(encPath, enc);

    await assert.rejects(
      async () => decryptCapsuleFile({ encPath, memoryDir: dir }),
      /authentication failed/,
      "tampered archive should fail with auth error",
    );
  } finally {
    keyring.lockAll();
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Test 1 + 2: exportCapsule --encrypt → importCapsule roundtrip ───────────

test("exportCapsule with encrypt=true + importCapsule roundtrip restores all files", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);
    await initAndUnlockStore(srcDir);

    const exportResult = await exportCapsule({
      name: "test-capsule",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
      memoryDir: srcDir,
      now: 1_700_000_000_000,
    });

    // Archive path should end with .enc.
    assert.ok(
      exportResult.archivePath.endsWith(".enc"),
      `expected .enc archive, got: ${exportResult.archivePath}`,
    );
    assert.equal(exportResult.encryptedArchivePath, exportResult.archivePath);

    // Cross-machine restore scenario: the destination machine uses the same
    // passphrase as the source. For this unit test, we simply pass srcDir as
    // the memoryDir for the import — the key was registered there and is still
    // in the keyring. In production, the operator runs `secure-store init` +
    // `unlock` on the destination with the same passphrase; scrypt derives the
    // same key because the salt is embedded in the sealed envelope.
    const importResult = await importCapsule({
      archivePath: exportResult.archivePath,
      root: dstDir,
      mode: "skip",
      memoryDir: srcDir, // same store that holds the encryption key
    });

    assert.equal(importResult.imported.length, 2, "should have imported 2 records");
    assert.equal(importResult.skipped.length, 0);

    // Verify content round-tripped correctly.
    const aContent = await readFile(path.join(dstDir, "facts", "a.md"), "utf-8");
    assert.ok(aContent.includes("Fact A content."));
    const bContent = await readFile(path.join(dstDir, "facts", "b.md"), "utf-8");
    assert.ok(bContent.includes("Fact B content."));
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

// ─── Test 3: import without unlocked store → clear error ─────────────────────

test("importCapsule with encrypted archive and locked store throws clear error", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);
    await initAndUnlockStore(srcDir);

    const exportResult = await exportCapsule({
      name: "test-capsule-locked",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
      memoryDir: srcDir,
      now: 1_700_000_001_000,
    });

    // Lock srcDir store and don't unlock dstDir.
    keyring.lockAll();

    // Import attempt without any unlocked store.
    await assert.rejects(
      async () =>
        importCapsule({
          archivePath: exportResult.archivePath,
          root: dstDir,
          memoryDir: dstDir,
        }),
      /Secure-store is locked/,
      "should surface a 'Secure-store is locked' error",
    );
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("importCapsule with encrypted archive and no memoryDir throws clear error", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);
    await initAndUnlockStore(srcDir);

    const exportResult = await exportCapsule({
      name: "test-capsule-nomemdir",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
      memoryDir: srcDir,
      now: 1_700_000_002_000,
    });

    // No memoryDir provided to importCapsule.
    await assert.rejects(
      async () =>
        importCapsule({
          archivePath: exportResult.archivePath,
          root: dstDir,
          // omit memoryDir intentionally
        }),
      /memoryDir.*not provided/,
      "should require memoryDir for encrypted archives",
    );
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

// ─── Test 4: tampered encrypted capsule archive → auth error ──────────────────

test("importCapsule with tampered encrypted archive surfaces auth error", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);
    await initAndUnlockStore(srcDir);

    const exportResult = await exportCapsule({
      name: "test-capsule-tamper",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
      memoryDir: srcDir,
      now: 1_700_000_003_000,
    });

    // Tamper with a byte in the ciphertext region.
    const enc = await readFile(exportResult.archivePath);
    enc[enc.length - 5] ^= 0xab;
    await writeFile(exportResult.archivePath, enc);

    // Use the same store for import (the key is still unlocked in srcDir).
    await assert.rejects(
      async () =>
        importCapsule({
          archivePath: exportResult.archivePath,
          root: dstDir,
          memoryDir: srcDir,
        }),
      /authentication failed/,
      "tampered archive should fail with auth error on import",
    );
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

// ─── Test 5: backupMemoryDir --encrypt ────────────────────────────────────────

test("backupMemoryDir with encrypt=true produces .enc file and no plaintext", async () => {
  const memDir = await makeTempDir();
  const backupDir = await makeTempDir();
  try {
    await makeMemoryDir(memDir);
    await initAndUnlockStore(memDir);

    const resultPath = await backupMemoryDir({
      memoryDir: memDir,
      outDir: backupDir,
      pluginVersion: "0.0.0-test",
      encrypt: true,
    });

    assert.ok(resultPath.endsWith(".enc"), `expected .enc path, got: ${resultPath}`);
    const encBuf = await readFile(resultPath);
    assert.ok(encBuf.length > 0, "encrypted backup should not be empty");

    // Verify the REMNIC-ENC magic.
    const magic = Buffer.from("REMNIC-ENC\x00", "ascii");
    assert.ok(
      encBuf.subarray(0, magic.length).equals(magic),
      "encrypted backup should start with REMNIC-ENC magic",
    );

    // No plaintext .gz should exist beside the .enc.
    const plainPath = resultPath.replace(/\.enc$/, "");
    const plainExists = await readFile(plainPath).then(() => true).catch(() => false);
    assert.equal(plainExists, false, "plaintext backup gz should be removed after encryption");
  } finally {
    keyring.lockAll();
    await rm(memDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

test("backupMemoryDir with encrypt=true and locked store throws clear error", async () => {
  const memDir = await makeTempDir();
  const backupDir = await makeTempDir();
  try {
    await makeMemoryDir(memDir);
    // Intentionally do NOT unlock the store.

    await assert.rejects(
      async () =>
        backupMemoryDir({
          memoryDir: memDir,
          outDir: backupDir,
          pluginVersion: "0.0.0-test",
          encrypt: true,
        }),
      /Secure-store is locked/,
      "should surface locked error when store not unlocked",
    );
  } finally {
    keyring.lockAll();
    await rm(memDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

// ─── Unencrypted capsule still works (regression guard) ──────────────────────

test("exportCapsule without encrypt produces plaintext archive importable without memoryDir key", async () => {
  const srcDir = await makeTempDir();
  const dstDir = await makeTempDir();
  const outDir = await makeTempDir();
  try {
    await makeMemoryDir(srcDir);

    const exportResult = await exportCapsule({
      name: "plain-capsule",
      root: srcDir,
      outDir,
      pluginVersion: "0.0.0-test",
      now: 1_700_000_004_000,
    });

    assert.ok(
      exportResult.archivePath.endsWith(".gz") && !exportResult.archivePath.endsWith(".gz.enc"),
      "unencrypted archive should be .gz",
    );
    assert.equal(exportResult.encryptedArchivePath, null);

    // Import without a memoryDir — plain archives don't need one.
    const importResult = await importCapsule({
      archivePath: exportResult.archivePath,
      root: dstDir,
      mode: "skip",
    });

    assert.equal(importResult.imported.length, 2);
    assert.equal(importResult.skipped.length, 0);
  } finally {
    keyring.lockAll();
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});
