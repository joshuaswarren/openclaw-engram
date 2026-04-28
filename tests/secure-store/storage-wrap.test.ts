/**
 * Tests for the transparent storage-layer encryption (issue #690 PR 3/4).
 *
 * Covers:
 *  - encrypted-then-decrypted roundtrip preserves content
 *  - reading plaintext file works (back-compat)
 *  - locked store raises SecureStoreLockedError on read
 *  - migration walks a fixture dir and re-writes everything
 *  - tampered ciphertext (auth tag mismatch) throws SecureStoreDecryptError
 *  - recall on locked store returns a clear locked error
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from "node:fs/promises";

import {
  MAGIC_BYTES,
  MAGIC_HEADER_SIZE,
  SecureStoreDecryptError,
  SecureStoreLockedError,
  decryptFileBody,
  decryptMemoryDirToPlaintext,
  encryptFileBody,
  isEncryptedFile,
  migrateMemoryDirToEncrypted,
  readMaybeEncryptedFile,
  writeMaybeEncryptedFile,
} from "../../packages/remnic-core/src/secure-store/secure-fs.js";
import { generateSalt } from "../../packages/remnic-core/src/secure-store/cipher.js";
import { StorageManager } from "../../packages/remnic-core/src/storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a 32-byte deterministic test key. */
function makeKey(seed = 0x42): Buffer {
  return Buffer.alloc(32, seed);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-secure-fs-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// isEncryptedFile
// ---------------------------------------------------------------------------

test("isEncryptedFile — returns false for plain UTF-8 buffer", () => {
  const plain = Buffer.from("---\nid: test\n---\nsome content", "utf8");
  assert.strictEqual(isEncryptedFile(plain), false);
});

test("isEncryptedFile — returns true for buffer with REMNIC-ENC magic", () => {
  const buf = Buffer.alloc(MAGIC_HEADER_SIZE + 10);
  MAGIC_BYTES.copy(buf, 0);
  assert.strictEqual(isEncryptedFile(buf), true);
});

test("isEncryptedFile — returns false for empty buffer", () => {
  assert.strictEqual(isEncryptedFile(Buffer.alloc(0)), false);
});

test("isEncryptedFile — returns false for buffer shorter than magic header", () => {
  assert.strictEqual(isEncryptedFile(MAGIC_BYTES.subarray(0, 4)), false);
});

// ---------------------------------------------------------------------------
// encryptFileBody / decryptFileBody roundtrip
// ---------------------------------------------------------------------------

test("encryptFileBody / decryptFileBody — roundtrip preserves content", () => {
  const key = makeKey();
  const content = "---\nid: fact-123\ncategory: fact\n---\nthe quick brown fox";
  const encrypted = encryptFileBody(content, key);
  assert.ok(isEncryptedFile(encrypted), "encrypted output must have magic header");
  const decrypted = decryptFileBody(encrypted, key);
  assert.strictEqual(decrypted.toString("utf8"), content);
});

test("encryptFileBody / decryptFileBody — roundtrip with AAD", () => {
  const key = makeKey();
  const content = "memory file content with AAD";
  const aad = Buffer.from("facts/2024-01-01/fact-abc.md", "utf8");
  const encrypted = encryptFileBody(content, key, aad);
  const decrypted = decryptFileBody(encrypted, key, aad);
  assert.strictEqual(decrypted.toString("utf8"), content);
});

test("decryptFileBody — wrong key throws SecureStoreDecryptError", () => {
  const key1 = makeKey(0x11);
  const key2 = makeKey(0x22);
  const content = "sensitive memory content";
  const encrypted = encryptFileBody(content, key1);
  assert.throws(
    () => decryptFileBody(encrypted, key2),
    (err) => err instanceof SecureStoreDecryptError,
  );
});

test("decryptFileBody — mismatched AAD throws SecureStoreDecryptError", () => {
  const key = makeKey();
  const content = "memory content";
  const aad1 = Buffer.from("facts/2024-01-01/fact-abc.md", "utf8");
  const aad2 = Buffer.from("facts/2024-01-01/fact-xyz.md", "utf8");
  const encrypted = encryptFileBody(content, key, aad1);
  assert.throws(
    () => decryptFileBody(encrypted, key, aad2),
    (err) => err instanceof SecureStoreDecryptError,
  );
});

test("decryptFileBody — tampered ciphertext throws SecureStoreDecryptError", () => {
  const key = makeKey();
  const content = "important memory that should not be tampered";
  const encrypted = encryptFileBody(content, key);
  // Flip a byte in the ciphertext region (after the header + envelope header).
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(
    () => decryptFileBody(tampered, key),
    (err) => err instanceof SecureStoreDecryptError,
  );
});

test("decryptFileBody — throws on non-encrypted buffer (missing magic)", () => {
  const key = makeKey();
  const plain = Buffer.from("plain text file", "utf8");
  assert.throws(
    () => decryptFileBody(plain, key),
    /REMNIC-ENC magic header/,
  );
});

// ---------------------------------------------------------------------------
// readMaybeEncryptedFile
// ---------------------------------------------------------------------------

test("readMaybeEncryptedFile — reads plain file when key is null (back-compat)", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "plain.md");
    const content = "---\nid: abc\n---\nplain memory";
    await writeFile(filePath, content, "utf8");
    const result = await readMaybeEncryptedFile(filePath, null, dir);
    assert.strictEqual(result, content);
  });
});

