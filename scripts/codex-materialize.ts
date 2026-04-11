#!/usr/bin/env tsx
/**
 * codex-materialize.ts — thin CLI entrypoint for Codex memory materialization.
 *
 * Intended caller: `packages/plugin-codex/hooks/bin/session-end.sh` (via tsx)
 * and operators debugging materialization. Keeps the hook edit minimal — the
 * shell hook just shells out to this script with a namespace.
 *
 * Usage:
 *   tsx scripts/codex-materialize.ts [--namespace <name>] [--codex-home <path>] \
 *     [--memory-dir <path>] [--reason <string>] [--json]
 *
 * Exits 0 on success (including intentional no-op skips), non-zero only on
 * hard failures the caller needs to notice.
 */

import path from "node:path";
import fs from "node:fs";

import { parseConfig } from "../packages/remnic-core/src/config.js";
import { runCodexMaterialize } from "../packages/remnic-core/src/connectors/codex-materialize-runner.js";

interface Args {
  namespace?: string;
  codexHome?: string;
  memoryDir?: string;
  reason: "session_end" | "manual" | "cli" | "consolidation";
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
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
        args.reason = (argv[++i] as Args["reason"]) ?? "cli";
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

function loadRawConfig(): Record<string, unknown> {
  // Try the common config locations without importing bootstrap.ts (which
  // pulls in the full orchestrator). A missing config is fine — parseConfig
  // produces sane defaults.
  const home = process.env.HOME ?? "";
  const candidates = [
    process.env.REMNIC_CONFIG,
    path.join(home, ".config", "remnic", "config.json"),
    path.join(home, ".config", "engram", "config.json"),
    path.join(home, ".remnic", "config.json"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    } catch {
      // fall through to next candidate
    }
  }
  return {};
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(
      [
        "codex-materialize — render Remnic memories into ~/.codex/memories/",
        "",
        "Usage: tsx scripts/codex-materialize.ts [options]",
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
    return 0;
  }

  const rawConfig = loadRawConfig();
  const config = parseConfig(rawConfig);
  if (args.memoryDir) {
    // parseConfig already locked in a memoryDir, but the CLI override wins.
    (config as unknown as Record<string, unknown>).memoryDir = args.memoryDir;
  }

  const result = await runCodexMaterialize({
    config,
    namespace: args.namespace,
    memoryDir: args.memoryDir,
    codexHome: args.codexHome,
    reason: args.reason,
  });

  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  } else if (result === null) {
    // eslint-disable-next-line no-console
    console.log("codex-materialize: skipped (disabled or guarded)");
  } else if (result.skippedNoSentinel) {
    // eslint-disable-next-line no-console
    console.log(
      `codex-materialize: sentinel missing in ${result.memoriesDir}; skipped to honor hand-edits`,
    );
  } else if (result.skippedIdempotent) {
    // eslint-disable-next-line no-console
    console.log(
      `codex-materialize: no changes for namespace=${result.namespace} (hash unchanged)`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `codex-materialize: wrote ${result.filesWritten.length} file(s) for namespace=${result.namespace}`,
    );
  }

  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    // eslint-disable-next-line no-console
    console.error(
      `codex-materialize failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);
