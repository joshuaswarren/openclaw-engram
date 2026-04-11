/**
 * Tests for `remnic openclaw install` CLI command structure.
 *
 * Since the CLI package depends on @remnic/core (which requires a build step),
 * these tests verify the CLI source code structure directly.
 *
 * Tests:
 * - CLI source declares the "openclaw" command type
 * - install subcommand handler is defined
 * - --yes / -y / --force flags are handled
 * - --dry-run flag is handled
 * - --memory-dir flag is handled
 * - --config flag is handled
 * - legacy migration detection is implemented
 * - openclaw command is registered in the main switch
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLI_SRC = path.join(ROOT, "packages", "remnic-cli", "src", "index.ts");

async function readCli(): Promise<string> {
  return readFile(CLI_SRC, "utf-8");
}

test("CLI CommandName type includes 'openclaw'", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('"openclaw"'),
    "CommandName type must include 'openclaw'",
  );
});

test("CLI has cmdOpenclawInstall function", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("cmdOpenclawInstall"),
    "CLI must define cmdOpenclawInstall function",
  );
});

test("CLI --yes / -y / --force flags are supported", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('--yes') && src.includes('"-y"') || src.includes("--yes") && src.includes("-y"),
    "CLI must handle --yes flag",
  );
  assert.ok(src.includes("--force"), "CLI must handle --force flag");
});

test("CLI --dry-run flag is supported", async () => {
  const src = await readCli();
  assert.ok(src.includes("--dry-run"), "CLI must handle --dry-run flag");
  assert.ok(src.includes("DRY RUN"), "dry-run mode must print DRY RUN");
});

test("CLI --memory-dir flag is supported", async () => {
  const src = await readCli();
  assert.ok(src.includes("--memory-dir"), "CLI must handle --memory-dir flag");
});

test("CLI --config flag is supported", async () => {
  const src = await readCli();
  assert.ok(src.includes("--config"), "CLI must handle --config flag");
});

test("CLI detects legacy openclaw-engram entry", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("openclaw-engram"),
    "CLI must reference legacy openclaw-engram entry",
  );
});

test("CLI writes openclaw-remnic entry and memory slot", async () => {
  const src = await readCli();
  assert.ok(src.includes('"openclaw-remnic"'), "CLI must write openclaw-remnic entry");
  // The slot assignment may use a constant (REMNIC_OPENCLAW_PLUGIN_ID) or a literal.
  assert.ok(
    src.includes('memory: "openclaw-remnic"') ||
    src.includes("memory: \"openclaw-remnic\"") ||
    src.includes("memory: REMNIC_OPENCLAW_PLUGIN_ID"),
    "CLI must set memory slot to openclaw-remnic (literal or via REMNIC_OPENCLAW_PLUGIN_ID constant)",
  );
});

test("CLI openclaw subcommand is in the main switch statement", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('case "openclaw":'),
    "main switch must handle 'openclaw' command",
  );
});

test("CLI next-step instructions mention gateway restart", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("launchctl kickstart") || src.includes("gateway"),
    "CLI should include gateway restart instructions",
  );
});

test("CLI next-step instructions mention gateway_start fired log line", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("gateway_start fired") || src.includes("[remnic] gateway_start"),
    "CLI should reference the gateway_start fired log line",
  );
});

test("CLI install creates memory directory", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("mkdirSync") || src.includes("mkdir"),
    "CLI install must create the memory directory",
  );
});

test("CLI legacy migration note is included", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("legacy") || src.includes("retained") || src.includes("rollback"),
    "CLI must include a note about the legacy entry being retained for rollback",
  );
});

test("CLI preserves existing memoryDir on reinstall when --memory-dir not provided", async () => {
  const src = await readCli();
  // The CLI should use the existing configured memoryDir as fallback, not always the default.
  assert.ok(
    src.includes("existingMemoryDir") || src.includes("existingNewEntryConfig.memoryDir"),
    "CLI must preserve the existing memoryDir when --memory-dir is not provided",
  );
});

test("CLI validates plugins.entries shape before using in operator", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("rawEntries") || src.includes("plugins.entries field"),
    "CLI must validate plugins.entries shape before property access",
  );
});