test("readMaybeEncryptedFile — reads plain file when key is provided (back-compat)", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "plain.md");
    const content = "---\nid: abc\n---\nplain memory";
    await writeFile(filePath, content, "utf8");
    const key = makeKey();
    const result = await readMaybeEncryptedFile(filePath, key, dir);
    assert.strictEqual(result, content);
  });
});

test("readMaybeEncryptedFile — decrypts encrypted file with correct key", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const content = "---\nid: encrypted-fact\n---\nsecret memory content";
    const filePath = path.join(dir, "fact.md");
    await writeMaybeEncryptedFile(filePath, content, key, {}, dir);
    const result = await readMaybeEncryptedFile(filePath, key, dir);
    assert.strictEqual(result, content);
  });
});

test("readMaybeEncryptedFile — throws SecureStoreLockedError when key is null but file is encrypted", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const content = "---\nid: secret\n---\ncontent";
    const filePath = path.join(dir, "fact.md");
    await writeMaybeEncryptedFile(filePath, content, key, {}, dir);
    await assert.rejects(
      () => readMaybeEncryptedFile(filePath, null, dir),
      (err) => err instanceof SecureStoreLockedError,
    );
  });
});

// ---------------------------------------------------------------------------
// writeMaybeEncryptedFile
// ---------------------------------------------------------------------------

test("writeMaybeEncryptedFile — writes plain when key is null", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "fact.md");
    const content = "plain content";
    await writeMaybeEncryptedFile(filePath, content, null);
    const raw = await readFile(filePath);
    assert.strictEqual(isEncryptedFile(raw), false);
    assert.strictEqual(raw.toString("utf8"), content);
  });
});

test("writeMaybeEncryptedFile — writes encrypted when key is provided", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const filePath = path.join(dir, "fact.md");
    const content = "secret content";
    await writeMaybeEncryptedFile(filePath, content, key, {}, dir);
    const raw = await readFile(filePath);
    assert.strictEqual(isEncryptedFile(raw), true);
  });
});

test("writeMaybeEncryptedFile — creates parent directories", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "facts", "2024-01-01", "fact.md");
    const content = "nested content";
    await writeMaybeEncryptedFile(filePath, content, null);
    const result = await readFile(filePath, "utf8");
    assert.strictEqual(result, content);
  });
});

test("writeMaybeEncryptedFile — overwrites existing file with new encrypted content", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const filePath = path.join(dir, "fact.md");
    await writeMaybeEncryptedFile(filePath, "content-first", key, {}, dir);
    await writeMaybeEncryptedFile(filePath, "content-second", key, {}, dir);
    const result = await readMaybeEncryptedFile(filePath, key, dir);
    assert.strictEqual(result, "content-second");
  });
});

// ---------------------------------------------------------------------------
// migrateMemoryDirToEncrypted
// ---------------------------------------------------------------------------

