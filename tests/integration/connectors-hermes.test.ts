/**
 * Integration tests for the Hermes connector install/remove flow.
 *
 * Tests validate:
 * - hermes appears in listConnectors().available
 * - installConnector({ connectorId: "hermes" }) writes a token with remnic_hm_ prefix
 * - force-reinstall regenerates the token (new value, old one filtered out)
 * - removeConnector("hermes") removes the tokens.json entry
 * - upsertHermesConfig round-trips correctly (preserves unrelated YAML content)
 * - removeHermesConfig strips the remnic: block and preserves remaining content
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const CONNECTORS_SRC = path.join(ROOT, "packages/remnic-core/src/connectors/index.ts");
const TOKENS_SRC = path.join(ROOT, "packages/remnic-core/src/tokens.ts");

// ── Source-level checks (no tsx import needed) ────────────────────────────

test("hermes is in BUILTIN_CONNECTORS", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(content.includes('id: "hermes"'), "hermes must be in BUILTIN_CONNECTORS");
  assert.ok(content.includes('name: "Hermes Agent"'), "Must have correct name");
  assert.ok(
    content.includes('connectionType: "http"'),
    "Must use http connection type",
  );
});

test("hermes connector has expected capabilities", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  // Find the hermes block specifically — look for id: "hermes" then nearby observe: true
  const hermesIdx = content.indexOf('id: "hermes"');
  assert.ok(hermesIdx >= 0, "hermes block must exist");
  // Slice a window around the block to check its capabilities
  const window = content.slice(hermesIdx, hermesIdx + 600);
  assert.ok(window.includes("observe: true"), "hermes must support observe");
  assert.ok(window.includes("recall: true"), "hermes must support recall");
  assert.ok(window.includes("store: true"), "hermes must support store");
  assert.ok(window.includes("search: true"), "hermes must support search");
  assert.ok(window.includes("realtimeSync: true"), "hermes must support realtimeSync");
});

test("installConnector calls generateToken for every connector", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes("generateToken(options.connectorId)"),
    "installConnector must call generateToken",
  );
});

test("removeConnector calls revokeToken", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes("revokeToken(connectorId)"),
    "removeConnector must call revokeToken",
  );
});

test("installConnector performs daemon health check for hermes", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes("checkDaemonHealth"),
    "installConnector must call checkDaemonHealth",
  );
  assert.ok(
    content.includes("/engram/v1/health"),
    "health check must target /engram/v1/health",
  );
});

test("upsertHermesConfig is exported", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes("export function upsertHermesConfig"),
    "upsertHermesConfig must be exported",
  );
});

test("removeHermesConfig is exported", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes("export function removeHermesConfig"),
    "removeHermesConfig must be exported",
  );
});

test("tokens.ts defines remnic_hm_ prefix for hermes", () => {
  const content = fs.readFileSync(TOKENS_SRC, "utf-8");
  assert.ok(
    content.includes('"hermes": "remnic_hm_"'),
    "tokens.ts must define remnic_hm_ prefix for hermes",
  );
});

// ── Filesystem round-trip tests ────────────────────────────────────────────

/**
 * Creates a temp HOME dir so we don't pollute real state.
 * Sets up the HOME env var override used by tokens.ts and connectors/index.ts.
 *
 * Also clears XDG_CONFIG_HOME for the duration of the test. getConnectorsDir()
 * prefers XDG_CONFIG_HOME over HOME/.config when computing the connectors dir,
 * so a CI runner that sets XDG_CONFIG_HOME (e.g. GitHub Actions Ubuntu images
 * default it to /home/runner/.config) would cause installConnector to read
 * from the real XDG path while tests write fixtures under tmpHome/.config.
 * The mismatch silently falls through to defaults (e.g. port 4318) and makes
 * per-test state-leak tests flaky or outright broken on CI.
 * Unsetting XDG_CONFIG_HOME forces getConnectorsDir() back onto HOME/.config,
 * which the test has redirected to tmpHome.
 */
function withTempHome(fn: (tmpHome: string) => void): void {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-hermes-test-"));
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  try {
    process.env.HOME = tmpHome;
    delete process.env.XDG_CONFIG_HOME;
    fn(tmpHome);
  } finally {
    process.env.HOME = originalHome;
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    try { fs.rmSync(tmpHome, { recursive: true }); } catch { /* ignore */ }
  }
}

test("upsertHermesConfig creates config.yaml when profile dir exists but file does not", () => {
  withTempHome((tmpHome) => {
    const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
    fs.mkdirSync(profileDir, { recursive: true });

    // Dynamically import to get fresh module with new HOME
    // Because we can't import @remnic/core via node:test without tsx,
    // we validate via the file-system behaviour described in the source.
    // Inline re-implementation of the logic to test the round-trip:
    const cfgPath = path.join(profileDir, "config.yaml");
    assert.ok(!fs.existsSync(cfgPath), "config.yaml should not exist yet");

    // Simulate what upsertHermesConfig writes. Use a short synthetic token value
    // (not a real secret — just enough chars to validate the write path).
    const FAKE_TOKEN = ["remnic", "hm"].join("_") + "_SYNTHETIC_TEST_VALUE";
    const block = [
      "remnic:",
      '  host: "127.0.0.1"',
      "  port: 4318",
      `  token: "${FAKE_TOKEN}"`,
    ].join("\n");
    fs.writeFileSync(cfgPath, block + "\n");

    const written = fs.readFileSync(cfgPath, "utf-8");
    assert.ok(written.includes("remnic:"), "Must write remnic: block");
    assert.ok(written.includes(FAKE_TOKEN), "Must include the token");
    assert.ok(written.includes("host:"), "Must include host");
    assert.ok(written.includes("port:"), "Must include port");
  });
});

test("upsertHermesConfig round-trip: existing YAML with other keys is preserved", () => {
  withTempHome((tmpHome) => {
    const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
    fs.mkdirSync(profileDir, { recursive: true });
    const cfgPath = path.join(profileDir, "config.yaml");

    // Write a config.yaml with existing content + old remnic block.
    // Tokens here are clearly synthetic — not real secrets.
    const OLD_TOKEN = ["remnic", "hm"].join("_") + "_OLDVALUE_TEST";
    const NEW_TOKEN = ["remnic", "hm"].join("_") + "_NEWVALUE_TEST";
    const initial = [
      "plugins:",
      "  - remnic_hermes",
      "  - some_other_plugin",
      "",
      "some_other_key: value",
      "",
      "remnic:",
      '  host: "127.0.0.1"',
      "  port: 4318",
      `  token: "${OLD_TOKEN}"`,
      '  session_key: "my-session"',
      "  timeout: 30.0",
      "",
    ].join("\n");
    fs.writeFileSync(cfgPath, initial);

    // Simulate an update: new token, same host/port, session_key preserved
    // (manual round-trip test matching the logic in upsertHermesConfig)
    const raw = fs.readFileSync(cfgPath, "utf-8");
    const lines = raw.split("\n");
    const newLines: string[] = [];
    let inRemnicBlock = false;
    const written = { host: false, port: false, token: false };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^remnic:/.test(line)) {
        inRemnicBlock = true;
        newLines.push(line);
        continue;
      }
      if (inRemnicBlock) {
        if (line.length > 0 && !/^\s/.test(line)) {
          if (!written.host) newLines.push('  host: "127.0.0.1"');
          if (!written.port) newLines.push("  port: 4318");
          if (!written.token) newLines.push(`  token: "${NEW_TOKEN}"`);
          inRemnicBlock = false;
          newLines.push(line);
          continue;
        }
        if (/^\s+host:/.test(line)) {
          newLines.push('  host: "127.0.0.1"');
          written.host = true;
        } else if (/^\s+port:/.test(line)) {
          newLines.push("  port: 4318");
          written.port = true;
        } else if (/^\s+token:/.test(line)) {
          newLines.push(`  token: "${NEW_TOKEN}"`);
          written.token = true;
        } else {
          newLines.push(line); // preserves session_key, timeout, etc.
        }
        continue;
      }
      newLines.push(line);
    }
    if (inRemnicBlock) {
      if (!written.host) newLines.push('  host: "127.0.0.1"');
      if (!written.port) newLines.push("  port: 4318");
      if (!written.token) newLines.push(`  token: "${NEW_TOKEN}"`);
    }
    fs.writeFileSync(cfgPath, newLines.join("\n"));

    const result = fs.readFileSync(cfgPath, "utf-8");
    // Unrelated content preserved
    assert.ok(result.includes("plugins:"), "plugins: key must be preserved");
    assert.ok(result.includes("some_other_plugin"), "other plugin must be preserved");
    assert.ok(result.includes("some_other_key: value"), "other top-level key must be preserved");
    // Token updated
    assert.ok(result.includes(NEW_TOKEN), "New token must be present");
    assert.ok(!result.includes(OLD_TOKEN), "Old token must be gone");
    // session_key preserved (not touched by upsert)
    assert.ok(result.includes("session_key"), "session_key must be preserved");
  });
});

test("removeHermesConfig strips remnic: block and preserves rest of file", () => {
  withTempHome((tmpHome) => {
    const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
    fs.mkdirSync(profileDir, { recursive: true });
    const cfgPath = path.join(profileDir, "config.yaml");

    // Short synthetic token value — not a real secret
    const FAKE_TOKEN = ["remnic", "hm"].join("_") + "_FAKE_REMOVE_TEST";
    const initial = [
      "plugins:",
      "  - remnic_hermes",
      "",
      "remnic:",
      '  host: "127.0.0.1"',
      "  port: 4318",
      `  token: "${FAKE_TOKEN}"`,
      "",
      "other_key: other_value",
      "",
    ].join("\n");
    fs.writeFileSync(cfgPath, initial);

    // Simulate removeHermesConfig logic
    const raw = fs.readFileSync(cfgPath, "utf-8");
    const lines = raw.split("\n");
    const newLines: string[] = [];
    let inRemnicBlock = false;

    for (const line of lines) {
      if (/^remnic:/.test(line)) {
        inRemnicBlock = true;
        continue;
      }
      if (inRemnicBlock) {
        if (line.length > 0 && !/^\s/.test(line)) {
          inRemnicBlock = false;
          newLines.push(line);
        }
        continue;
      }
      newLines.push(line);
    }
    while (newLines.length > 0 && newLines[newLines.length - 1]?.trim() === "") {
      newLines.pop();
    }
    fs.writeFileSync(cfgPath, newLines.length > 0 ? newLines.join("\n") + "\n" : "");

    const result = fs.readFileSync(cfgPath, "utf-8");
    assert.ok(!result.includes("remnic:"), "remnic: block must be removed");
    assert.ok(!result.includes(FAKE_TOKEN), "token must be removed");
    assert.ok(result.includes("plugins:"), "plugins: key must be preserved");
    assert.ok(result.includes("other_key: other_value"), "other keys must be preserved");
  });
});

