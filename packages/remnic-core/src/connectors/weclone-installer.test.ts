/**
 * Integration tests for the WeClone connector install/remove flow.
 *
 * Covers gap-fill from Issue #458:
 *   - `weclone` is registered in BUILTIN_CONNECTORS
 *   - `remnic connectors install weclone` writes both the registry config
 *     AND the proxy config at ~/.remnic/connectors/weclone.json
 *   - Defaults are applied for unspecified fields
 *   - User-supplied overrides take precedence over defaults
 *   - Prior saved proxy config is honoured on force-reinstall
 *   - `remnic connectors remove weclone` removes both files
 *   - Proxy config precedence: user → prior → default
 *   - buildWeCloneProxyConfig rejects invalid ports and falls through
 *   - Synthetic data only — no personal information used
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWeCloneProxyConfig,
  installConnector,
  loadRegistry,
  removeConnector,
  resolveWeCloneProxyConfigPath,
} from "./index.js";

interface Sandbox {
  root: string;
  home: string;
  xdgConfigHome: string;
  remnicHome: string;
}

function makeSandbox(t: { after: (fn: () => void | Promise<void>) => void }): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-weclone-test-"));
  const home = path.join(root, "home");
  const xdgConfigHome = path.join(home, ".config");
  const remnicHome = path.join(home, ".remnic");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdgConfigHome, { recursive: true });
  fs.mkdirSync(remnicHome, { recursive: true });
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
  return { root, home, xdgConfigHome, remnicHome };
}

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

test("weclone manifest is registered in BUILTIN_CONNECTORS", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const registry = loadRegistry();
      const manifest = registry.connectors.find((c) => c.id === "weclone");
      assert.ok(manifest, "weclone must be present in the connector registry");
      assert.equal(manifest!.capabilities.connectionType, "http");
      assert.equal(manifest!.capabilities.observe, true);
      assert.equal(manifest!.capabilities.recall, true);
      assert.equal(manifest!.requiresToken, true, "weclone must require a token");
    },
  );
});

test("installConnector weclone writes registry config AND proxy config with defaults", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const result = installConnector({ connectorId: "weclone" });
      assert.equal(result.status, "installed", `expected installed, got: ${result.status} — ${result.message}`);
      assert.ok(result.configPath, "registry configPath must be set");
      assert.ok(fs.existsSync(result.configPath as string), "registry config must exist on disk");

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      assert.equal(
        proxyConfigPath,
        path.join(sandbox.remnicHome, "connectors", "weclone.json"),
        "proxy config must live under ~/.remnic/connectors/weclone.json (honouring REMNIC_HOME)",
      );
      assert.ok(fs.existsSync(proxyConfigPath), "proxy config must exist on disk");

      const proxy = JSON.parse(fs.readFileSync(proxyConfigPath, "utf8")) as Record<string, unknown>;
      // Defaults
      assert.equal(proxy.wecloneApiUrl, "http://localhost:8000/v1");
      assert.equal(proxy.proxyPort, 8100);
      assert.equal(proxy.remnicDaemonUrl, "http://localhost:4318");
      assert.equal(proxy.sessionStrategy, "single");
      assert.ok(proxy.memoryInjection && typeof proxy.memoryInjection === "object");

      // A bearer token should have been minted (requiresToken: true).
      assert.equal(typeof proxy.remnicAuthToken, "string");
      assert.ok((proxy.remnicAuthToken as string).length > 0);

      // The registry config must also record the proxy-side config path for doctor.
      const registryConfig = JSON.parse(
        fs.readFileSync(result.configPath as string, "utf8"),
      ) as Record<string, unknown>;
      assert.equal(registryConfig.proxyConfigPath, proxyConfigPath);
      assert.equal(registryConfig.proxyPort, 8100);
    },
  );
});

test("installConnector weclone honours user-supplied overrides", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const result = installConnector({
        connectorId: "weclone",
        config: {
          wecloneApiUrl: "http://upstream.example:9000/v1",
          proxyPort: 8200,
          remnicDaemonUrl: "http://daemon.example:4318",
          sessionStrategy: "caller-id",
        },
      });
      assert.equal(result.status, "installed");

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      const proxy = JSON.parse(fs.readFileSync(proxyConfigPath, "utf8")) as Record<string, unknown>;
      assert.equal(proxy.wecloneApiUrl, "http://upstream.example:9000/v1");
      assert.equal(proxy.proxyPort, 8200);
      assert.equal(proxy.remnicDaemonUrl, "http://daemon.example:4318");
      assert.equal(proxy.sessionStrategy, "caller-id");
    },
  );
});

test("installConnector weclone coerces string port from --config CLI parsing", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      // CLI `--config proxyPort=8300` passes the value as a string.
      const result = installConnector({
        connectorId: "weclone",
        config: { proxyPort: "8300" as unknown as number },
      });
      assert.equal(result.status, "installed");

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      const proxy = JSON.parse(fs.readFileSync(proxyConfigPath, "utf8")) as Record<string, unknown>;
      assert.equal(proxy.proxyPort, 8300, "string port must be coerced to a number");
      assert.equal(typeof proxy.proxyPort, "number");
    },
  );
});

test("installConnector weclone force-reinstall reuses persisted proxyConfigPath even if REMNIC_HOME changed", async (t) => {
  // Reviewer feedback (codex P2): force-reinstall must target the SAME
  // on-disk file the previous install wrote, not recompute from the current
  // REMNIC_HOME. Otherwise the old file is left behind with stale settings
  // and a revoked token when the env changes between installs.
  const sandbox = makeSandbox(t);
  const firstRemnicHome = sandbox.remnicHome;
  const secondRemnicHome = path.join(sandbox.root, "second-remnic-home");
  fs.mkdirSync(secondRemnicHome, { recursive: true });

  let firstProxyPath = "";

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: firstRemnicHome,
    },
    () => {
      const first = installConnector({
        connectorId: "weclone",
        config: { proxyPort: 8700 },
      });
      assert.equal(first.status, "installed");
      firstProxyPath = resolveWeCloneProxyConfigPath();
      assert.ok(fs.existsSync(firstProxyPath));
    },
  );

  // Now force-reinstall with a DIFFERENT REMNIC_HOME. The proxy config
  // write must target the ORIGINAL firstProxyPath (persisted via
  // proxyConfigPath in the registry config), not the env-derived path under
  // secondRemnicHome.
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: secondRemnicHome,
    },
    () => {
      const envDerived = resolveWeCloneProxyConfigPath();
      assert.notEqual(envDerived, firstProxyPath, "env derivation must differ after REMNIC_HOME change");

      const second = installConnector({
        connectorId: "weclone",
        force: true,
      });
      assert.equal(second.status, "installed");

      // The ORIGINAL path must still hold the updated config.
      assert.ok(fs.existsSync(firstProxyPath), "original proxy file must still exist after force-reinstall");
      // The env-derived path under the new REMNIC_HOME must NOT have been
      // created — otherwise we'd have two proxy configs with divergent state.
      assert.equal(
        fs.existsSync(envDerived),
        false,
        "force-reinstall must NOT create a second proxy config at the new env-derived path",
      );

      // The first proxy file must retain the original custom port (8700) and
      // have been rewritten with the fresh token.
      const proxy = JSON.parse(fs.readFileSync(firstProxyPath, "utf8")) as Record<string, unknown>;
      assert.equal(proxy.proxyPort, 8700, "force-reinstall must preserve prior port");
    },
  );
});

test("resolveWeCloneProxyConfigPath returns an absolute path even for a relative REMNIC_HOME override", async (t) => {
  // Reviewer feedback (codex P2): install (path.join) and run (path.resolve)
  // must agree on normalization. With a relative override like
  // `REMNIC_HOME=tmp/remnic`, `path.join` keeps it relative while
  // `path.resolve` makes it absolute — if they disagree, run-time fails
  // to locate the file install-time wrote. Verified by asserting
  // absoluteness here.
  const sandbox = makeSandbox(t);
  const relativeOverride = path.relative(process.cwd(), sandbox.remnicHome);
  // Guard: the sandbox path might not be relative-expressible (e.g. on a
  // different drive on Windows). Skip in that case.
  if (!relativeOverride || path.isAbsolute(relativeOverride)) {
    t.skip("Cannot construct a relative REMNIC_HOME for this test environment");
    return;
  }
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: relativeOverride,
    },
    () => {
      const resolved = resolveWeCloneProxyConfigPath();
      assert.equal(path.isAbsolute(resolved), true, "resolveWeCloneProxyConfigPath must return an absolute path");
      // Must normalize to the same absolute path the sandbox represents.
      assert.equal(
        resolved,
        path.resolve(sandbox.remnicHome, "connectors", "weclone.json"),
      );
    },
  );
});

test("installConnector weclone force-reinstall preserves prior custom fields", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      // First install with a custom port.
      const first = installConnector({
        connectorId: "weclone",
        config: { proxyPort: 8500, sessionStrategy: "caller-id" },
      });
      assert.equal(first.status, "installed");

      // Force-reinstall without supplying any config overrides — the proxy
      // file must retain the prior custom port and strategy rather than
      // resetting to the manifest default.
      const second = installConnector({
        connectorId: "weclone",
        force: true,
      });
      assert.equal(second.status, "installed");

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      const proxy = JSON.parse(fs.readFileSync(proxyConfigPath, "utf8")) as Record<string, unknown>;
      assert.equal(proxy.proxyPort, 8500, "force-reinstall must preserve prior custom port");
      assert.equal(proxy.sessionStrategy, "caller-id", "force-reinstall must preserve prior strategy");
    },
  );
});

test("removeConnector weclone uses persisted proxyConfigPath even if REMNIC_HOME changed", async (t) => {
  // Install into one REMNIC_HOME, then call remove with a DIFFERENT REMNIC_HOME.
  // The persisted absolute path must win so the original file is deleted even
  // if the env changed between install and remove (e.g. user rotates their
  // home dir, or REMNIC_HOME was scoped to a shell that later unset it).
  const sandbox = makeSandbox(t);
  const altRemnicHome = path.join(sandbox.root, "alt-remnic-home");
  fs.mkdirSync(altRemnicHome, { recursive: true });

  let installedProxyPath = "";
  let installedConfigPath = "";

  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const installResult = installConnector({ connectorId: "weclone" });
      assert.equal(installResult.status, "installed");
      installedProxyPath = resolveWeCloneProxyConfigPath();
      installedConfigPath = installResult.configPath as string;
      assert.ok(fs.existsSync(installedProxyPath), "precondition: proxy config exists at install-time path");
    },
  );

  // Simulate env change: point REMNIC_HOME at a different directory during
  // remove. The original proxy file is at installedProxyPath — if removal
  // were to naively re-resolve from env, it would try to delete a non-existent
  // path under altRemnicHome and leave the real file behind.
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: altRemnicHome,
    },
    () => {
      // Sanity: the env-derived path now resolves somewhere else.
      const envDerived = resolveWeCloneProxyConfigPath();
      assert.notEqual(envDerived, installedProxyPath);

      const removeResult = removeConnector("weclone");
      assert.equal(removeResult.status, "removed");

      // The ORIGINAL proxy config file must have been deleted via the persisted
      // proxyConfigPath — not left behind because env has moved on.
      assert.equal(
        fs.existsSync(installedProxyPath),
        false,
        "original proxy config must be deleted via persisted proxyConfigPath even after REMNIC_HOME changed",
      );
      assert.equal(fs.existsSync(installedConfigPath), false, "registry config must also be deleted");
    },
  );
});

test("removeConnector weclone cleans up both registry and proxy config files", async (t) => {
  const sandbox = makeSandbox(t);
  await withEnv(
    {
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      XDG_CONFIG_HOME: sandbox.xdgConfigHome,
      REMNIC_HOME: sandbox.remnicHome,
    },
    () => {
      const installResult = installConnector({ connectorId: "weclone" });
      assert.equal(installResult.status, "installed");

      const proxyConfigPath = resolveWeCloneProxyConfigPath();
      assert.ok(fs.existsSync(proxyConfigPath), "precondition: proxy config exists");
      assert.ok(fs.existsSync(installResult.configPath as string), "precondition: registry config exists");

      const removeResult = removeConnector("weclone");
      assert.equal(removeResult.status, "removed", `expected removed, got: ${removeResult.status}`);
      assert.equal(fs.existsSync(proxyConfigPath), false, "proxy config must be deleted on remove");
      assert.equal(
        fs.existsSync(installResult.configPath as string),
        false,
        "registry config must be deleted on remove",
      );
    },
  );
});

// ── buildWeCloneProxyConfig unit tests (no filesystem) ────────────────────

test("buildWeCloneProxyConfig applies defaults when nothing provided", () => {
  const config = buildWeCloneProxyConfig({ userConfig: {}, priorConfig: null });
  assert.equal(config.wecloneApiUrl, "http://localhost:8000/v1");
  assert.equal(config.proxyPort, 8100);
  assert.equal(config.remnicDaemonUrl, "http://localhost:4318");
  assert.equal(config.sessionStrategy, "single");
  assert.equal(config.memoryInjection.maxTokens, 1500);
  assert.equal(config.memoryInjection.position, "system-append");
});

test("buildWeCloneProxyConfig precedence: user > prior > default", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: { proxyPort: 9100 },
    priorConfig: {
      proxyPort: 9000,
      wecloneApiUrl: "http://prior.example:8000/v1",
      sessionStrategy: "caller-id",
    },
  });
  assert.equal(config.proxyPort, 9100, "user wins over prior");
  assert.equal(config.wecloneApiUrl, "http://prior.example:8000/v1", "prior wins over default");
  assert.equal(config.sessionStrategy, "caller-id");
});

test("buildWeCloneProxyConfig falls through invalid port to prior, then default", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: { proxyPort: 70000 }, // invalid (>65535)
    priorConfig: { proxyPort: 9000 },
  });
  assert.equal(config.proxyPort, 9000, "invalid user port falls through to prior");

  const config2 = buildWeCloneProxyConfig({
    userConfig: { proxyPort: -1 }, // invalid
    priorConfig: { proxyPort: "not-a-number" as unknown as number }, // invalid
  });
  assert.equal(config2.proxyPort, 8100, "all invalid falls through to default");
});

test("buildWeCloneProxyConfig rejects invalid sessionStrategy", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: { sessionStrategy: "round-robin" }, // invalid
    priorConfig: null,
  });
  assert.equal(config.sessionStrategy, "single", "invalid strategy falls back to default");
});

test("buildWeCloneProxyConfig only persists auth token when available", () => {
  const withToken = buildWeCloneProxyConfig({
    userConfig: {},
    priorConfig: null,
    authToken: "synthetic-test-token",
  });
  assert.equal(withToken.remnicAuthToken, "synthetic-test-token");

  const withoutToken = buildWeCloneProxyConfig({
    userConfig: {},
    priorConfig: null,
  });
  assert.equal(withoutToken.remnicAuthToken, undefined);
});

test("buildWeCloneProxyConfig fresh token overrides prior", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: {},
    priorConfig: { remnicAuthToken: "stale-token" },
    authToken: "fresh-token",
  });
  assert.equal(config.remnicAuthToken, "fresh-token", "freshly minted token must replace prior");
});

test("buildWeCloneProxyConfig merges memoryInjection partials", () => {
  const config = buildWeCloneProxyConfig({
    userConfig: { memoryInjection: { maxTokens: 2500 } },
    priorConfig: { memoryInjection: { template: "prior template {memories}" } },
  });
  assert.equal(config.memoryInjection.maxTokens, 2500, "user override wins");
  assert.equal(
    config.memoryInjection.template,
    "prior template {memories}",
    "prior value persists when user did not override",
  );
  assert.equal(
    config.memoryInjection.position,
    "system-append",
    "default fills the remaining field",
  );
});
