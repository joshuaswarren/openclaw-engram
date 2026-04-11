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
 * Pull out the Remnic plugin config block from an OpenClaw-shaped or
 * legacy-Remnic-shaped raw config object.
 *
 * OpenClaw stores Remnic settings under
 * `plugins.entries["<id>"].config` where <id> is determined by:
 *   1. `plugins.slots.memory` (the operator-configured active entry)
 *   2. "openclaw-remnic" (the canonical id after the 1/2 rename PR)
 *   3. "openclaw-engram" (the legacy id, kept for backward compat)
 *
 * The legacy Remnic/Engram layouts kept settings at the top level.
 */
function unwrapOpenClawEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const plugins = raw.plugins && typeof raw.plugins === "object" ? raw.plugins : undefined;
  const entry = plugins && plugins.entries && typeof plugins.entries === "object"
    ? plugins.entries
    : undefined;
  if (entry) {
    // Honour the operator's configured memory slot first, but only when it
    // points to a known Remnic plugin id so mixed-plugin installs don't
    // accidentally unwrap a different plugin's config into Remnic.
    const rawSlot =
      plugins.slots && typeof plugins.slots === "object"
        ? plugins.slots.memory
        : undefined;
    const KNOWN_IDS = ["openclaw-remnic", "openclaw-engram"];
    const activeId =
      typeof rawSlot === "string" && KNOWN_IDS.includes(rawSlot)
        ? rawSlot
        : undefined;
    const candidateIds = [
      activeId,
      "openclaw-remnic",
      "openclaw-engram",
    ].filter((id) => typeof id === "string" && id !== undefined && id.length > 0);
    for (const id of candidateIds) {
      const pluginConfig = entry[id] && entry[id].config;
      if (pluginConfig && typeof pluginConfig === "object") {
        return pluginConfig;
      }
    }
  }
  // Legacy / developer config layout — the top-level object IS the config.
  return raw;
}

function loadRawConfig() {
  const home = process.env.HOME || "";
  const openclawConfigPath =
    process.env.OPENCLAW_ENGRAM_CONFIG_PATH ||
    process.env.OPENCLAW_CONFIG_PATH ||
    path.join(home, ".openclaw", "openclaw.json");
  const candidates = [
    process.env.REMNIC_CONFIG,
    openclawConfigPath,
    path.join(home, ".config", "remnic", "config.json"),
    path.join(home, ".config", "engram", "config.json"),
    path.join(home, ".remnic", "config.json"),
  ].filter((p) => typeof p === "string" && p.length > 0);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      const unwrapped = unwrapOpenClawEntry(raw);
      if (unwrapped) return unwrapped;
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
  const { parseConfig, runCodexMaterialize } = core;
  if (typeof parseConfig !== "function" || typeof runCodexMaterialize !== "function") {
    throw new Error(
      "codex-materialize: @remnic/core is missing expected exports (parseConfig, runCodexMaterialize)",
    );
  }

  const rawConfig = loadRawConfig();
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