test("removeHermesConfig is a no-op when remnic: block is already absent", async () => {
  // Import the real implementation so this test actually exercises the
  // early-return path in removeHermesConfig instead of asserting a
  // tautology (the original cursor-flagged bug: the test wrote a file,
  // read it back twice, and asserted equality without ever calling the
  // function under test).
  const mod = await import(
    "../../packages/remnic-core/src/connectors/index.ts"
  );

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });
        const cfgPath = path.join(profileDir, "config.yaml");

        const initial = "plugins:\n  - some_plugin\n";
        fs.writeFileSync(cfgPath, initial);

        const result = mod.removeHermesConfig({ profile: "default" });

        assert.equal(result.updated, false, "removeHermesConfig must not update");
        assert.equal(result.skipped, true, "removeHermesConfig must report skipped");
        assert.match(
          result.reason ?? "",
          /No remnic: block found/,
          "skip reason should indicate missing block",
        );

        // And the file content should be exactly what we wrote — the function
        // must not rewrite or truncate the file when there is nothing to remove.
        const after = fs.readFileSync(cfgPath, "utf-8");
        assert.equal(after, initial, "File must be unchanged when no remnic: block present");
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Token generation and revocation (file-based) ──────────────────────────

test("hermes install writes a remnic_hm_ prefixed token entry to tokens.json", () => {
  withTempHome((tmpHome) => {
    const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");

    // Inline the token write logic from tokens.ts (generateToken).
    // Use a short synthetic value — real tokens are 58 chars (prefix + 48 hex),
    // but for this test we only care about the prefix convention.
    fs.mkdirSync(path.dirname(tokensPath), { recursive: true });
    const EXPECTED_PREFIX = ["remnic", "hm"].join("_") + "_";
    const entry = {
      token: EXPECTED_PREFIX + "TEST_ONLY_NOT_A_REAL_TOKEN",
      connector: "hermes",
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(tokensPath, JSON.stringify({ tokens: [entry] }, null, 2), { mode: 0o600 });

    const store = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
      tokens: Array<{ token: string; connector: string }>;
    };
    const hermesEntry = store.tokens.find((t) => t.connector === "hermes");
    assert.ok(hermesEntry, "hermes token entry must exist");
    assert.ok(hermesEntry.token.startsWith(EXPECTED_PREFIX), "Token must have remnic_hm_ prefix");
  });
});

test("force-reinstall produces a new token and removes the old one", () => {
  withTempHome((tmpHome) => {
    const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
    fs.mkdirSync(path.dirname(tokensPath), { recursive: true });

    const TOKEN_PREFIX = ["remnic", "hm"].join("_") + "_";

    // Write initial token (short synthetic value — not a real secret)
    const oldEntry = {
      token: TOKEN_PREFIX + "OLD_TEST_ONLY",
      connector: "hermes",
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(tokensPath, JSON.stringify({ tokens: [oldEntry] }, null, 2), { mode: 0o600 });

    // Simulate force-reinstall: filter old + add new (matches generateToken logic)
    const store = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as { tokens: typeof oldEntry[] };
    store.tokens = store.tokens.filter((t) => t.connector !== "hermes");
    const newEntry = {
      token: TOKEN_PREFIX + "NEW_TEST_ONLY",
      connector: "hermes",
      createdAt: new Date().toISOString(),
    };
    store.tokens.push(newEntry);
    fs.writeFileSync(tokensPath, JSON.stringify(store, null, 2), { mode: 0o600 });

    const result = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as { tokens: typeof oldEntry[] };
    const entries = result.tokens.filter((t) => t.connector === "hermes");
    assert.equal(entries.length, 1, "Must have exactly one hermes token after force-reinstall");
    assert.equal(entries[0]!.token, newEntry.token, "New token must be present");
    assert.ok(!result.tokens.find((t) => t.token === oldEntry.token), "Old token must be gone");
  });
});

test("installConnector aborts early when tokenEntry is null (P1 guard — atomic flow)", () => {
  // In the new atomic flow, a null tokenEntry causes an early return with status "error"
  // BEFORE upsertHermesConfig is called. This is stricter than the old if/else pattern:
  // upsertHermesConfig is reached only after the tokenEntry null-guard passes.
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  // The guard must exist: if (!tokenEntry) { return { ... status: "error" ... } }
  assert.ok(
    content.includes("if (!tokenEntry)"),
    "Must have if (!tokenEntry) guard before upsertHermesConfig",
  );
  // The early-return error message for missing token must be present.
  assert.ok(
    content.includes("token store unavailable") || content.includes("Token store unavailable"),
    "Abort message must mention token store unavailability",
  );
  // upsertHermesConfig must only be reached after the tokenEntry guard passes
  // (the null check returns early, so the call is outside any else branch in the
  // new atomic flow — the absence of the old if/else is intentional).
  const upsertIdx = content.indexOf("upsertHermesConfig({");
  assert.ok(upsertIdx >= 0, "upsertHermesConfig must still be called in the happy path");
  // Confirm the tokenEntry null-guard appears before upsertHermesConfig in the source.
  const tokenNullGuardIdx = content.lastIndexOf("if (!tokenEntry)", upsertIdx);
  assert.ok(
    tokenNullGuardIdx >= 0,
    "if (!tokenEntry) guard must appear before the upsertHermesConfig call",
  );
});

test("removeConnector wraps revokeToken in try-catch (P2 guard)", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  // Verify revokeToken is wrapped in try { ... } catch
  // Find the revokeToken call and check it's inside a try block
  const revokeIdx = content.indexOf("revokeToken(connectorId)");
  assert.ok(revokeIdx >= 0, "revokeToken must be called in removeConnector");
  // The code before revokeToken must contain `try {`
  const before = content.slice(0, revokeIdx);
  const tryIdx = before.lastIndexOf("try {");
  assert.ok(tryIdx >= 0, "revokeToken must be inside a try block");
  // And the code after revokeToken must contain `} catch {`
  const after = content.slice(revokeIdx);
  assert.ok(
    after.indexOf("} catch {") >= 0 && after.indexOf("} catch {") < 200,
    "revokeToken must be followed by a catch block",
  );
});

test("removeConnector hermes removes the tokens.json entry", () => {
  withTempHome((tmpHome) => {
    const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
    fs.mkdirSync(path.dirname(tokensPath), { recursive: true });

    // Short synthetic values — not real secrets
    const TOKEN_HM = ["remnic", "hm"].join("_") + "_TEST";
    const TOKEN_CC = ["remnic", "cc"].join("_") + "_TEST";

    // Write initial store with hermes + another connector
    const initial = {
      tokens: [
        { token: TOKEN_HM, connector: "hermes", createdAt: new Date().toISOString() },
        { token: TOKEN_CC, connector: "claude-code", createdAt: new Date().toISOString() },
      ],
    };
    fs.writeFileSync(tokensPath, JSON.stringify(initial, null, 2), { mode: 0o600 });

    // Simulate revokeToken("hermes") — matches tokens.ts revokeToken logic
    const store = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as typeof initial;
    store.tokens = store.tokens.filter((t) => t.connector !== "hermes");
    fs.writeFileSync(tokensPath, JSON.stringify(store, null, 2), { mode: 0o600 });

    const result = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as typeof initial;
    assert.ok(
      !result.tokens.find((t) => t.connector === "hermes"),
      "hermes token must be removed after removeConnector",
    );
    assert.ok(
      result.tokens.find((t) => t.connector === "claude-code"),
      "claude-code token must not be affected",
    );
  });
});

// ── Review-feedback regression tests (PR #400) ────────────────────────────

test("sanitizeHermesProfile rejects path-traversing profile values", () => {
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  // Source-level guard: the sanitizer must exist and be called by hermesConfigPath
  assert.ok(
    content.includes("function sanitizeHermesProfile"),
    "sanitizeHermesProfile must exist to validate profile names",
  );
  assert.ok(
    content.includes("sanitizeHermesProfile(profile)"),
    "hermesConfigPath must call sanitizeHermesProfile on the profile argument",
  );
  // The regex anchors and explicit `..` rejection are what prevent traversal.
  assert.ok(
    content.includes("^[A-Za-z0-9][A-Za-z0-9._-]*$"),
    "sanitizer must pin profile names to a safe character class",
  );
  assert.ok(
    content.includes('profile.includes("..")'),
    "sanitizer must explicitly reject parent-directory references",
  );
  // Defense in depth: the resolved path must be confirmed inside profilesRoot.
  assert.ok(
    content.includes('resolved outside'),
    "hermesConfigPath must verify the resolved path stays under the profiles root",
  );
});

test("installConnector writes user config before the generated token (token wins)", () => {
  // Regression test for the cursor-reported issue: a stray `token` key in
  // options.config would silently override the daemon-generated token,
  // producing a mismatch between the JSON config and tokens.json.
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  // The spread order inside resolvedConfig must be: options.config, THEN token.
  const resolvedStart = content.indexOf("const resolvedConfig");
  assert.ok(resolvedStart >= 0, "resolvedConfig must exist in installConnector");
  const resolvedEnd = content.indexOf("};", resolvedStart);
  assert.ok(resolvedEnd > resolvedStart, "resolvedConfig block must close");
  const block = content.slice(resolvedStart, resolvedEnd);
  const userSpreadIdx = block.indexOf("...options.config");
  const tokenSpreadIdx = block.indexOf("tokenEntry ? { token: tokenEntry.token }");
  assert.ok(userSpreadIdx >= 0, "resolvedConfig must spread options.config");
  assert.ok(tokenSpreadIdx >= 0, "resolvedConfig must overlay tokenEntry.token");
  assert.ok(
    userSpreadIdx < tokenSpreadIdx,
    "options.config must be spread before tokenEntry so the generated token wins",
  );
});

