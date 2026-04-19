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

test("CLI has cmdOpenclawUpgrade function", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("cmdOpenclawUpgrade"),
    "CLI must define cmdOpenclawUpgrade function",
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

test("CLI wires openclaw upgrade subcommand", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('subcommand === "upgrade"') ||
    src.includes("case \"upgrade\"") ||
    src.includes("cmdOpenclawUpgrade"),
    "CLI must handle `remnic openclaw upgrade`",
  );
});

test("CLI openclaw upgrade supports release and restart flags", async () => {
  const src = await readCli();
  assert.ok(src.includes("--version"), "CLI upgrade must handle --version");
  assert.ok(
    src.includes("--no-restart") || src.includes("restartGateway"),
    "CLI upgrade must handle restart control",
  );
});

test("CLI openclaw upgrade rejects missing values for value-bearing flags", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('resolveRequiredValueFlag(args, "--version")'),
    "CLI upgrade must reject bare --version flags instead of defaulting",
  );
  assert.ok(
    src.includes('resolveRequiredValueFlag(args, "--plugin-dir")'),
    "CLI upgrade must reject bare --plugin-dir flags",
  );
});

test("CLI openclaw upgrade mentions backups and npm package refresh", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("backup") || src.includes("backups"),
    "CLI upgrade must mention backups",
  );
  assert.ok(
    src.includes("npm pack") || src.includes("@remnic/plugin-openclaw"),
    "CLI upgrade must mention the published npm package",
  );
});

test("CLI openclaw upgrade rolls back if the published plugin install fails after swap", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("PublishedOpenclawPluginInstallError"),
    "CLI upgrade must track plugin install failures that happen after the staged swap",
  );
  assert.ok(
    src.includes("let installResult") &&
      src.includes("installResult = installPublishedOpenclawPlugin(packageSpec, pluginDir)"),
    "CLI upgrade must assign the published plugin install inside the rollback try/catch",
  );
  assert.ok(
    /installError instanceof PublishedOpenclawPluginInstallError[\s\S]*\? installError\.rollbackDir[\s\S]*rollbackDir,\s*\n\s*\}\);/s.test(src),
    "CLI upgrade must reuse rollbackDir from install failures that occur before installResult is assigned",
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

test("CLI ignores foreign slots.memory values when preserving the current OpenClaw memoryDir", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("slots.memory === REMNIC_OPENCLAW_PLUGIN_ID") &&
      src.includes("slots.memory === REMNIC_OPENCLAW_LEGACY_PLUGIN_ID"),
    "CLI must only trust recognized OpenClaw plugin ids when reading slots.memory",
  );
});

test("CLI validates plugins.entries shape before using in operator", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("rawEntries") || src.includes("plugins.entries field"),
    "CLI must validate plugins.entries shape before property access",
  );
});

test("CLI expands tilde in memoryDir paths", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("expandTilde"),
    "CLI must expand tilde (~) in memoryDir paths before path.resolve",
  );
});

test("CLI preserves slot when operator declines migration", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("slotIsActiveLegacy") || src.includes("shouldSwitchSlot"),
    "CLI must conditionally switch slot based on migration consent",
  );
});

test("CLI uses resolveFlagStrict for --memory-dir and --config to reject flag-like values", async () => {
  const src = await readCli();
  assert.ok(
    src.includes("resolveFlagStrict"),
    "CLI must use resolveFlagStrict for value-bearing flags in openclaw install",
  );
});

test("CLI lazy-loads bench and training-export runtime packages", async () => {
  const src = await readCli();
  assert.ok(
    src.includes('import("@remnic/export-weclone")') &&
      src.includes("ensureTrainingExportRuntimeLoaded"),
    "CLI must lazy-load training export runtime dependencies",
  );
  assert.ok(
    src.includes('import("@remnic/bench")') &&
      src.includes("ensureBenchRuntimeLoaded"),
    "CLI must lazy-load bench runtime dependencies",
  );
});
