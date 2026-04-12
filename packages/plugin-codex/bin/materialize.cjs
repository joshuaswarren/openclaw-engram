#!/usr/bin/env node
/**
 * @remnic/plugin-codex materialize binary.
 *
 * This is the packaged runtime entrypoint the session-end hook calls when a
 * user runs Remnic inside a published install. The hook used to shell out
 * to `scripts/codex-materialize.ts` via tsx, but that file is NOT shipped in
 * any published package payload — only developer source checkouts have it.
 * See PR #392 review thread PRRT_kwDORJXyws56TOVo.
 *
 * This wrapper:
 *  1. Loads the published `@remnic/core` ESM bundle via dynamic import.
 *  2. Re-parses argv in the same shape `scripts/codex-materialize.ts` uses
 *     (`--namespace`, `--codex-home`, `--memory-dir`, `--reason`, `--json`).
 *  3. Resolves the user's OpenClaw/Remnic config from the same search paths
 *     the dev script uses, so behavior is identical between dev and
 *     distributed installs.
 *  4. Delegates to `runCodexMaterialize` and surfaces the result.
 *
 * Exits 0 on success (including intentional skips), non-zero only on hard
 * failures callers actually need to notice.
 */

/* eslint-disable no-console */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

function parseArgs(argv) {
  const args = {
    namespace: undefined,
    codexHome: undefined,
    memoryDir: undefined,
    reason: "cli",
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--namespace":
      case "-n":
        args.namespace = argv[++i];
        break;
      case "--codex-home":
        args.codexHome = argv[++i];
        break;
      case "--memory-dir":
        args.memoryDir = argv[++i];
        break;
      case "--reason":
        args.reason = argv[++i] || "cli";
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        // ignore unknown tokens — keeps the hook loosely coupled
        break;
    }
  }
  return args;
}

/**
 * Return candidate config file paths to search, in priority order.
 * The caller is responsible for parsing and entry-resolution.
 */
function configCandidates() {
  const home = process.env.HOME || "";
  const openclawConfigPath =
    process.env.OPENCLAW_ENGRAM_CONFIG_PATH ||
    process.env.OPENCLAW_CONFIG_PATH ||
    path.join(home, ".openclaw", "openclaw.json");
  return [
    process.env.REMNIC_CONFIG,
    openclawConfigPath,
    path.join(home, ".config", "remnic", "config.json"),
    path.join(home, ".config", "engram", "config.json"),
    path.join(home, ".remnic", "config.json"),
  ].filter((p) => typeof p === "string" && p.length > 0);
}

/**
 * Load the Remnic plugin config block from the first matching config file.
 *
 * Entry resolution is delegated to `resolveRemnicPluginEntry` from
 * `@remnic/core` so the slot → PLUGIN_ID → LEGACY_PLUGIN_ID logic lives
 * in exactly one place across all five config-loader sites (#403).
 *
 * @param {Function} resolveEntry - resolveRemnicPluginEntry from @remnic/core
 */
function loadRawConfig(resolveEntry) {
  for (const candidate of configCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      if (!raw || typeof raw !== "object") continue;
      // Try the structured OpenClaw config layout first (plugins.entries).
      // resolveEntry returns the full plugin entry (including .config).
      const entry = resolveEntry(raw);
      if (entry && typeof entry === "object") {
        return entry.config && typeof entry.config === "object"
          ? entry.config
          : entry;
      }
      // Legacy / developer config layout: the top-level object IS the config.
      // Honour it as long as it has no `plugins` subtree (so we don't
      // accidentally treat a complete OpenClaw config with an unknown plugin
      // slot as a flat Remnic config).
      if (!raw.plugins) {
        return raw;
      }
      // OpenClaw config but no Remnic entry found — skip to next candidate.
    } catch (_err) {
      // fall through to next candidate
    }
  }
  return {};
}

function printHelp() {
  console.log(
    [
      "codex-materialize — render Remnic memories into ~/.codex/memories/",
      "",
      "Usage: node bin/materialize.cjs [options]",
      "",
      "Options:",
      "  --namespace <name>    Namespace to materialize (default: config / 'default')",
      "  --memory-dir <path>   Override memory directory",
      "  --codex-home <path>   Override <codex_home>",
      "  --reason <string>     Logged reason tag (cli | session_end | consolidation | manual)",
      "  --json                Emit the result as JSON",
      "  -h, --help            Show this help",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  // Dynamic import because @remnic/core is ESM-only.
  const core = await import("@remnic/core");
  const { parseConfig, runCodexMaterialize, resolveRemnicPluginEntry } = core;
  if (
    typeof parseConfig !== "function" ||
    typeof runCodexMaterialize !== "function" ||
    typeof resolveRemnicPluginEntry !== "function"
  ) {
    throw new Error(
      "codex-materialize: @remnic/core is missing expected exports (parseConfig, runCodexMaterialize, resolveRemnicPluginEntry)",
    );
  }

  // Pass the shared resolver so loadRawConfig uses the same slot → id lookup
  // logic as all other config-loader sites (#403).
  const rawConfig = loadRawConfig(resolveRemnicPluginEntry);
  const config = parseConfig(rawConfig);
  if (args.memoryDir) {
    // parseConfig already locked in a memoryDir, but the CLI override wins.
    config.memoryDir = args.memoryDir;
  }

  const result = await runCodexMaterialize({
    config,
    namespace: args.namespace,
    memoryDir: args.memoryDir,
    codexHome: args.codexHome,
    reason: args.reason,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result === null) {
    console.log("codex-materialize: skipped (disabled or guarded)");
  } else if (result.skippedNoSentinel) {
    console.log(
      `codex-materialize: sentinel missing in ${result.memoriesDir}; skipped to honor hand-edits`,
    );
  } else if (result.skippedIdempotent) {
    console.log(
      `codex-materialize: no changes for namespace=${result.namespace} (hash unchanged)`,
    );
  } else {
    console.log(
      `codex-materialize: wrote ${result.filesWritten.length} file(s) for namespace=${result.namespace}`,
    );
  }

  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(
      `codex-materialize failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);