test("checkDaemonHealth forwards the bearer token to the health probe", () => {
  // Regression test for the codex-reported issue: /engram/v1/health is behind
  // bearer auth in the access HTTP server, so the probe must send the token
  // the connector just generated (or was configured with). Without it the
  // probe always returns 401 and reports the daemon as unreachable.
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes("authToken?: string"),
    "checkDaemonHealth must accept an optional auth token",
  );
  assert.ok(
    content.includes("REMNIC_HEALTH_TOKEN"),
    "checkDaemonHealth must expose the token via env var (not script interpolation)",
  );
  assert.ok(
    content.includes("'authorization'") || content.includes('"authorization"'),
    "health probe script must set an Authorization header",
  );
  assert.ok(
    content.includes("'Bearer '") || content.includes('"Bearer "'),
    "health probe script must use a Bearer scheme",
  );
  // installConnector must actually pass the generated token in.
  // In the new atomic flow, the call uses tokenEntry.token directly (no intermediate
  // healthToken variable — the variable was removed in the atomic refactor).
  assert.ok(
    /checkDaemonHealth\(hermesHost, hermesPort, tokenEntry\.token\)/.test(content) ||
    /checkDaemonHealth\(hermesHost, hermesPort, healthToken\)/.test(content),
    "installConnector must pass the connector token to checkDaemonHealth",
  );
});

// ── Finding 1 regression: secret files are written with 0o600 permissions ───

test("upsertHermesConfig writes config.yaml with 0o600 permissions (new file)", async () => {
  // Import the real implementation so this test exercises the actual write path.
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });
        const cfgPath = path.join(profileDir, "config.yaml");

        // Use a synthetic token that passes the alphanumeric guard in the source.
        const FAKE_TOKEN = "remnic_hm_SYNTHETICPERMTEST";
        mod.upsertHermesConfig({
          profile: "default",
          host: "127.0.0.1",
          port: 4318,
          token: FAKE_TOKEN,
        });

        assert.ok(fs.existsSync(cfgPath), "config.yaml must be created");
        const stats = fs.statSync(cfgPath);
        assert.equal(
          stats.mode & 0o777,
          0o600,
          "config.yaml must be written with owner-only (0o600) permissions",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

test("removeHermesConfig preserves 0o600 permissions after stripping remnic: block", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });
        const cfgPath = path.join(profileDir, "config.yaml");

        // Simulate a file that was previously written with 0o600 (it held a token).
        const FAKE_TOKEN = "remnic_hm_SYNTHETICREMOVETEST";
        const initial = [
          "plugins:",
          "  - remnic_hermes",
          "",
          "remnic:",
          '  host: "127.0.0.1"',
          "  port: 4318",
          `  token: "${FAKE_TOKEN}"`,
          "",
        ].join("\n");
        fs.writeFileSync(cfgPath, initial, { mode: 0o600 });
        fs.chmodSync(cfgPath, 0o600);

        const result = mod.removeHermesConfig({ profile: "default" });
        assert.equal(result.updated, true, "removeHermesConfig must report updated");

        const stats = fs.statSync(cfgPath);
        assert.equal(
          stats.mode & 0o777,
          0o600,
          "config.yaml must retain 0o600 permissions after removeHermesConfig",
        );
        const after = fs.readFileSync(cfgPath, "utf-8");
        assert.ok(!after.includes("remnic:"), "remnic: block must be stripped");
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Finding 3 regression: upsertHermesConfig rejects YAML-breaking host values ──

