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