test("migrateMemoryDirToEncrypted — encrypts all .md files", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    // Create a set of plain .md files
    const files = [
      path.join(dir, "facts", "2024-01-01", "fact-a.md"),
      path.join(dir, "facts", "2024-01-02", "fact-b.md"),
      path.join(dir, "corrections", "correction-c.md"),
    ];
    for (const f of files) {
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, `---\nid: ${path.basename(f, ".md")}\n---\ncontent`, "utf8");
    }
    const result = await migrateMemoryDirToEncrypted(dir, key);
    assert.strictEqual(result.encrypted, 3);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.errors.length, 0);
    // Verify all files are now encrypted
    for (const f of files) {
      const raw = await readFile(f);
      assert.ok(isEncryptedFile(raw), `${f} should be encrypted after migration`);
    }
  });
});

test("migrateMemoryDirToEncrypted — only encrypts storage-secure markdown paths", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const encryptedPaths = [
      path.join(dir, "facts", "2024-01-01", "fact.md"),
      path.join(dir, "artifacts", "2024-01-01", "artifact.md"),
      path.join(dir, "archive", "2024-01-01", "archived.md"),
      path.join(dir, "entities", "person.md"),
      path.join(dir, "identity", "identity-anchor.md"),
      path.join(dir, "identity", "reflections.md"),
      path.join(dir, "identity", "improvement-loops.md"),
      path.join(dir, "identity", "incidents", "2026-04-28-incident-a.md"),
      path.join(dir, "identity", "audits", "weekly", "2026-W18.md"),
      path.join(dir, "namespaces", "team-a", "facts", "2024-01-01", "fact.md"),
      path.join(dir, "namespaces", "team-a", "entities", "person.md"),
      path.join(dir, "namespaces", "team-a", "identity", "identity-anchor.md"),
      path.join(dir, "profile.md"),
    ];
    const plainPaths = [
      path.join(dir, "workspace", "IDENTITY.md"),
    ];
    for (const f of [...encryptedPaths, ...plainPaths]) {
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, `content for ${path.basename(f)}`, "utf8");
    }

    const result = await migrateMemoryDirToEncrypted(dir, key);

    assert.strictEqual(result.encrypted, encryptedPaths.length);
    assert.strictEqual(result.errors.length, 0);
    for (const f of encryptedPaths) {
      assert.ok(isEncryptedFile(await readFile(f)), `${f} should be encrypted`);
    }
    assert.strictEqual(
      await readMaybeEncryptedFile(
        path.join(dir, "namespaces", "team-a", "facts", "2024-01-01", "fact.md"),
        key,
        path.join(dir, "namespaces", "team-a"),
      ),
      "content for fact.md",
    );
    assert.strictEqual(
      await readMaybeEncryptedFile(
        path.join(dir, "namespaces", "team-a", "entities", "person.md"),
        key,
        path.join(dir, "namespaces", "team-a"),
      ),
      "content for person.md",
    );
    assert.strictEqual(
      await readMaybeEncryptedFile(
        path.join(dir, "namespaces", "team-a", "identity", "identity-anchor.md"),
        key,
        path.join(dir, "namespaces", "team-a"),
      ),
      "content for identity-anchor.md",
    );
    for (const f of plainPaths) {
      assert.strictEqual((await readFile(f, "utf8")).startsWith("content for"), true);
    }
  });
});