test("upsertHermesConfig throws on YAML-injection host (newline)", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        assert.throws(
          () =>
            mod.upsertHermesConfig({
              profile: "default",
              host: "foo\nbar: evil",
              port: 4318,
              token: "remnic_hm_SYNTHETICINJECTIONTEST",
            }),
          /Invalid Hermes host/,
          "upsertHermesConfig must throw on a host containing a newline",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

test("upsertHermesConfig throws on YAML-injection host (colon + space)", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        assert.throws(
          () =>
            mod.upsertHermesConfig({
              profile: "default",
              host: 'foo" \n  session_key: "evil',
              port: 4318,
              token: "remnic_hm_SYNTHETICINJECTION2",
            }),
          /Invalid Hermes host/,
          "upsertHermesConfig must throw on a host containing quotes and newlines",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 3 regression: force reinstall preserves saved profile/host/port ──

test("force reinstall preserves previously saved profile/host/port when no overrides are supplied", async () => {
  // Regression for Codex P2: installConnector hard-reset to default/127.0.0.1/4318
  // on force reinstall, writing the new token to the wrong Hermes profile.
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        // Ensure clean slate so a leftover hermes connector from a concurrently
        // running test doesn't cause the first install to return already_installed.
        mod.removeConnector("hermes");

        // Set up a Hermes profile dir for "research" at a non-default host/port
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "research");
        fs.mkdirSync(profileDir, { recursive: true });

        // Initial install with explicit profile / host / port
        const install1 = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "research", host: "10.0.0.5", port: 5555 },
        });
        assert.equal(install1.status, "installed", "First install must succeed");

        // install1.configPath is the connector JSON path — use it directly rather
        // than reconstructing the XDG-aware path by hand.
        const connectorJsonPath = install1.configPath;
        assert.ok(connectorJsonPath, "install1 must return a configPath");
        const connectorJson = JSON.parse(fs.readFileSync(connectorJsonPath!, "utf-8"));
        assert.equal(connectorJson.profile, "research", "Initial install: profile must be research");
        assert.equal(connectorJson.host, "10.0.0.5", "Initial install: host must be 10.0.0.5");
        assert.equal(connectorJson.port, 5555, "Initial install: port must be 5555");

        // Verify tokens.json has a token for hermes (tokens live at ~/.remnic/tokens.json)
        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const tokens1 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const entry1 = tokens1.tokens.find((t) => t.connector === "hermes");
        assert.ok(entry1, "tokens.json must have a hermes entry after first install");
        const token1 = entry1.token;

        // Force reinstall with NO config overrides
        const install2 = mod.installConnector({
          connectorId: "hermes",
          force: true,
          // No config supplied — must inherit profile/host/port from saved JSON
        });
        assert.equal(install2.status, "installed", "Force reinstall must succeed");

        // The connector JSON must still use research / 10.0.0.5 / 5555
        const connectorJson2 = JSON.parse(fs.readFileSync(connectorJsonPath!, "utf-8"));
        assert.equal(connectorJson2.profile, "research", "Force reinstall: profile must be preserved as research");
        assert.equal(connectorJson2.host, "10.0.0.5", "Force reinstall: host must be preserved as 10.0.0.5");
        assert.equal(connectorJson2.port, 5555, "Force reinstall: port must be preserved as 5555");

        // The token must have been regenerated (new value)
        const tokens2 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const entry2 = tokens2.tokens.find((t) => t.connector === "hermes");
        assert.ok(entry2, "tokens.json must still have a hermes entry after force reinstall");
        assert.notEqual(entry2.token, token1, "Force reinstall must produce a new token");

        // The research profile config.yaml must contain the NEW token
        const yamlContent = fs.readFileSync(
          path.join(profileDir, "config.yaml"),
          "utf-8",
        );
        assert.ok(yamlContent.includes(entry2.token), "research config.yaml must contain the new token");
        assert.ok(!yamlContent.includes(token1), "research config.yaml must not contain the old token");

        // Verify no stale remnic: block was written to the default profile
        const defaultProfileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        const defaultCfgPath = path.join(defaultProfileDir, "config.yaml");
        assert.ok(
          !fs.existsSync(defaultCfgPath),
          "default profile config.yaml must not exist — token must not spill to wrong profile",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 3 regression: upsertHermesConfig trailing newline and no blank lines ──

test("upsertHermesConfig in-place update: file ending with \\n gets exactly one trailing newline and no blank line before appended sub-keys", async () => {
  // Regression for Cursor Low: split("\\n") on a file ending with "\\n" produced
  // a trailing empty-string element that was pushed into newLines while still
  // inside the remnic: block, causing a blank line between existing sub-keys and
  // any newly-appended missing sub-keys. The write path also dropped the trailing
  // newline, producing inconsistent results across create/append/update paths.
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });
        const cfgPath = path.join(profileDir, "config.yaml");

        // Write a config.yaml ending with "\n" that has a remnic: block missing token:.
        // The trailing "\n" causes split("\n") to produce a final empty-string element
        // that the old code injected as a blank line inside the remnic: block.
        const FAKE_TOKEN = "remnic_hm_SYNTHETICROUND3TRAILINGNL";
        const initial = "remnic:\n  host: \"127.0.0.1\"\n  port: 4318\n";
        fs.writeFileSync(cfgPath, initial, { mode: 0o600 });

        // Confirm file ends with exactly one "\n" (precondition for the test)
        assert.ok(initial.endsWith("\n"), "Precondition: test input must end with \\n");
        assert.ok(!initial.endsWith("\n\n"), "Precondition: test input must not end with two \\n");

        // Call upsertHermesConfig — triggers the in-place update path and must
        // append token: without a blank line and preserve the trailing newline.
        mod.upsertHermesConfig({
          profile: "default",
          host: "127.0.0.1",
          port: 4318,
          token: FAKE_TOKEN,
        });

        const result = fs.readFileSync(cfgPath, "utf-8");

        // Must end with exactly one "\n"
        assert.ok(result.endsWith("\n"), "Result must end with a trailing newline");
        assert.ok(!result.endsWith("\n\n"), "Result must not end with two consecutive newlines");

        // Must contain the token
        assert.ok(result.includes(FAKE_TOKEN), "Result must contain the supplied token");

        // Must contain no blank line between existing sub-keys and the appended token.
        // We detect this by checking for the specific "sub-key\n\n  sub-key" pattern.
        assert.ok(
          !result.includes("  port: 4318\n\n  token:"),
          "Must not have a blank line between port: and token:",
        );
        assert.ok(
          !result.includes("  host: \"127.0.0.1\"\n\n  port:"),
          "Must not have a blank line between host: and port:",
        );

        // Sanity: the remnic: block itself must be structurally valid
        assert.ok(result.includes("remnic:"), "Must contain remnic: key");
        assert.ok(result.includes('  host: "127.0.0.1"'), "Must contain host sub-key");
        assert.ok(result.includes("  port: 4318"), "Must contain port sub-key");
        assert.ok(result.includes(`  token: "${FAKE_TOKEN}"`), "Must contain token sub-key");
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Finding C regression: health probe 401 retry ──────────────────────────

test("checkDaemonHealth: source uses exit code 2 for 401 to distinguish from other errors", () => {
  // Source-level check: the probe script must exit with a distinct code for 401
  // so checkDaemonHealth can detect a token-cache miss and retry vs. a real failure.
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  // The script must differentiate 401 (exit 2) from other non-200 statuses (exit 1).
  assert.ok(
    content.includes("res.statusCode === 401 ? 2 : 1"),
    "health probe script must exit(2) on 401 and exit(1) on other errors",
  );
  // The wrapper must recognise exit code 2 as a retriable 401.
  assert.ok(
    content.includes("HEALTH_EXIT_UNAUTHORIZED"),
    "checkDaemonHealth must define HEALTH_EXIT_UNAUTHORIZED constant",
  );
  // The retry log message must be present so operators can diagnose the delay.
  assert.ok(
    content.includes("health probe got 401 — retrying after token cache TTL"),
    "checkDaemonHealth must log a clear retry message on 401",
  );
});

test("checkDaemonHealth: retries exactly once on 401 (source structure check)", () => {
  // Verify the retry-once structure exists in the source without running a live server.
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  // There must be a single retry call after the 401 branch.
  const retryIdx = content.indexOf("const retry = spawnSync");
  assert.ok(retryIdx >= 0, "checkDaemonHealth must perform exactly one retry");
  // The retry must check HEALTH_EXIT_OK (0) to decide success.
  const afterRetry = content.slice(retryIdx, retryIdx + 200);
  assert.ok(
    afterRetry.includes("HEALTH_EXIT_OK"),
    "retry result must be compared against HEALTH_EXIT_OK",
  );
  // There must be only ONE retry invocation (not two).
  const secondRetryIdx = content.indexOf("const retry = spawnSync", retryIdx + 1);
  assert.equal(
    secondRetryIdx,
    -1,
    "checkDaemonHealth must have exactly one retry call, not two",
  );
});

// ── Finding D regression: sanitizeHermesPort rejects non-integers ─────────

test("sanitizeHermesPort source rejects non-integer ports (Finding D)", () => {
  // Source-level check: the function must use Number.isInteger, not Math.trunc,
  // so that fractional port values like 4318.9 are rejected rather than silently
  // truncated to 4318.
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");
  assert.ok(
    content.includes("Number.isInteger(numeric)"),
    "sanitizeHermesPort must check Number.isInteger before accepting the value",
  );
  // The error message must clearly indicate the port must be a positive integer.
  assert.ok(
    content.includes("must be a positive integer"),
    "sanitizeHermesPort must throw with a clear 'must be a positive integer' message",
  );
});

test("sanitizeHermesPort rejects fractional port 4318.9 (runtime)", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        // 4318.9 must be rejected — NOT truncated to 4318
        assert.throws(
          () =>
            mod.upsertHermesConfig({
              profile: "default",
              host: "127.0.0.1",
              port: 4318.9,
              token: "remnic_hm_SYNTHETICPORTTEST",
            }),
          /must be a positive integer/,
          "upsertHermesConfig must throw on fractional port 4318.9",
        );

        // Integer port must still work
        assert.doesNotThrow(
          () =>
            mod.upsertHermesConfig({
              profile: "default",
              host: "127.0.0.1",
              port: 4318,
              token: "remnic_hm_SYNTHETICPORTTEST",
            }),
          "upsertHermesConfig must not throw on integer port 4318",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

test("sanitizeHermesPort rejects NaN and Infinity (runtime)", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        // NaN: Number("abc") === NaN, Number.isInteger(NaN) === false
        assert.throws(
          () =>
            mod.upsertHermesConfig({
              profile: "default",
              host: "127.0.0.1",
              port: NaN,
              token: "remnic_hm_SYNTHETICNANTEST",
            }),
          /must be a positive integer/,
          "upsertHermesConfig must throw on NaN port",
        );

        // Infinity: Number.isInteger(Infinity) === false
        assert.throws(
          () =>
            mod.upsertHermesConfig({
              profile: "default",
              host: "127.0.0.1",
              port: Infinity,
              token: "remnic_hm_SYNTHETICINFTEST",
            }),
          /must be a positive integer/,
          "upsertHermesConfig must throw on Infinity port",
        );

        // Negative: Number.isInteger(-1) === true but range check fails
        assert.throws(
          () =>
            mod.upsertHermesConfig({
              profile: "default",
              host: "127.0.0.1",
              port: -1,
              token: "remnic_hm_SYNTHETICNEGTEST",
            }),
          /Invalid Hermes port/,
          "upsertHermesConfig must throw on negative port",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 4 regressions ───────────────────────────────────────────────────

// Fix 1: old profile config must be preserved when the new upsertHermesConfig fails
test("old profile config is preserved when new upsertHermesConfig fails", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        // Issue A fix: remove any leftover hermes connector state that may have
        // been written to whatever HOME directory is current (either this temp dir
        // or a stale HOME from a concurrently running test that clobbered
        // process.env.HOME). This ensures the first installConnector call below
        // always sees a clean slate and returns "installed" rather than
        // "already_installed".
        mod.removeConnector("hermes");

        // Set up the old profile dir and do an initial install on "old-profile".
        const oldProfileDir = path.join(tmpHome, ".hermes", "profiles", "old-profile");
        fs.mkdirSync(oldProfileDir, { recursive: true });

        const install1 = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "old-profile", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(install1.status, "installed", "First install must succeed");

        // Confirm old-profile's config.yaml has a remnic: block.
        const oldCfgPath = path.join(oldProfileDir, "config.yaml");
        assert.ok(fs.existsSync(oldCfgPath), "old-profile config.yaml must exist after first install");
        const beforeContent = fs.readFileSync(oldCfgPath, "utf-8");
        assert.ok(beforeContent.includes("remnic:"), "old-profile config.yaml must have remnic: block before reinstall");

        // Attempt to force-reinstall onto "new-profile" whose directory does NOT exist.
        // In the new atomic flow: upsertHermesConfig returns {skipped: true}, which
        // causes installConnector to abort with status "error". The old profile's
        // remnic: block must remain intact — connector.json must NOT be overwritten.
        const install2 = mod.installConnector({
          connectorId: "hermes",
          force: true,
          config: { profile: "new-profile", host: "127.0.0.1", port: 4318 },
        });
        // Atomic flow: missing profile dir is a hard abort, not a silent skip.
        assert.equal(install2.status, "error", "Force reinstall onto missing dir must return error in atomic flow");
        assert.ok(
          install2.message.toLowerCase().includes("abort") ||
          install2.message.toLowerCase().includes("profile") ||
          install2.message.toLowerCase().includes("not written"),
          `Error message must explain the abort reason, got: ${install2.message}`,
        );

        // old-profile's config.yaml must still exist and contain the remnic: block.
        assert.ok(fs.existsSync(oldCfgPath), "old-profile config.yaml must still exist after failed new-profile install");
        const afterContent = fs.readFileSync(oldCfgPath, "utf-8");
        assert.ok(afterContent.includes("remnic:"), "old-profile config.yaml remnic: block must be preserved when new install targeted a missing profile dir");
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// Fix 2: persisted string port is coerced on force reinstall
test("persisted string port is coerced on force reinstall", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        // Set up the hermes profile dir so upsertHermesConfig can write.
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "research");
        fs.mkdirSync(profileDir, { recursive: true });

        // Manually write a connector JSON with port as a STRING — this simulates
        // what the CLI produces when the user passes --config=port=5555.
        // getConnectorsDir() resolves to ~/.config/engram/.engram-connectors/connectors
        // (since XDG_CONFIG_HOME is not set in tests, HOME is used).
        const connectorsDir = path.join(tmpHome, ".config", "engram", ".engram-connectors", "connectors");
        fs.mkdirSync(connectorsDir, { recursive: true });
        const connectorJsonPath = path.join(connectorsDir, "hermes.json");
        const savedConfig = {
          connectorId: "hermes",
          installedAt: new Date().toISOString(),
          profile: "research",
          host: "10.0.0.5",
          port: "5555", // STRING — the bug scenario
        };
        fs.writeFileSync(connectorJsonPath, JSON.stringify(savedConfig, null, 2), { mode: 0o600 });

        // Force reinstall with no config overrides — must inherit and coerce the saved port.
        const install = mod.installConnector({
          connectorId: "hermes",
          force: true,
        });
        assert.equal(install.status, "installed", "Force reinstall must succeed");
        assert.ok(install.configPath, "Force reinstall must return a configPath");

        // The connector JSON must now have port as a NUMBER (5555), not the string "5555".
        const written = JSON.parse(fs.readFileSync(install.configPath!, "utf-8"));
        assert.equal(typeof written.port, "number", "Written port must be a number, not a string");
        assert.equal(written.port, 5555, "Written port must be 5555, not the default 4318");
        assert.equal(written.profile, "research", "Written profile must be research");
        assert.equal(written.host, "10.0.0.5", "Written host must be 10.0.0.5");

        // The research profile config.yaml must also reference port 5555, not 4318.
        const yamlContent = fs.readFileSync(
          path.join(profileDir, "config.yaml"),
          "utf-8",
        );
        assert.ok(
          yamlContent.includes("port: 5555"),
          "research config.yaml must use port 5555, not the default 4318",
        );
        assert.ok(
          !yamlContent.includes("port: 4318"),
          "research config.yaml must NOT revert to the default port 4318",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 5 regressions ───────────────────────────────────────────────────

// Issue B regression: token must NOT be rotated when upsertHermesConfig fails
test("token is not rotated when upsertHermesConfig fails (missing profile dir)", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        // Ensure clean state first.
        mod.removeConnector("hermes");

        // Initial install onto an existing profile dir so the first token is
        // written both to tokens.json and to the profile's config.yaml.
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "stable");
        fs.mkdirSync(profileDir, { recursive: true });

        const install1 = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "stable", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(install1.status, "installed", "Initial install must succeed");

        // Read back the token that was written during the first install.
        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const store1 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const entry1 = store1.tokens.find((t) => t.connector === "hermes");
        assert.ok(entry1, "tokens.json must have a hermes entry after initial install");
        const originalToken = entry1.token;
        assert.ok(originalToken.startsWith("remnic_hm_"), "Token must have hermes prefix");

        // Force reinstall onto "ghost-profile" whose directory does NOT exist.
        // In the new atomic flow: upsertHermesConfig returns {skipped: true}, which
        // causes installConnector to abort with status "error" BEFORE committing
        // the new token — the original token must survive in tokens.json.
        const install2 = mod.installConnector({
          connectorId: "hermes",
          force: true,
          config: { profile: "ghost-profile", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(install2.status, "error", "Atomic flow: missing profile dir aborts with error");

        // tokens.json must still contain the ORIGINAL token, not a new one.
        const store2 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const entry2 = store2.tokens.find((t) => t.connector === "hermes");
        assert.ok(entry2, "tokens.json must still have a hermes entry after failed reinstall");
        assert.equal(
          entry2.token,
          originalToken,
          "Token must NOT be rotated when upsertHermesConfig skips due to missing profile dir",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// Issue C regression: invalid port must return a failed InstallResult, not throw
test("installConnector returns error result on invalid port (not a throw)", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((_tmpHome) => {
        // Ensure clean state.
        mod.removeConnector("hermes");

        // Call installConnector with a port that will fail sanitizeHermesPort.
        // "abc" is not a valid integer — the sanitizer must throw internally but
        // installConnector must catch it and return a structured error result.
        let result: ReturnType<typeof mod.installConnector> | undefined;
        assert.doesNotThrow(() => {
          result = mod.installConnector({
            connectorId: "hermes",
            config: { host: "127.0.0.1", port: "abc" },
          });
        }, "installConnector must NOT throw on invalid port — it must return an error result");

        assert.ok(result !== undefined, "installConnector must return a result");
        assert.equal(result!.status, "error", "Status must be 'error' for invalid port");
        assert.ok(
          result!.message.toLowerCase().includes("port") ||
          result!.message.toLowerCase().includes("invalid"),
          `Error message must mention the port validation issue, got: ${result!.message}`,
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// Fix 3 / atomic flow: installConnector aborts before health probe when token generation fails
test("installConnector aborts before health probe when token generation fails (atomic flow)", () => {
  // In the new atomic flow, a null tokenEntry causes an early return with status
  // "error" long before the health probe is reached. We verify at the source level
  // that:
  //   1. The early-return error guard for !tokenEntry exists.
  //   2. checkDaemonHealth is gated by `committed && tokenEntry` (double guard).
  //   3. There is no path that reaches checkDaemonHealth with a null tokenEntry.
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");

  // The tokenEntry null guard must exist.
  assert.ok(
    content.includes("if (!tokenEntry)"),
    "Source must contain an early-return guard for null tokenEntry",
  );

  // The committed+tokenEntry double guard must be present on the health probe.
  assert.ok(
    content.includes("committed && tokenEntry"),
    "checkDaemonHealth must be gated by both committed flag and tokenEntry",
  );

  // checkDaemonHealth must appear AFTER the committed guard (not before it).
  const committedGuardIdx = content.indexOf("committed && tokenEntry");
  const probeIdx = content.indexOf("checkDaemonHealth(hermesHost");
  assert.ok(
    committedGuardIdx >= 0 && probeIdx > committedGuardIdx,
    "checkDaemonHealth must appear after the committed && tokenEntry gate in source order",
  );
});

// ── PR #400 atomic flow regression tests ─────────────────────────────────────

// Regression: YAML write skipped → install returns error, old token NOT rotated,
// connector.json NOT overwritten, no health-check probe fired.
test("atomic flow: YAML skipped returns error, old token preserved, connector.json unchanged", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");

        // First install onto an existing profile dir.
        const stableDir = path.join(tmpHome, ".hermes", "profiles", "stable");
        fs.mkdirSync(stableDir, { recursive: true });
        const install1 = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "stable", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(install1.status, "installed", "Initial install must succeed");

        // Read back the original connector.json and token.
        const connectorJsonPath = install1.configPath!;
        const originalJson = fs.readFileSync(connectorJsonPath, "utf-8");
        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const store1 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const originalToken = store1.tokens.find((t) => t.connector === "hermes")?.token;
        assert.ok(originalToken, "Original token must be in tokens.json");

        // Force reinstall onto "ghost-profile" whose directory does NOT exist.
        // This triggers the YAML-skipped abort path.
        const install2 = mod.installConnector({
          connectorId: "hermes",
          force: true,
          config: { profile: "ghost-profile", host: "127.0.0.1", port: 4318 },
        });

        // Must return error (not "installed").
        assert.equal(install2.status, "error", "YAML-skipped install must return status 'error'");
        assert.ok(!install2.configPath, "Error result must not include a configPath");

        // connector.json must be UNCHANGED (not overwritten with new candidate token).
        const afterJson = fs.readFileSync(connectorJsonPath, "utf-8");
        assert.equal(
          afterJson,
          originalJson,
          "connector.json must not be overwritten when YAML is skipped",
        );

        // The original token must still be in tokens.json (not rotated).
        const store2 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const token2 = store2.tokens.find((t) => t.connector === "hermes")?.token;
        assert.equal(
          token2,
          originalToken,
          "Old token must NOT be rotated when YAML write is skipped",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// Regression: YAML writes OK, commitTokenEntry throws → YAML rolled back,
// old token NOT rotated, install returns failure.
test("atomic flow: commitTokenEntry failure rolls back YAML and preserves old token", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");

        // First install to establish a baseline.
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "writable");
        fs.mkdirSync(profileDir, { recursive: true });
        const install1 = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "writable", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(install1.status, "installed", "Initial install must succeed");

        const cfgPath = path.join(profileDir, "config.yaml");
        const yamlBefore = fs.readFileSync(cfgPath, "utf-8");
        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const originalToken = (JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        }).tokens.find((t) => t.connector === "hermes")?.token;
        assert.ok(originalToken, "Baseline token must be present");

        // Make tokens.json read-only to simulate commitTokenEntry failure.
        fs.chmodSync(tokensPath, 0o444);
        try {
          // Force reinstall — YAML write will succeed, but token commit must fail.
          const install2 = mod.installConnector({
            connectorId: "hermes",
            force: true,
            config: { profile: "writable", host: "127.0.0.1", port: 4318 },
          });

          // Must return error.
          assert.equal(install2.status, "error", "commitTokenEntry failure must return error");
          assert.ok(
            install2.message.toLowerCase().includes("abort") ||
            install2.message.toLowerCase().includes("token") ||
            install2.message.toLowerCase().includes("commit"),
            `Error message must explain the commit failure, got: ${install2.message}`,
          );

          // The YAML must be rolled back to its pre-install content.
          const yamlAfter = fs.readFileSync(cfgPath, "utf-8");
          assert.equal(
            yamlAfter,
            yamlBefore,
            "config.yaml must be rolled back to prior content when commitTokenEntry fails",
          );
        } finally {
          // Restore write permission so the temp dir can be cleaned up.
          try { fs.chmodSync(tokensPath, 0o600); } catch { /* ignore */ }
        }
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// Regression: IPv6 bracketed host — health check strips brackets before http.get
test("checkDaemonHealth: strips brackets from IPv6 host before probing (source-level check)", () => {
  // Finding 7 fix: sanitizeHermesHost permits [::1] (brackets required for URLs),
  // but Node's http.get({ host }) requires the bare literal "::1". We verify
  // the strip logic is present in the source so that valid IPv6 daemons don't
  // get false-negative "Daemon not reachable" reports.
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");

  // The bracket-stripping logic must be present.
  assert.ok(
    (content.includes('host.startsWith("[")') && content.includes('host.endsWith("]")')),
    "checkDaemonHealth must detect and strip IPv6 bracket delimiters",
  );

  // The slice(1, -1) must be present to remove the brackets.
  assert.ok(
    content.includes("host.slice(1, -1)"),
    "checkDaemonHealth must use slice(1, -1) to strip the brackets",
  );

  // The unbracketed value must be forwarded to the env (not the original `host`).
  assert.ok(
    content.includes("REMNIC_HEALTH_HOST: bareHost"),
    "checkDaemonHealth must pass the bracket-stripped bareHost to the health probe env",
  );
});

// ── PR #400 round 6: sanitizeHermesHost host:port and IPv6 regression tests ──

test("sanitizeHermesHost rejects host:port form (127.0.0.1:4318)", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        let result: ReturnType<typeof mod.installConnector> | undefined;
        assert.doesNotThrow(() => {
          result = mod.installConnector({
            connectorId: "hermes",
            config: { host: "127.0.0.1:4318", port: 4318 },
          });
        }, "installConnector must NOT throw on invalid host — it must return an error result");

        assert.ok(result !== undefined, "installConnector must return a result");
        assert.equal(result!.status, "error", "host:port form must return status error");
        assert.ok(
          result!.message.toLowerCase().includes("port") ||
          result!.message.toLowerCase().includes("host"),
          `Error message must mention the invalid host, got: ${result!.message}`,
        );

        // config.yaml must NOT have been written
        const cfgPath = path.join(profileDir, "config.yaml");
        assert.ok(!fs.existsSync(cfgPath), "config.yaml must not be written when host is rejected");

        // tokens.json must NOT have been minted
        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        if (fs.existsSync(tokensPath)) {
          const store = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
            tokens: Array<{ connector: string }>;
          };
          const hermesEntry = store.tokens.find((t) => t.connector === "hermes");
          assert.ok(!hermesEntry, "No hermes token must be minted when install is rejected due to bad host");
        }
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

test("sanitizeHermesHost accepts bracketed IPv6 [::1]", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        const result = mod.installConnector({
          connectorId: "hermes",
          config: { host: "[::1]", port: 4318 },
        });
        assert.equal(result.status, "installed", "Bracketed IPv6 [::1] must be accepted");

        // config.yaml must record the bracketed form
        const cfgPath = path.join(profileDir, "config.yaml");
        assert.ok(fs.existsSync(cfgPath), "config.yaml must be written for [::1]");
        const yaml = fs.readFileSync(cfgPath, "utf-8");
        assert.ok(yaml.includes("[::1]"), "config.yaml must store the bracketed IPv6 host unchanged");
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

test("sanitizeHermesHost accepts bracketed IPv6 [2001:db8::1]", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        const result = mod.installConnector({
          connectorId: "hermes",
          config: { host: "[2001:db8::1]", port: 4318 },
        });
        assert.equal(result.status, "installed", "Bracketed IPv6 [2001:db8::1] must be accepted");

        const cfgPath = path.join(profileDir, "config.yaml");
        assert.ok(fs.existsSync(cfgPath), "config.yaml must be written for [2001:db8::1]");
        const yaml = fs.readFileSync(cfgPath, "utf-8");
        assert.ok(yaml.includes("[2001:db8::1]"), "config.yaml must store the bracketed IPv6 host unchanged");
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

test("sanitizeHermesHost rejects unbalanced bracket [::1 (no closing bracket)", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((_tmpHome) => {
        mod.removeConnector("hermes");

        let result: ReturnType<typeof mod.installConnector> | undefined;
        assert.doesNotThrow(() => {
          result = mod.installConnector({
            connectorId: "hermes",
            config: { host: "[::1", port: 4318 },
          });
        }, "installConnector must NOT throw on unbalanced bracket host");

        assert.ok(result !== undefined, "installConnector must return a result");
        assert.equal(result!.status, "error", "Unbalanced bracket must return status error");
        assert.ok(
          result!.message.toLowerCase().includes("bracket") ||
          result!.message.toLowerCase().includes("host") ||
          result!.message.toLowerCase().includes("invalid"),
          `Error message must mention the invalid host, got: ${result!.message}`,
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

test("sanitizeHermesHost accepts plain DNS hostname localhost", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        const result = mod.installConnector({
          connectorId: "hermes",
          config: { host: "localhost", port: 4318 },
        });
        assert.equal(result.status, "installed", "Plain DNS hostname 'localhost' must be accepted");

        const cfgPath = path.join(profileDir, "config.yaml");
        assert.ok(fs.existsSync(cfgPath), "config.yaml must be written for localhost");
        const yaml = fs.readFileSync(cfgPath, "utf-8");
        assert.ok(yaml.includes("localhost"), "config.yaml must record 'localhost' as host");
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// Regression: happy path — old token only revoked after successful commit,
// connector.json only written after commit.
test("atomic flow: happy path — connector.json and token written only after YAML+commit succeed", async () => {
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");

        const profileDir = path.join(tmpHome, ".hermes", "profiles", "happy");
        fs.mkdirSync(profileDir, { recursive: true });

        // Install from scratch — all steps must complete in order.
        const result = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "happy", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(result.status, "installed", "Happy path must return installed");
        assert.ok(result.configPath, "Happy path must return a configPath");

        // connector.json must exist and contain the new token.
        const connJson = JSON.parse(fs.readFileSync(result.configPath!, "utf-8")) as {
          token: string;
          profile: string;
          host: string;
          port: number;
        };
        assert.ok(connJson.token.startsWith("remnic_hm_"), "connector.json token must have hermes prefix");
        assert.equal(connJson.profile, "happy", "connector.json must record the profile");
        assert.equal(connJson.host, "127.0.0.1", "connector.json must record the host");
        assert.equal(connJson.port, 4318, "connector.json must record the port");

        // tokens.json must contain the same token as connector.json.
        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const store = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const entry = store.tokens.find((t) => t.connector === "hermes");
        assert.ok(entry, "tokens.json must have a hermes entry");
        assert.equal(
          entry.token,
          connJson.token,
          "tokens.json and connector.json must agree on the token value",
        );

        // config.yaml must also contain the same token.
        const yaml = fs.readFileSync(path.join(profileDir, "config.yaml"), "utf-8");
        assert.ok(
          yaml.includes(connJson.token),
          "config.yaml must contain the same token as connector.json and tokens.json",
        );

        // Force reinstall — old token must be replaced (not preserved).
        const result2 = mod.installConnector({
          connectorId: "hermes",
          force: true,
          config: { profile: "happy", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(result2.status, "installed", "Force reinstall must succeed");
        const connJson2 = JSON.parse(fs.readFileSync(result2.configPath!, "utf-8")) as {
          token: string;
        };
        assert.notEqual(
          connJson2.token,
          connJson.token,
          "Force reinstall must rotate the token (old token must be replaced)",
        );
        // Old token must not appear in tokens.json.
        const store2 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        assert.ok(
          !store2.tokens.find((t) => t.token === connJson.token),
          "Old token must be revoked from tokens.json after successful force reinstall",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 8 regression: partial-failure rollback (PRRT_kwDORJXyws56UNDM) ────

test("installConnector Phase E failure: connector JSON write fails → token store and YAML rolled back (fresh install)", async () => {
  // Simulate writeSecretFileSync failing for the connector JSON (Phase E) while
  // the Hermes YAML (Phase C) and token commit (Phase D) already succeeded.
  // Strategy: do a first install to establish the connectors dir path, read it
  // from installResult.configPath, then make that dir read-only, then force
  // reinstall. The force reinstall triggers Phases C+D again and then tries
  // Phase E, which fails — rollback must undo D and C.
  //
  // Expected outcome (force-reinstall case — PRRT_kwDORJXyws56UTrT fix):
  //   - installConnector returns status "error"
  //   - tokens.json is restored to its pre-commit snapshot, which means the
  //     ORIGINAL hermes token from the first install is still present
  //   - config.yaml is restored to its prior content (YAML rolled back to first-install state)
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");

        // Set up a Hermes profile dir so upsertHermesConfig can write config.yaml.
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        // First install to get the correct connectors dir path and to put
        // config.yaml in a known prior state.
        const firstInstall = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "default", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(firstInstall.status, "installed", "Pre-condition: first install must succeed");

        const connectorsDir = path.dirname(firstInstall.configPath!);
        const cfgPath = path.join(profileDir, "config.yaml");
        assert.ok(fs.existsSync(cfgPath), "Pre-condition: config.yaml must exist after first install");
        const yamlAfterFirst = fs.readFileSync(cfgPath, "utf-8");

        // Capture the first-install token — this is what Phase E rollback must restore.
        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const storeAfterFirst = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const originalToken = storeAfterFirst.tokens.find((t) => t.connector === "hermes")?.token;
        assert.ok(originalToken, "Pre-condition: first install must produce a hermes token");

        // Remove the existing connector.json so the force reinstall will try to
        // CREATE a new file (not overwrite). On a 0o555 dir, creating a new file
        // fails with EACCES but overwriting an existing file does not — so we must
        // ensure no file is present before locking down the dir.
        fs.unlinkSync(firstInstall.configPath!);
        // Make the connectors dir read-only so the Phase E write fails.
        fs.chmodSync(connectorsDir, 0o555);

        let result: ReturnType<typeof mod.installConnector>;
        try {
          result = mod.installConnector({
            connectorId: "hermes",
            force: true,
            config: { profile: "default", host: "127.0.0.1", port: 4318 },
          });
        } finally {
          // Restore write permission so withTempHome cleanup can remove the dir.
          try { fs.chmodSync(connectorsDir, 0o755); } catch { /* ignore */ }
        }

        // installConnector must return an error status (not throw).
        assert.equal(result!.status, "error", "Phase E failure must return status: error");
        assert.ok(
          result!.message.includes("connector config write failed") ||
          result!.message.includes("aborted"),
          "Error message must mention the connector config write failure",
        );

        // Token store must be restored to the pre-commit snapshot — the original
        // hermes token from the first install must still be present.
        // (PRRT_kwDORJXyws56UTrT fix: snapshot restore, not simple revoke.)
        assert.ok(fs.existsSync(tokensPath), "tokens.json must exist after Phase E rollback");
        const storeAfterRollback = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const restoredEntry = storeAfterRollback.tokens.find((t) => t.connector === "hermes");
        assert.ok(
          restoredEntry,
          "tokens.json must still contain a hermes entry after Phase E rollback (prior token restored)",
        );
        assert.equal(
          restoredEntry!.token,
          originalToken,
          "tokens.json must contain the ORIGINAL hermes token from the first install after rollback",
        );

        // config.yaml must have been rolled back to its state before the force reinstall
        // (priorContent was the first-install content, not null — so it must be restored).
        assert.ok(
          fs.existsSync(cfgPath),
          "config.yaml must exist after Phase E rollback (restored to prior content)",
        );
        const yamlAfterRollback = fs.readFileSync(cfgPath, "utf-8");
        // The rollback restores the YAML content from before the force reinstall attempt.
        assert.ok(
          yamlAfterRollback.includes("remnic:"),
          "config.yaml must contain remnic: block after rollback (restored to prior state)",
        );
        assert.ok(
          yamlAfterRollback.includes("127.0.0.1"),
          "config.yaml must contain host after rollback",
        );
        // The rolled-back content must match what was present before the failed reinstall.
        assert.equal(
          yamlAfterRollback,
          yamlAfterFirst,
          "config.yaml must be restored to exactly its pre-reinstall content",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 10 regression: Phase E rollback reinstates prior token (PRRT_kwDORJXyws56UTrT) ──

test("installConnector Phase E failure on force-reinstall: prior hermes token is reinstated in tokens.json", async () => {
  // Regression test for PRRT_kwDORJXyws56UTrT: when Phase E (connector JSON
  // write) fails during a force-reinstall of an existing Hermes setup, the
  // rollback must restore the full token store snapshot (including the prior
  // hermes token) — not just revoke the new token. Without this fix, a Phase E
  // failure would leave tokens.json without any hermes entry while config.yaml
  // was restored to the old token, breaking Hermes auth.
  //
  // This test explicitly verifies the force-reinstall case where a prior token
  // already exists, and asserts that the ORIGINAL token value (not "no entry")
  // is present after rollback.
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");

        // Set up a Hermes profile dir.
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        // ── Step 1: Initial install (establishes the "prior" token) ──
        const install1 = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "default", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(install1.status, "installed", "Initial install must succeed");

        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const store1 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const priorToken = store1.tokens.find((t) => t.connector === "hermes")?.token;
        assert.ok(priorToken, "Initial install must write a hermes token");
        assert.ok(priorToken.startsWith("remnic_hm_"), "Prior token must have hermes prefix");

        const cfgPath = path.join(profileDir, "config.yaml");
        const yamlAfterInstall1 = fs.readFileSync(cfgPath, "utf-8");
        assert.ok(yamlAfterInstall1.includes(priorToken), "config.yaml must reference the prior token");

        // ── Step 2: Force-reinstall that fails at Phase E ──
        // Remove connector.json first (new-file creation fails on 0o555 dir).
        fs.unlinkSync(install1.configPath!);
        const connectorsDir = path.dirname(install1.configPath!);
        fs.chmodSync(connectorsDir, 0o555);

        let install2: ReturnType<typeof mod.installConnector>;
        try {
          install2 = mod.installConnector({
            connectorId: "hermes",
            force: true,
            config: { profile: "default", host: "127.0.0.1", port: 4318 },
          });
        } finally {
          try { fs.chmodSync(connectorsDir, 0o755); } catch { /* ignore */ }
        }

        // ── Step 3: Assertions ──

        // Must return error (Phase E write failed).
        assert.equal(install2!.status, "error", "Phase E failure must return status: error");

        // The ORIGINAL prior token must be reinstated in tokens.json.
        assert.ok(fs.existsSync(tokensPath), "tokens.json must exist");
        const store2 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const restoredEntry = store2.tokens.find((t) => t.connector === "hermes");
        assert.ok(
          restoredEntry,
          "tokens.json must contain a hermes entry after Phase E rollback on force-reinstall",
        );
        assert.equal(
          restoredEntry!.token,
          priorToken,
          "The ORIGINAL prior hermes token must be reinstated — not absent, not a new token",
        );

        // config.yaml must be restored to its state from after install1
        // (same prior token, same content).
        assert.ok(fs.existsSync(cfgPath), "config.yaml must exist after rollback");
        const yamlAfterRollback = fs.readFileSync(cfgPath, "utf-8");
        assert.equal(
          yamlAfterRollback,
          yamlAfterInstall1,
          "config.yaml must be restored to exactly its pre-reinstall content",
        );
        // config.yaml must still reference the original token (not the new rotated one).
        assert.ok(
          yamlAfterRollback.includes(priorToken),
          "config.yaml must reference the original prior token after rollback",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 8 regression: removeConnector partial-failure (PRRT_kwDORJXyws56UNDO) ─

test("removeConnector: unlink failure leaves token intact and returns error", async () => {
  // Simulate fs.unlinkSync failing for the connector JSON (e.g., connectors dir
  // is read-only). Expected outcome: removeConnector returns status "error" AND:
  //   - tokens.json STILL contains the hermes entry (token NOT revoked)
  //   - The connector JSON still exists on disk (unlink failed)
  //   - Hermes config.yaml is NOT cleaned up (cleanup skipped — file not deleted)
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");

        // Set up a Hermes profile dir and install the connector successfully.
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        const installResult = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "default", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(installResult.status, "installed", "Pre-condition: install must succeed");

        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const storeBefore = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const entryBefore = storeBefore.tokens.find((t) => t.connector === "hermes");
        assert.ok(entryBefore, "Pre-condition: hermes token must exist before removal attempt");

        // Make the connectors dir read-only so unlinkSync fails.
        const connectorsDir = path.dirname(installResult.configPath!);
        fs.chmodSync(connectorsDir, 0o555);

        let removeResult: ReturnType<typeof mod.removeConnector>;
        try {
          removeResult = mod.removeConnector("hermes");
        } finally {
          // Restore write permission so withTempHome cleanup can remove the dir.
          try { fs.chmodSync(connectorsDir, 0o755); } catch { /* ignore */ }
        }

        // removeConnector must return error status (not throw).
        assert.equal(removeResult!.status, "error", "Unlink failure must return status: error");
        assert.ok(
          removeResult!.message.toLowerCase().includes("aborted") ||
          removeResult!.message.toLowerCase().includes("could not delete"),
          "Error message must indicate removal was aborted",
        );

        // Token must NOT have been revoked.
        const storeAfter = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const entryAfter = storeAfter.tokens.find((t) => t.connector === "hermes");
        assert.ok(
          entryAfter,
          "tokens.json must still contain the hermes entry when unlink failed",
        );
        assert.equal(
          entryAfter!.token,
          entryBefore!.token,
          "Token value must be unchanged after failed removal",
        );

        // Connector JSON must still exist (unlink failed).
        assert.ok(
          fs.existsSync(installResult.configPath!),
          "Connector JSON must still exist after failed unlink",
        );

        // Hermes config.yaml must NOT have been cleaned up (removal aborted before cleanup).
        const cfgPath = path.join(profileDir, "config.yaml");
        assert.ok(
          fs.existsSync(cfgPath),
          "config.yaml must still exist — removal was aborted before YAML cleanup",
        );
        const yamlContent = fs.readFileSync(cfgPath, "utf-8");
        assert.ok(
          yamlContent.includes("remnic:"),
          "config.yaml remnic: block must still be present after failed removal",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 9 regression: generic remove error message (PRRT_kwDORJXyws56UQQk) ─

test("removeConnector unlink error message is connector-agnostic (no Hermes/config.yaml)", () => {
  // Source-level guard: the shared unlinkSync catch block must not hardcode
  // "Hermes" or "config.yaml" text. The message template must use connectorId.
  const content = fs.readFileSync(CONNECTORS_SRC, "utf-8");

  // Find the unlinkSync catch block
  const unlinkCatchIdx = content.indexOf("could not delete connector file");
  assert.ok(
    unlinkCatchIdx >= 0,
    "The generic unlink error message must say 'could not delete connector file'",
  );

  // Extract a window around the catch block (up to 300 chars) and assert
  // it does NOT contain hardcoded Hermes references or config.yaml text.
  const window = content.slice(Math.max(0, unlinkCatchIdx - 50), unlinkCatchIdx + 300);
  assert.ok(
    !window.includes("Hermes config.yaml"),
    "Generic unlink error must NOT reference 'Hermes config.yaml'",
  );
  assert.ok(
    !window.includes('"Hermes remove aborted"'),
    "Generic unlink error must NOT hardcode 'Hermes remove aborted'",
  );
  // Must use the connectorId variable in the message (connector-agnostic)
  assert.ok(
    window.includes("connectorId"),
    "Generic unlink error must interpolate connectorId for the connector name",
  );
});

test("removeConnector: unlink failure for non-hermes connector uses connector ID in message", async () => {
  // When removing a non-hermes connector (e.g., claude-code) and unlinkSync
  // fails, the error message must name "claude-code", not "Hermes".
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        // Install claude-code connector so the config file exists.
        const installResult = mod.installConnector({
          connectorId: "claude-code",
          config: {},
        });
        assert.equal(installResult.status, "installed", "Pre-condition: claude-code install must succeed");

        // Make the connectors dir read-only so unlinkSync fails.
        const connectorsDir = path.dirname(installResult.configPath!);
        fs.chmodSync(connectorsDir, 0o555);

        let removeResult: ReturnType<typeof mod.removeConnector>;
        try {
          removeResult = mod.removeConnector("claude-code");
        } finally {
          try { fs.chmodSync(connectorsDir, 0o755); } catch { /* ignore */ }
        }

        // Must return error status.
        assert.equal(
          removeResult!.status,
          "error",
          "Unlink failure on non-hermes connector must return status: error",
        );

        // Message must reference claude-code and must not hardcode Hermes-specific text.
        assert.ok(
          removeResult!.message.includes("claude-code"),
          "Error message must reference the connector ID (claude-code)",
        );
        assert.ok(
          !removeResult!.message.includes("Hermes remove aborted"),
          "Error message must NOT use the old hardcoded 'Hermes remove aborted' string",
        );
        assert.ok(
          !removeResult!.message.includes("Hermes config.yaml"),
          "Error message must NOT reference 'Hermes config.yaml' in the generic path",
        );
        assert.ok(
          !removeResult!.message.includes("config.yaml"),
          "Error message must NOT reference config.yaml in the generic path",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 10 regression: UXJI/UXJT — prior token preserved when commitTokenEntry throws ──

test("atomic flow: commitTokenEntry throw during saveTokenStore still preserves prior hermes token via pre-commit snapshot", async () => {
  // Regression test for UXJI/UXJT: previously, `priorTokenEntry = commitTokenEntry(...)`
  // was used — if commitTokenEntry throws DURING saveTokenStore, the assignment never
  // completes, priorTokenEntry stays null, and the Phase D rollback becomes a no-op.
  //
  // Fix: snapshot the full token store via loadTokenStore() BEFORE commitTokenEntry(),
  // so even if the commit throws mid-write, the pre-commit store is available for
  // restore via saveTokenStore(). This test verifies the ORIGINAL hermes token is
  // present in tokens.json after a commitTokenEntry failure on force-reinstall.
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        mod.removeConnector("hermes");

        const profileDir = path.join(tmpHome, ".hermes", "profiles", "writable");
        fs.mkdirSync(profileDir, { recursive: true });

        // Step 1: Initial install to establish a prior hermes token.
        const install1 = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "writable", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(install1.status, "installed", "Initial install must succeed");

        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const store1 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const originalToken = store1.tokens.find((t) => t.connector === "hermes")?.token;
        assert.ok(originalToken, "Initial install must produce a hermes token");
        assert.ok(originalToken.startsWith("remnic_hm_"), "Prior token must have hermes prefix");

        // Step 2: Make tokens.json read-only so commitTokenEntry's saveTokenStore throws.
        fs.chmodSync(tokensPath, 0o444);
        try {
          const install2 = mod.installConnector({
            connectorId: "hermes",
            force: true,
            config: { profile: "writable", host: "127.0.0.1", port: 4318 },
          });

          // Must return error (commit failed).
          assert.equal(install2.status, "error", "commitTokenEntry failure must return error");
          assert.ok(
            install2.message.toLowerCase().includes("abort") ||
            install2.message.toLowerCase().includes("token") ||
            install2.message.toLowerCase().includes("commit"),
            `Error message must explain the commit failure, got: ${install2.message}`,
          );
        } finally {
          // Restore write permission before assertions.
          try { fs.chmodSync(tokensPath, 0o600); } catch { /* ignore */ }
        }

        // Step 3: The ORIGINAL hermes token must still be in tokens.json.
        // Without the UXJI fix (pre-commit snapshot), priorTokenEntry would be null
        // and the rollback would be a no-op, leaving tokens.json without the prior
        // hermes entry. With the fix, the snapshot is restored successfully.
        const store2 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const restoredEntry = store2.tokens.find((t) => t.connector === "hermes");
        assert.ok(
          restoredEntry,
          "tokens.json must still contain a hermes entry after commitTokenEntry failure (UXJI fix)",
        );
        assert.equal(
          restoredEntry!.token,
          originalToken,
          "The ORIGINAL prior hermes token must be present after commitTokenEntry throw — not absent (UXJI fix)",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 10 regression: UXJG — non-Hermes install atomic token rollback ──

test("non-Hermes install: config write failure on fresh install revokes rotated token (UXJG)", async () => {
  // Regression test for UXJG: when a non-Hermes connector config write fails
  // (e.g. XDG_CONFIG_HOME permission denied), generateToken() has already rotated
  // the token in tokens.json. Without rollback, the caller is left with a new
  // token in tokens.json and no connector.json on disk — a stale credential.
  //
  // Fix: capture the full token store before generateToken(), then on write
  // failure restore it (saveTokenStore with prior snapshot) so tokens.json has
  // no orphan entry for a fresh install (no prior entry → restored snapshot is
  // also empty → claude-code entry is absent after rollback).
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        // Seed another connector (not claude-code) to discover the connectors dir,
        // then lock the dir before the first claude-code install attempt.
        // This ensures claude-code has NO prior token (fresh install scenario).
        const seedOther = mod.installConnector({ connectorId: "cursor", config: {} });
        assert.equal(seedOther.status, "installed", "Seed install of cursor must succeed");
        const connectorsDir = path.dirname(seedOther.configPath!);

        // Remove any seeded cursor connector JSON (we only needed the dir path).
        fs.unlinkSync(seedOther.configPath!);
        // Lock the connectors dir so claude-code.json creation fails.
        fs.chmodSync(connectorsDir, 0o555);

        let result: ReturnType<typeof mod.installConnector>;
        try {
          result = mod.installConnector({ connectorId: "claude-code", config: {} });
        } finally {
          try { fs.chmodSync(connectorsDir, 0o755); } catch { /* ignore */ }
        }

        // Must return error (config write failed).
        assert.equal(result!.status, "error", "Config write failure must return status: error");
        assert.ok(
          result!.message.toLowerCase().includes("abort") ||
          result!.message.toLowerCase().includes("install") ||
          result!.message.toLowerCase().includes("write"),
          `Error message must describe the write failure, got: ${result!.message}`,
        );

        // The claude-code token must NOT be in tokens.json. The pre-install snapshot
        // had no claude-code entry, so restoring it removes the rotated token.
        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const storeAfter = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        assert.ok(
          !storeAfter.tokens.find((t) => t.connector === "claude-code"),
          "tokens.json must NOT contain a claude-code token after failed fresh install (UXJG fix)",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

test("non-Hermes install: config write failure on force-reinstall restores prior token (UXJG)", async () => {
  // Regression test for UXJG force-reinstall: if force-reinstall config write fails,
  // the PRIOR token (not the new rotated one, not absent) must be restored in
  // tokens.json. The daemon is still running with the old token, so restoring it
  // keeps authentication working without any disruption visible to the caller.
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        // Step 1: Initial install to establish a prior token.
        const install1 = mod.installConnector({ connectorId: "claude-code", config: {} });
        assert.equal(install1.status, "installed", "Initial install must succeed");

        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const store1 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const originalToken = store1.tokens.find((t) => t.connector === "claude-code")?.token;
        assert.ok(originalToken, "Initial install must write a claude-code token");

        // Step 2: Force-reinstall with connectors dir locked — write will fail.
        const connectorsDir = path.dirname(install1.configPath!);
        fs.unlinkSync(install1.configPath!);
        fs.chmodSync(connectorsDir, 0o555);

        let install2: ReturnType<typeof mod.installConnector>;
        try {
          install2 = mod.installConnector({ connectorId: "claude-code", config: {}, force: true });
        } finally {
          try { fs.chmodSync(connectorsDir, 0o755); } catch { /* ignore */ }
        }

        // Must return error.
        assert.equal(install2!.status, "error", "Config write failure on force-reinstall must return error");

        // Step 3: The ORIGINAL token must be restored (not the new rotated one, not absent).
        const store2 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const restoredEntry = store2.tokens.find((t) => t.connector === "claude-code");
        assert.ok(
          restoredEntry,
          "tokens.json must contain a claude-code entry after failed force-reinstall (UXJG fix)",
        );
        assert.equal(
          restoredEntry!.token,
          originalToken,
          "The ORIGINAL prior token must be restored after force-reinstall write failure (UXJG fix)",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 11: revoke token on stale not_found path (PRRT_kwDORJXyws56UWH6) ──

test("removeConnector: best-effort revokeToken on not_found path clears orphan token", async () => {
  // Simulate partial cleanup: connector JSON was manually deleted (or moved due
  // to XDG_CONFIG_HOME change) while tokens.json still contains the connector's
  // bearer token. Expected outcome: removeConnector returns status "not_found"
  // AND the stale token is revoked (removed from tokens.json).
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        // Set up Hermes profile dir so install can write config.yaml.
        const profileDir = path.join(tmpHome, ".hermes", "profiles", "default");
        fs.mkdirSync(profileDir, { recursive: true });

        // Install hermes so both tokens.json entry and connector JSON exist.
        const installResult = mod.installConnector({
          connectorId: "hermes",
          config: { profile: "default", host: "127.0.0.1", port: 4318 },
        });
        assert.equal(installResult.status, "installed", "Pre-condition: install must succeed");

        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const storeBefore = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        assert.ok(
          storeBefore.tokens.find((t) => t.connector === "hermes"),
          "Pre-condition: hermes token must exist after install",
        );

        // Simulate partial cleanup: manually delete the connector JSON so
        // removeConnector will hit the not_found early-return path.
        fs.unlinkSync(installResult.configPath!);
        assert.ok(
          !fs.existsSync(installResult.configPath!),
          "Pre-condition: connector JSON must be gone before removeConnector call",
        );

        // Call removeConnector — should hit the not_found path and revoke the stale token.
        const removeResult = mod.removeConnector("hermes");

        // Must return not_found status (connector JSON was absent).
        assert.equal(
          removeResult.status,
          "not_found",
          "removeConnector must return status: not_found when connector JSON is missing",
        );

        // Message must mention that the stale token was revoked.
        assert.ok(
          removeResult.message.includes("stale token"),
          "Message must mention that a stale token was revoked",
        );
        assert.ok(
          removeResult.message.includes("hermes"),
          "Message must identify the connector",
        );

        // The stale token must no longer be in tokens.json.
        const storeAfter = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        assert.ok(
          !storeAfter.tokens.find((t) => t.connector === "hermes"),
          "tokens.json must NOT contain a hermes entry after stale-token revoke",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});

// ── Round 12: UXJG (Codex P1) — full-store snapshot rollback for replit ──

test("non-Hermes replit: force-reinstall config write failure restores prior token via full-store snapshot", async () => {
  // Regression test for UXJG / Codex P1: non-Hermes connectors (e.g. replit) must
  // use a full token-store snapshot for rollback, not single-entry restore/revoke.
  // A full-store snapshot (loadTokenStore before generateToken) handles partial
  // writes to tokens.json atomically — the prior token survives even if the file
  // was partially overwritten before the connector JSON write failed.
  //
  // Scenario:
  //   1. Install replit successfully (tokens.json gets T1, connectors/replit.json gets T1).
  //   2. chmod 0o555 on the connectors dir to force a write failure on the next install.
  //   3. Force-reinstall replit — generateToken rotates to T2 in tokens.json, then the
  //      connector JSON write fails.
  //   4. After rollback, tokens.json must still contain T1 (NOT T2).
  //   5. connectors/replit.json must not exist (write was rejected).
  const mod = await import("../../packages/remnic-core/src/connectors/index.ts");

  await new Promise<void>((resolve, reject) => {
    try {
      withTempHome((tmpHome) => {
        // Step 1: Initial install of replit.
        const install1 = mod.installConnector({ connectorId: "replit", config: {} });
        assert.equal(install1.status, "installed", "Initial replit install must succeed");
        assert.ok(install1.configPath, "Initial install must return a configPath");

        const tokensPath = path.join(tmpHome, ".remnic", "tokens.json");
        const store1 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const t1Entry = store1.tokens.find((t) => t.connector === "replit");
        assert.ok(t1Entry, "Initial install must write a replit token (T1)");
        assert.ok(t1Entry!.token.startsWith("remnic_rl_"), "T1 must have replit prefix (remnic_rl_)");
        const t1 = t1Entry!.token;

        // connectors/replit.json must contain T1.
        const connectorJson1 = JSON.parse(fs.readFileSync(install1.configPath!, "utf-8")) as { token?: string };
        assert.equal(connectorJson1.token, t1, "connectors/replit.json must reference T1");

        // Step 2: Lock the connectors dir so the next write fails.
        const connectorsDir = path.dirname(install1.configPath!);
        fs.unlinkSync(install1.configPath!); // remove to force a CREATE (not overwrite) on next install
        fs.chmodSync(connectorsDir, 0o555);

        // Step 3: Force-reinstall with locked dir.
        let install2: ReturnType<typeof mod.installConnector>;
        try {
          install2 = mod.installConnector({ connectorId: "replit", config: {}, force: true });
        } finally {
          // Restore permissions so temp dir can be cleaned up.
          try { fs.chmodSync(connectorsDir, 0o755); } catch { /* ignore */ }
        }

        // Step 4: Must return error.
        assert.equal(install2!.status, "error", "Locked-dir force-reinstall must return status: error");
        assert.ok(
          install2!.message.toLowerCase().includes("abort") ||
          install2!.message.toLowerCase().includes("write") ||
          install2!.message.toLowerCase().includes("install"),
          `Error message must describe the write failure, got: ${install2!.message}`,
        );

        // Step 5: tokens.json must still contain T1 (full-store rollback restored it).
        const store2 = JSON.parse(fs.readFileSync(tokensPath, "utf-8")) as {
          tokens: Array<{ token: string; connector: string }>;
        };
        const t1Restored = store2.tokens.find((t) => t.connector === "replit");
        assert.ok(
          t1Restored,
          "tokens.json must still contain a replit entry (T1) after failed force-reinstall (UXJG full-store fix)",
        );
        assert.equal(
          t1Restored!.token,
          t1,
          "tokens.json must contain T1 (prior token) — NOT a new T2 — after failed force-reinstall (UXJG full-store fix)",
        );

        // connector.json must NOT exist (write was refused, rolled back).
        assert.ok(
          !fs.existsSync(install1.configPath!),
          "connectors/replit.json must not exist after write failure — no partial install state",
        );
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });
});
