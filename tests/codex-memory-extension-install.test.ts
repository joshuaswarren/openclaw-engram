import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import {
  installCodexMemoryExtension,
  removeCodexMemoryExtension,
  resolveCodexHome,
  resolveCodexMemoryExtensionPaths,
  installConnector,
  removeConnector,
  locatePluginCodexExtensionSource,
} from "../packages/remnic-core/src/connectors/index.js";

async function makeTempCodexHome(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "remnic-codex-ext-"));
}

async function makeTempRemnicConfigHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-config-"));
  // Redirect XDG_CONFIG_HOME so connectors registry lives in a temp dir.
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

test("resolveCodexHome honors explicit override, then $CODEX_HOME, then ~/.codex", () => {
  const prev = process.env.CODEX_HOME;
  try {
    delete process.env.CODEX_HOME;
    const home = resolveCodexHome();
    assert.ok(home.endsWith(".codex"), `expected ~/.codex fallback, got ${home}`);

    process.env.CODEX_HOME = "/tmp/custom-codex-home";
    assert.equal(resolveCodexHome(), "/tmp/custom-codex-home");

    assert.equal(resolveCodexHome("/explicit/override"), "/explicit/override");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test("resolveCodexMemoryExtensionPaths places extensions as a sibling of memories", () => {
  const paths = resolveCodexMemoryExtensionPaths("/tmp/fake-codex");
  assert.equal(paths.codexHome, "/tmp/fake-codex");
  assert.equal(paths.memoriesDir, "/tmp/fake-codex/memories");
  assert.equal(paths.extensionsRoot, "/tmp/fake-codex/memories_extensions");
  assert.equal(
    paths.remnicExtensionDir,
    "/tmp/fake-codex/memories_extensions/remnic",
  );
  // Extensions must NOT live inside the memories folder.
  assert.ok(
    !paths.extensionsRoot.startsWith(paths.memoriesDir + path.sep),
    "extensionsRoot must not be inside memoriesDir",
  );
});

test("installCodexMemoryExtension drops instructions.md at the correct sibling path", async () => {
  const codexHome = await makeTempCodexHome();
  try {
    const result = installCodexMemoryExtension({ codexHome });

    // Correct location: sibling, not inside memories/
    assert.equal(result.codexHome, codexHome);
    assert.equal(result.memoriesDir, path.join(codexHome, "memories"));
    assert.equal(
      result.extensionsRoot,
      path.join(codexHome, "memories_extensions"),
    );
    assert.equal(
      result.remnicExtensionDir,
      path.join(codexHome, "memories_extensions", "remnic"),
    );
    assert.equal(
      result.instructionsPath,
      path.join(codexHome, "memories_extensions", "remnic", "instructions.md"),
    );

    // The file exists and is non-empty.
    assert.ok(fs.existsSync(result.instructionsPath));
    const content = await readFile(result.instructionsPath, "utf8");
    assert.ok(content.length > 0);
    assert.ok(result.filesCopied >= 1);

    // Nothing placed inside memories/.
    const memoriesDir = path.join(codexHome, "memories");
    if (fs.existsSync(memoriesDir)) {
      const memEntries = fs.readdirSync(memoriesDir);
      assert.ok(
        !memEntries.some((e) => e.startsWith("remnic")),
        "no remnic folder should appear inside memories/",
      );
    }
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("installCodexMemoryExtension is idempotent — re-install overwrites remnic only", async () => {
  const codexHome = await makeTempCodexHome();
  try {
    const extRoot = path.join(codexHome, "memories_extensions");

    // Pre-create an adjacent vendor extension that MUST survive reinstall.
    const siblingDir = path.join(extRoot, "other-vendor");
    await mkdir(siblingDir, { recursive: true });
    await writeFile(path.join(siblingDir, "instructions.md"), "DO NOT TOUCH");

    installCodexMemoryExtension({ codexHome });

    // Mutate the installed remnic file and confirm reinstall replaces it.
    const remnicInstructions = path.join(extRoot, "remnic", "instructions.md");
    await writeFile(remnicInstructions, "tampered");
    installCodexMemoryExtension({ codexHome });
    const fresh = await readFile(remnicInstructions, "utf8");
    assert.notEqual(fresh, "tampered");
    assert.ok(fresh.length > 0);

    // Sibling extension must be intact.
    const sibling = await readFile(path.join(siblingDir, "instructions.md"), "utf8");
    assert.equal(sibling, "DO NOT TOUCH");

    // No leftover tmp directories.
    const leftover = fs
      .readdirSync(extRoot)
      .filter((name) => name.startsWith(".remnic.tmp-"));
    assert.deepEqual(leftover, []);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("removeCodexMemoryExtension only removes the remnic folder", async () => {
  const codexHome = await makeTempCodexHome();
  try {
    const extRoot = path.join(codexHome, "memories_extensions");

    // Install and add an unrelated sibling.
    installCodexMemoryExtension({ codexHome });
    const siblingDir = path.join(extRoot, "other-vendor");
    await mkdir(siblingDir, { recursive: true });
    await writeFile(path.join(siblingDir, "keep.md"), "keep me");

    const result = removeCodexMemoryExtension({ codexHome });
    assert.equal(result.removed, true);
    assert.ok(!fs.existsSync(path.join(extRoot, "remnic")));

    // Sibling extension must survive.
    assert.ok(fs.existsSync(path.join(siblingDir, "keep.md")));

    // Remove again is a no-op.
    const second = removeCodexMemoryExtension({ codexHome });
    assert.equal(second.removed, false);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("installConnector(codex-cli) installs the memory extension to the given codexHome", async () => {
  const codexHome = await makeTempCodexHome();
  const xdg = await makeTempRemnicConfigHome();
  try {
    const result = installConnector({
      connectorId: "codex-cli",
      config: { codexHome },
      force: true,
    });
    assert.equal(result.status, "installed");

    const instructionsPath = path.join(
      codexHome,
      "memories_extensions",
      "remnic",
      "instructions.md",
    );
    assert.ok(
      fs.existsSync(instructionsPath),
      `expected instructions at ${instructionsPath}`,
    );
    assert.match(result.message, /memory extension/);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

test("installConnector(codex-cli) with installExtension=false skips extension install", async () => {
  const codexHome = await makeTempCodexHome();
  const xdg = await makeTempRemnicConfigHome();
  try {
    const result = installConnector({
      connectorId: "codex-cli",
      config: { codexHome, installExtension: false },
      force: true,
    });
    assert.equal(result.status, "installed");

    const extPath = path.join(codexHome, "memories_extensions", "remnic");
    assert.ok(
      !fs.existsSync(extPath),
      "extension should not be installed when installExtension is false",
    );
    assert.match(result.message, /skipped/);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

test("removeConnector(codex-cli) removes only the remnic extension folder", async () => {
  const codexHome = await makeTempCodexHome();
  const xdg = await makeTempRemnicConfigHome();
  try {
    installConnector({
      connectorId: "codex-cli",
      config: { codexHome },
      force: true,
    });

    // Drop a neighbor extension.
    const extRoot = path.join(codexHome, "memories_extensions");
    const neighbor = path.join(extRoot, "some-other-extension");
    await mkdir(neighbor, { recursive: true });
    await writeFile(path.join(neighbor, "note.md"), "keep me");

    const removeResult = removeConnector("codex-cli");
    assert.match(removeResult.message, /Removed/);

    assert.ok(!fs.existsSync(path.join(extRoot, "remnic")));
    assert.ok(fs.existsSync(path.join(neighbor, "note.md")));
  } finally {
    await rm(codexHome, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
});

// ── Finding 2: resolveCodexHome always returns an absolute path ──────────────

test("resolveCodexHome returns an absolute path even when HOME and USERPROFILE are unset", () => {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  try {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    delete process.env.CODEX_HOME;
    const result = resolveCodexHome();
    assert.ok(
      path.isAbsolute(result),
      `expected an absolute path, got: ${result}`,
    );
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
    else delete process.env.CODEX_HOME;
  }
});

// ── Finding 3: bundled payload works without @remnic/plugin-codex ────────────

test("locatePluginCodexExtensionSource finds bundled payload without @remnic/plugin-codex", () => {
  // The bundled codex/ directory lives alongside the connectors source file.
  // This test verifies the primary lookup path resolves and contains instructions.md,
  // confirming installCodexMemoryExtension works in a standalone @remnic/core install.
  const sourceDir = locatePluginCodexExtensionSource(null);
  assert.ok(
    path.isAbsolute(sourceDir),
    `expected absolute path, got: ${sourceDir}`,
  );
  const instructionsPath = path.join(sourceDir, "instructions.md");
  assert.ok(
    fs.existsSync(instructionsPath),
    `expected instructions.md at ${instructionsPath}`,
  );
  const content = fs.readFileSync(instructionsPath, "utf8");
  assert.ok(content.length > 0, "instructions.md should be non-empty");
});

test("installCodexMemoryExtension works against a temp codexHome using only bundled payload", async () => {
  const codexHome = await makeTempCodexHome();
  try {
    // Pass no sourceDir — forces locatePluginCodexExtensionSource to find the
    // bundled payload (primary path) without relying on @remnic/plugin-codex.
    const result = installCodexMemoryExtension({ codexHome });
    assert.equal(result.codexHome, codexHome);
    assert.ok(fs.existsSync(result.instructionsPath));
    const content = fs.readFileSync(result.instructionsPath, "utf8");
    assert.ok(content.length > 0);
    assert.ok(result.filesCopied >= 1);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

// ── Whole-payload install: all source files/dirs reach the destination ────────

/**
 * Recursively collect all relative file paths under a directory.
 * Symlinks and non-file entries are skipped — consistent with copyDirRecursiveSync.
 */
function collectRelativeFiles(dir: string, base = dir): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRelativeFiles(full, base));
    } else if (entry.isFile()) {
      results.push(path.relative(base, full));
    }
  }
  return results.sort();
}

test("installCodexMemoryExtension copies the ENTIRE source payload — not just instructions.md", async () => {
  // Locate the bundled source so we know exactly what should be installed.
  const sourceDir = locatePluginCodexExtensionSource(null);
  const sourceFiles = collectRelativeFiles(sourceDir);

  // There must be at least one file (instructions.md) to make this test meaningful.
  assert.ok(sourceFiles.length >= 1, "source payload must have at least one file");

  const codexHome = await makeTempCodexHome();
  try {
    const result = installCodexMemoryExtension({ codexHome });
    const destFiles = collectRelativeFiles(result.remnicExtensionDir);

    assert.deepEqual(
      destFiles,
      sourceFiles,
      "installed extension must contain exactly the same files as the source payload " +
        "(recursive copy via tsup onSuccess must include all files and subdirectories)",
    );
    assert.equal(
      result.filesCopied,
      sourceFiles.length,
      "filesCopied must equal the number of files in the source payload",
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});