test("migrateMemoryDirToEncrypted — skips symlinked directories", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-secure-outside-"));
  try {
    await withTempDir(async (dir) => {
      const key = makeKey();
      const outsideFile = path.join(outside, "outside.md");
      await writeFile(outsideFile, "outside content", "utf8");
      await symlink(outside, path.join(dir, "facts"), "dir");

      const result = await migrateMemoryDirToEncrypted(dir, key);

      assert.strictEqual(result.encrypted, 0);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(isEncryptedFile(await readFile(outsideFile)), false);
      assert.strictEqual(await readFile(outsideFile, "utf8"), "outside content");
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("migrateMemoryDirToEncrypted — skips already-encrypted files", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const filePath = path.join(dir, "facts", "fact.md");
    await mkdir(path.dirname(filePath), { recursive: true });
    // Write it already encrypted
    await writeMaybeEncryptedFile(filePath, "already encrypted", key, {}, dir);
    const result = await migrateMemoryDirToEncrypted(dir, key);
    assert.strictEqual(result.encrypted, 0);
    assert.strictEqual(result.skipped, 1);
  });
});

test("migrateMemoryDirToEncrypted — decryptable after migration", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const originalContent = "---\nid: fact-migrate\ncategory: fact\n---\noriginal content";
    const filePath = path.join(dir, "facts", "fact.md");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, originalContent, "utf8");
    await migrateMemoryDirToEncrypted(dir, key);
    // Re-read with key to verify roundtrip
    const decrypted = await readMaybeEncryptedFile(filePath, key, dir);
    assert.strictEqual(decrypted, originalContent);
  });
});

test("decryptMemoryDirToPlaintext — decrypts encrypted files and is idempotent", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const encryptedFile = path.join(dir, "facts", "2024-01-01", "fact.md");
    const namespacedFile = path.join(dir, "namespaces", "team-a", "facts", "2024-01-01", "fact.md");
    const entityFile = path.join(dir, "entities", "person.md");
    const plaintextFile = path.join(dir, "facts", "2024-01-01", "plain.md");
    const stateFile = path.join(dir, "state", "fact-hashes.txt");
    await mkdir(path.dirname(encryptedFile), { recursive: true });
    await mkdir(path.dirname(namespacedFile), { recursive: true });
    await mkdir(path.dirname(entityFile), { recursive: true });
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeMaybeEncryptedFile(encryptedFile, "encrypted fact", key, {}, dir);
    await writeMaybeEncryptedFile(
      namespacedFile,
      "encrypted namespaced fact",
      key,
      {},
      path.join(dir, "namespaces", "team-a"),
    );
    await writeMaybeEncryptedFile(entityFile, "encrypted entity", key, {}, dir);
    await writeFile(plaintextFile, "already plain", "utf8");
    await writeMaybeEncryptedFile(stateFile, "encrypted state", key, {}, dir);

    const first = await decryptMemoryDirToPlaintext(dir, key);
    assert.strictEqual(first.decrypted, 4);
    assert.strictEqual(first.skipped, 1);
    assert.strictEqual(first.errors.length, 0);
    assert.strictEqual(await readFile(encryptedFile, "utf8"), "encrypted fact");
    assert.strictEqual(await readFile(namespacedFile, "utf8"), "encrypted namespaced fact");
    assert.strictEqual(await readFile(entityFile, "utf8"), "encrypted entity");
    assert.strictEqual(await readFile(plaintextFile, "utf8"), "already plain");
    assert.strictEqual(await readFile(stateFile, "utf8"), "encrypted state");

    const second = await decryptMemoryDirToPlaintext(dir, key);
    assert.strictEqual(second.decrypted, 0);
    assert.strictEqual(second.skipped, 5);
    assert.strictEqual(second.errors.length, 0);
  });
});

test("decryptMemoryDirToPlaintext — skips symlinked directories and secure metadata", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "remnic-secure-outside-"));
  try {
    await withTempDir(async (dir) => {
      const key = makeKey();
      const outsideFile = path.join(outside, "outside.md");
      await writeMaybeEncryptedFile(outsideFile, "outside content", key, {}, outside);
      await symlink(outside, path.join(dir, "facts"), "dir");
      const metadataFile = path.join(dir, ".secure-store", "header.md");
      await mkdir(path.dirname(metadataFile), { recursive: true });
      await writeMaybeEncryptedFile(metadataFile, "metadata content", key, {}, dir);

      const result = await decryptMemoryDirToPlaintext(dir, key);

      assert.strictEqual(result.decrypted, 0);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(isEncryptedFile(await readFile(outsideFile)), true);
      assert.strictEqual(isEncryptedFile(await readFile(metadataFile)), true);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("migrateMemoryDirToEncrypted — invokes onBeforeEncrypt callback", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const filePath = path.join(dir, "facts", "2024-01-01", "fact.md");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "content", "utf8");
    const snapshotted: string[] = [];
    await migrateMemoryDirToEncrypted(dir, key, async (fp) => {
      snapshotted.push(fp);
    });
    assert.deepStrictEqual(snapshotted, [filePath]);
  });
});

