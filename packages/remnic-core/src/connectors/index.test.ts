import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installCodexMemoryExtension,
  installConnector,
  removeConnector,
  resolveCodexMemoryExtensionPaths,
} from "./index.js";

/**
 * Build a fresh tmp sandbox with its own HOME / XDG_CONFIG_HOME / CODEX_HOME
 * and optionally a synthetic plugin-codex extension source directory.
 *
 * Callers must run the test body inside {@link withEnv} or similar to ensure
 * env vars are restored afterwards. The returned paths live under `os.tmpdir()`
 * and are registered for cleanup via `t.after`.
 */
function makeSandbox(t: { after: (fn: () => void | Promise<void>) => void }): {
  root: string;
  home: string;
  xdgConfigHome: string;
  codexHome: string;
  syntheticSourceDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-connectors-test-"));
  const home = path.join(root, "home");
  const xdgConfigHome = path.join(home, ".config");
  const codexHome = path.join(root, "codex-home");
  const syntheticSourceDir = path.join(root, "synthetic-extension-source");

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdgConfigHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(syntheticSourceDir, { recursive: true });
  // Drop a synthetic instructions.md so copy has something to move
  fs.writeFileSync(
    path.join(syntheticSourceDir, "instructions.md"),
    "# synthetic test extension\n",
  );

  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  return { root, home, xdgConfigHome, codexHome, syntheticSourceDir };
}

/** Run `fn` with temporary env overrides, restoring originals after. */
async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(originals)) {
      const value = originals[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("installConnector persists resolved codexHome from $CODEX_HOME", async (t) => {
  const sandbox = makeSandbox(t);

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      CODEX_HOME: sandbox.codexHome,
    },
    () => {
      const result = installConnector({
        connectorId: "codex-cli",
        // installExtension: false avoids needing a real plugin-codex source dir
        config: { installExtension: false },
      });

      assert.equal(result.status, "installed");
      assert.ok(result.configPath, "configPath should be set");

      const savedRaw = fs.readFileSync(result.configPath as string, "utf8");
      const saved = JSON.parse(savedRaw) as Record<string, unknown>;
      // The resolved absolute $CODEX_HOME must be persisted into the saved
      // config, NOT left unset.
      assert.equal(
        saved.codexHome,
        sandbox.codexHome,
        "installConnector must persist the resolved $CODEX_HOME into saved config",
      );
    },
  );
});

test(
  "removeConnector targets persisted codexHome even when $CODEX_HOME is cleared",
  async (t) => {
    const sandbox = makeSandbox(t);

    // Point CODEX_HOME at a directory during install, then clear it before
    // remove to simulate a user whose env changed between install and remove.
    await withEnv(
      {
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        CODEX_HOME: sandbox.codexHome,
      },
      () => {
        const installResult = installConnector({
          connectorId: "codex-cli",
          config: {
            installExtension: true,
            extensionSourceDir: sandbox.syntheticSourceDir,
          },
        });
        assert.equal(installResult.status, "installed");

        // Precondition: the extension must physically exist under the
        // sandbox codexHome (not some default location).
        const installedPaths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
        assert.ok(
          fs.existsSync(installedPaths.remnicExtensionDir),
          "extension should exist in sandbox codexHome after install",
        );
      },
    );

    // Now clear CODEX_HOME (and point HOME somewhere else entirely) and call
    // removeConnector. If the fix is correct, removeConnector reads the
    // saved config's persisted codexHome and removes the extension from the
    // ORIGINAL sandbox location — not from some env-derived default.
    const alternateHome = path.join(sandbox.root, "alternate-home");
    fs.mkdirSync(alternateHome, { recursive: true });

    await withEnv(
      {
        HOME: sandbox.home, // keep HOME stable so connectorsDir is found
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        CODEX_HOME: undefined, // cleared
      },
      () => {
        const installedPaths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
        assert.ok(
          fs.existsSync(installedPaths.remnicExtensionDir),
          "sanity: extension still present before removeConnector",
        );

        const removeResult = removeConnector("codex-cli");
        assert.match(
          removeResult.message,
          /memory extension removed/,
          "remove should report the memory extension was removed",
        );

        // After removal, the ORIGINAL sandbox extension directory must be gone.
        assert.equal(
          fs.existsSync(installedPaths.remnicExtensionDir),
          false,
          "removeConnector must remove the extension from the original codexHome even after $CODEX_HOME is cleared",
        );
      },
    );
  },
);

test(
  "installCodexMemoryExtension removes pre-existing .remnic.tmp-* directories",
  async (t) => {
    const sandbox = makeSandbox(t);

    await withEnv(
      {
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
        XDG_CONFIG_HOME: sandbox.xdgConfigHome,
        CODEX_HOME: sandbox.codexHome,
      },
      () => {
        const paths = resolveCodexMemoryExtensionPaths(sandbox.codexHome);
        fs.mkdirSync(paths.extensionsRoot, { recursive: true });

        // Seed three stale tmp directories that look like leftover crashed runs
        // from previous invocations (different pid, different timestamp).
        const stale1 = path.join(paths.extensionsRoot, ".remnic.tmp-99999-1111111111111");
        const stale2 = path.join(paths.extensionsRoot, ".remnic.tmp-88888-2222222222222");
        const stale3 = path.join(paths.extensionsRoot, ".remnic.tmp-77777-3333333333333");
        for (const staleDir of [stale1, stale2, stale3]) {
          fs.mkdirSync(staleDir, { recursive: true });
          fs.writeFileSync(path.join(staleDir, "leftover.txt"), "stale\n");
        }

        // Also seed an unrelated file that must NOT be touched.
        const unrelated = path.join(paths.extensionsRoot, "some-other-vendor");
        fs.mkdirSync(unrelated, { recursive: true });
        fs.writeFileSync(path.join(unrelated, "keep.txt"), "keep me\n");

        const result = installCodexMemoryExtension({
          codexHome: sandbox.codexHome,
          sourceDir: sandbox.syntheticSourceDir,
        });

        // All stale tmp dirs must be gone.
        for (const staleDir of [stale1, stale2, stale3]) {
          assert.equal(
            fs.existsSync(staleDir),
            false,
            `stale tmp ${path.basename(staleDir)} must be removed by prefix scan`,
          );
        }

        // Adjacent unrelated extension must survive.
        assert.ok(
          fs.existsSync(path.join(unrelated, "keep.txt")),
          "adjacent unrelated extension must NOT be touched",
        );

        // New install must still have landed properly.
        assert.ok(fs.existsSync(result.remnicExtensionDir));
        assert.ok(fs.existsSync(result.instructionsPath));
      },
    );
  },
);