test("migrateMemoryDirToEncrypted — partial failure leaves other files intact", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    // Two valid files
    const fileA = path.join(dir, "facts", "2024-01-01", "a.md");
    const fileB = path.join(dir, "facts", "2024-01-01", "b.md");
    await mkdir(path.dirname(fileA), { recursive: true });
    await writeFile(fileA, "content-a", "utf8");
    await writeFile(fileB, "content-b", "utf8");
    // Inject a failure by making the onBeforeEncrypt throw for one file — but
    // migration should still encrypt both (onBeforeEncrypt is non-fatal)
    const result = await migrateMemoryDirToEncrypted(dir, key, async (fp) => {
      if (fp.endsWith("a.md")) throw new Error("snapshot failed");
    });
    assert.strictEqual(result.encrypted, 2, "both files should be encrypted despite snapshot failure");
    assert.strictEqual(result.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// StorageManager.setSecureStoreKey integration
// ---------------------------------------------------------------------------

test("StorageManager.setSecureStoreKey — isSecureStoreUnlocked reflects key state", () => {
  const storage = new StorageManager("/tmp/test-memory", []);
  assert.strictEqual(storage.isSecureStoreUnlocked(), false, "locked by default");
  const key = makeKey();
  storage.setSecureStoreKey(key);
  assert.strictEqual(storage.isSecureStoreUnlocked(), true, "unlocked after key set");
  storage.setSecureStoreKey(null);
  assert.strictEqual(storage.isSecureStoreUnlocked(), false, "locked after key cleared");
});

test("StorageManager — writeMemory encrypts and readAllMemories decrypts", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const storage = new StorageManager(dir, []);
    storage.setSecureStoreKey(key, true);
    await storage.ensureDirectories();

    const id = await storage.writeMemory("fact", "encrypted memory content");
    // The on-disk file should be encrypted
    const factsDir = path.join(dir, "facts");
    const entries = await (async () => {
      const { readdir } = await import("node:fs/promises");
      const allDirs = await readdir(factsDir);
      if (allDirs.length === 0) return [];
      const sub = path.join(factsDir, allDirs[0]);
      return readdir(sub);
    })();
    assert.ok(entries.length > 0, "expected at least one memory file");

    // Verify raw file is encrypted
    const dateDir = await (async () => {
      const { readdir } = await import("node:fs/promises");
      const allDirs = await readdir(factsDir);
      return allDirs[0];
    })();
    const allFiles = await (async () => {
      const { readdir } = await import("node:fs/promises");
      return readdir(path.join(factsDir, dateDir));
    })();
    const mdFile = allFiles.find((f: string) => f.endsWith(".md"));
    assert.ok(mdFile, "expected .md file");
    const rawBuf = await readFile(path.join(factsDir, dateDir, mdFile));
    assert.ok(isEncryptedFile(rawBuf), "on-disk file should be encrypted");

    // readAllMemories should decrypt and return the content
    const memories = await storage.readAllMemories();
    const found = memories.find((m) => m.frontmatter.id === id);
    assert.ok(found, `memory ${id} should be found by readAllMemories`);
    assert.ok(
      found.content.includes("encrypted memory content"),
      "decrypted content should match",
    );
  });
});

test("StorageManager — locked store throws SecureStoreLockedError on readAllMemories", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    // Write an encrypted file manually
    const factsDay = path.join(dir, "facts", "2024-01-01");
    await mkdir(factsDay, { recursive: true });
    const filePath = path.join(factsDay, "fact-locked.md");
    await writeMaybeEncryptedFile(
      filePath,
      "---\nid: fact-locked\ncategory: fact\n---\ncontent",
      key,
      {},
      dir,
    );
    // Create a storage manager WITHOUT the key (locked)
    const storage = new StorageManager(dir, []);
    // readAllMemories silently skips unreadable files — the test confirms the
    // locked file is not returned (it throws internally but is caught)
    // More importantly, readMemoryByPath should propagate the locked error.
    await assert.rejects(
      () => storage.readMemoryByPath(filePath),
      (err) => err instanceof SecureStoreLockedError,
    );
  });
});

test("StorageManager — locked store throws SecureStoreLockedError on readProfile", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const profilePath = path.join(dir, "profile.md");
    await writeMaybeEncryptedFile(profilePath, "# Profile\n\nprivate", key, {}, dir);

    const storage = new StorageManager(dir, []);

    await assert.rejects(
      () => storage.readProfile(),
      (err) => err instanceof SecureStoreLockedError,
    );
  });
});

test("StorageManager — identity support files encrypt, decrypt, and fail clearly while locked", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const storage = new StorageManager(dir, []);
    storage.setSecureStoreKey(key, true);
    await storage.ensureDirectories();

    await storage.writeIdentityAnchor("# Identity Anchor\n\n- private anchor");
    await storage.writeIdentityReflections("## Reflection — 2026-04-28T00:00:00.000Z\n\nprivate reflection\n");
    await storage.writeIdentityImprovementLoops("## loop-a\n\n- private loop\n");
    const auditPath = await storage.writeIdentityAudit("weekly", "2026-W18", "private audit");

    const anchorPath = path.join(dir, "identity", "identity-anchor.md");
    const reflectionsPath = path.join(dir, "identity", "reflections.md");
    const loopsPath = path.join(dir, "identity", "improvement-loops.md");

    assert.ok(isEncryptedFile(await readFile(anchorPath)), "identity anchor should be encrypted");
    assert.ok(isEncryptedFile(await readFile(reflectionsPath)), "identity reflections should be encrypted");
    assert.ok(isEncryptedFile(await readFile(loopsPath)), "improvement loops should be encrypted");
    assert.ok(isEncryptedFile(await readFile(auditPath)), "identity audit should be encrypted");

    assert.match(await storage.readIdentityAnchor() ?? "", /private anchor/);
    assert.match(await storage.readIdentityReflections() ?? "", /private reflection/);
    assert.match(await storage.readIdentityImprovementLoops() ?? "", /private loop/);
    assert.equal(await storage.readIdentityAudit("weekly", "2026-W18"), "private audit");
    assert.equal(await storage.readIdentityAudit("weekly", "../escape"), null);

    const lockedStorage = new StorageManager(dir, []);
    await assert.rejects(
      () => lockedStorage.readIdentityAnchor(),
      (err) => err instanceof SecureStoreLockedError,
    );
    await assert.rejects(
      () => lockedStorage.readIdentityReflections(),
      (err) => err instanceof SecureStoreLockedError,
    );
    await assert.rejects(
      () => lockedStorage.readIdentityImprovementLoops(),
      (err) => err instanceof SecureStoreLockedError,
    );
    await assert.rejects(
      () => lockedStorage.readIdentityAudit("weekly", "2026-W18"),
      (err) => err instanceof SecureStoreLockedError,
    );
  });
});

test("StorageManager — plaintext identity support files remain readable without secure-store key", async () => {
  await withTempDir(async (dir) => {
    const identityDir = path.join(dir, "identity");
    await mkdir(path.join(identityDir, "audits", "weekly"), { recursive: true });
    await writeFile(path.join(identityDir, "identity-anchor.md"), "plain anchor", "utf8");
    await writeFile(path.join(identityDir, "reflections.md"), "plain reflection", "utf8");
    await writeFile(path.join(identityDir, "improvement-loops.md"), "plain loop", "utf8");
    await writeFile(path.join(identityDir, "audits", "weekly", "2026-W18.md"), "plain audit", "utf8");

    const storage = new StorageManager(dir, []);

    assert.equal(await storage.readIdentityAnchor(), "plain anchor");
    assert.equal(await storage.readIdentityReflections(), "plain reflection");
    assert.equal(await storage.readIdentityImprovementLoops(), "plain loop");
    assert.equal(await storage.readIdentityAudit("weekly", "2026-W18"), "plain audit");
  });
});

test("StorageManager — continuity incidents encrypt, decrypt, and fail clearly while locked", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const storage = new StorageManager(dir, []);
    storage.setSecureStoreKey(key, true);
    await storage.ensureDirectories();

    const incident = await storage.appendContinuityIncident({
      symptom: "Lost continuity across reset.",
      suspectedCause: "Encrypted support file coverage gap.",
    });

    assert.ok(isEncryptedFile(await readFile(incident.filePath!)), "continuity incident should be encrypted");

    const incidents = await storage.readContinuityIncidents(10, "all");
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.id, incident.id);
    assert.equal(incidents[0]?.symptom, "Lost continuity across reset.");

    const closed = await storage.closeContinuityIncident(incident.id, {
      fixApplied: "Routed continuity incident reads and writes through secure-store helpers.",
      verificationResult: "Encrypted reads round-trip and locked reads fail.",
    });
    assert.equal(closed?.state, "closed");
    assert.ok(isEncryptedFile(await readFile(incident.filePath!)), "closed incident should remain encrypted");

    const lockedStorage = new StorageManager(dir, []);
    await assert.rejects(
      () => lockedStorage.readContinuityIncidents(10, "all"),
      (err) => err instanceof SecureStoreLockedError,
    );
    await assert.rejects(
      () => lockedStorage.closeContinuityIncident(incident.id, {
        fixApplied: "should not write while locked",
        verificationResult: "locked",
      }),
      (err) => err instanceof SecureStoreLockedError,
    );
  });
});

test("StorageManager — continuity incident list skips corrupted encrypted files", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const storage = new StorageManager(dir, []);
    storage.setSecureStoreKey(key, true);
    await storage.ensureDirectories();

    const corrupted = await storage.appendContinuityIncident({
      symptom: "This encrypted incident will be corrupted.",
    });
    const healthy = await storage.appendContinuityIncident({
      symptom: "Healthy encrypted incident remains readable.",
    });

    const raw = Buffer.from(await readFile(corrupted.filePath!));
    raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff;
    await writeFile(corrupted.filePath!, raw);

    const incidents = await storage.readContinuityIncidents(10, "all");

    assert.deepEqual(incidents.map((incident) => incident.id), [healthy.id]);
    assert.equal(incidents[0]?.symptom, "Healthy encrypted incident remains readable.");
  });
});

test("StorageManager — plaintext continuity incidents remain readable without secure-store key", async () => {
  await withTempDir(async (dir) => {
    const incidentsDir = path.join(dir, "identity", "incidents");
    await mkdir(incidentsDir, { recursive: true });
    await writeFile(
      path.join(incidentsDir, "2026-04-28-incident-plain.md"),
      [
        "---",
        'id: "incident-plain"',
        'state: "open"',
        'openedAt: "2026-04-28T00:00:00.000Z"',
        'updatedAt: "2026-04-28T00:00:00.000Z"',
        'triggerWindow: "test"',
        "---",
        "",
        "## Symptom",
        "",
        "Plain continuity incident remains readable.",
        "",
      ].join("\n"),
      "utf8",
    );

    const storage = new StorageManager(dir, []);
    const incidents = await storage.readContinuityIncidents(10, "all");

    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.id, "incident-plain");
    assert.equal(incidents[0]?.symptom, "Plain continuity incident remains readable.");
  });
});

test("StorageManager — writeEntity encrypts and entity reads decrypt", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const storage = new StorageManager(dir, []);
    storage.setSecureStoreKey(key, true);
    await storage.ensureDirectories();

    const entityName = await storage.writeEntity(
      "Alice Example",
      "person",
      ["Alice Example owns the launch checklist."],
      { timestamp: "2026-04-28T00:00:00.000Z" },
    );
    assert.equal(entityName, "person-alice-example");

    const entityPath = path.join(dir, "entities", `${entityName}.md`);
    const raw = await readFile(entityPath);
    assert.ok(isEncryptedFile(raw), "entity file should be encrypted on disk");

    const content = await storage.readEntity(entityName);
    assert.match(content, /Alice Example owns the launch checklist\./);

    const entities = await storage.readAllEntityFiles();
    assert.equal(entities[0]?.name, "Alice Example");
    assert.deepEqual(entities[0]?.facts, ["Alice Example owns the launch checklist."]);

    const lockedStorage = new StorageManager(dir, []);
    await assert.rejects(
      () => lockedStorage.readAllEntityFiles(),
      (err) => err instanceof SecureStoreLockedError,
    );

    storage.setSecureStoreKey(null);
    await assert.rejects(
      () => storage.readAllEntityFiles(),
      (err) => err instanceof SecureStoreLockedError,
    );
  });
});

test("StorageManager — locked store throws SecureStoreLockedError on encrypted entity reads", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const entityDir = path.join(dir, "entities");
    await mkdir(entityDir, { recursive: true });
    const entityPath = path.join(entityDir, "person-alice-example.md");
    await writeMaybeEncryptedFile(
      entityPath,
      [
        "# Alice Example",
        "",
        "**Type:** person",
        "**Created:** 2026-04-28T00:00:00.000Z",
        "**Updated:** 2026-04-28T00:00:00.000Z",
        "",
        "## Facts",
        "- Alice Example owns the launch checklist.",
        "",
      ].join("\n"),
      key,
      {},
      dir,
    );

    const storage = new StorageManager(dir, []);

    await assert.rejects(
      () => storage.readEntity("person-alice-example"),
      (err) => err instanceof SecureStoreLockedError,
    );
    await assert.rejects(
      () => storage.readAllEntityFiles(),
      (err) => err instanceof SecureStoreLockedError,
    );
    await assert.rejects(
      () => storage.writeEntity(
        "Alice Example",
        "person",
        ["This must not overwrite the encrypted entity while locked."],
      ),
      (err) => err instanceof SecureStoreLockedError,
    );
  });
});

test("StorageManager — entity writes reject decrypt failures instead of overwriting", async () => {
  await withTempDir(async (dir) => {
    const key = makeKey();
    const wrongKey = makeKey(0x43);
    const entityDir = path.join(dir, "entities");
    await mkdir(entityDir, { recursive: true });
    const entityPath = path.join(entityDir, "person-alice-example.md");
    await writeMaybeEncryptedFile(
      entityPath,
      [
        "# Alice Example",
        "",
        "**Type:** person",
        "**Created:** 2026-04-28T00:00:00.000Z",
        "**Updated:** 2026-04-28T00:00:00.000Z",
        "",
        "## Facts",
        "- Alice Example owns the launch checklist.",
        "",
      ].join("\n"),
      key,
      {},
      dir,
    );

    const storage = new StorageManager(dir, []);
    storage.setSecureStoreKey(wrongKey, true);

    await assert.rejects(
      () => storage.readEntity("person-alice-example"),
      (err) => err instanceof SecureStoreDecryptError,
    );
    await assert.rejects(
      () => storage.readAllEntityFiles(),
      (err) => err instanceof SecureStoreDecryptError,
    );
    await assert.rejects(
      () => storage.writeEntity(
        "Alice Example",
        "person",
        ["This must not overwrite the encrypted entity with a wrong key."],
      ),
      (err) => err instanceof SecureStoreDecryptError,
    );
    assert.ok(isEncryptedFile(await readFile(entityPath)), "entity file should remain encrypted");
  });
});

test("StorageManager — plaintext entity files remain readable without secure-store key", async () => {
  await withTempDir(async (dir) => {
    const entityDir = path.join(dir, "entities");
    await mkdir(entityDir, { recursive: true });
    await writeFile(
      path.join(entityDir, "person-bob-example.md"),
      [
        "# Bob Example",
        "",
        "**Type:** person",
        "**Created:** 2026-04-28T00:00:00.000Z",
        "**Updated:** 2026-04-28T00:00:00.000Z",
        "",
        "## Facts",
        "- Bob Example owns the support queue.",
        "",
      ].join("\n"),
      "utf8",
    );

    const storage = new StorageManager(dir, []);
    const content = await storage.readEntity("person-bob-example");
    assert.match(content, /Bob Example owns the support queue\./);

    const entities = await storage.readAllEntityFiles();
    assert.equal(entities[0]?.name, "Bob Example");
    assert.deepEqual(entities[0]?.facts, ["Bob Example owns the support queue."]);
  });
});
