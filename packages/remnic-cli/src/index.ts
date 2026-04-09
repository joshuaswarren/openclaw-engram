/**
 * @remnic/cli
 *
 * Command-line interface for Remnic memory.
 *
 * Commands:
 *   init              Create remnic.config.json in the current directory
 *   status            Show server/daemon status
 *   query <text>      Query memories
 *   doctor            Run diagnostics
 *   config            Show current config
 *   daemon start      Start background server
 *   daemon stop       Stop background server
 *   daemon restart    Restart background server
 *   daemon install    Install as system service (launchd/systemd)
 *   daemon uninstall  Remove system service
 *   daemon status     Show daemon status
 *   token generate    Generate auth token for a connector
 *   token list        List all auth tokens
 *   token revoke      Revoke auth token for a connector
 *   tree              Generate context tree
 *   onboard [dir]     Onboard project directory
 *   curate <path>     Curate files into memory
 *   review            Review inbox management
 *   sync              Diff-aware sync
 *   dedup             Find duplicate memories
 *   connectors        Manage host adapters
 */

import fs from "node:fs";
import path from "node:path";
import * as childProcess from "node:child_process";
import {
  parseConfig,
  Orchestrator,
  EngramAccessService,
  initLogger,
  onboard,
  curate,
  listReviewItems,
  performReview,
  syncChanges,
  watchForChanges,
  findDuplicates,
  listConnectors,
  installConnector,
  removeConnector,
  doctorConnector,
  generateToken,
  listTokens,
  revokeToken,
  listSpaces,
  getActiveSpace,
  createSpace,
  deleteSpace,
  switchSpace,
  pushToSpace,
  pullFromSpace,
  shareSpace,
  promoteSpace,
  getAuditLog,
  getManifestPath,
  generateContextTree,
  migrateFromEngram,
  rollbackFromEngramMigration,
} from "@remnic/core";
import {
  runBenchSuite,
  runExplain,
  loadBaseline,
  saveBaseline,
  checkRegression,
  type BenchConfig,
} from "@remnic/bench";
import { firstSuccessfulCandidate, firstSuccessfulResult } from "./service-candidates.js";

// ── Types ────────────────────────────────────────────────────────────────────

type CommandName =
  | "init"
  | "migrate"
  | "status"
  | "query"
  | "doctor"
  | "config"
  | "daemon"
  | "token"
  | "tree"
  | "onboard"
  | "curate"
  | "review"
  | "sync"
  | "dedup"
  | "connectors"
  | "space"
  | "benchmark";

type DaemonAction = "start" | "stop" | "restart" | "install" | "uninstall" | "status";
type TokenAction = "generate" | "list" | "revoke";
type ReviewAction = "approve" | "dismiss" | "flag";

// ── Constants ────────────────────────────────────────────────────────────────

function readCompatEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~";
}

const PID_DIR = path.join(resolveHomeDir(), ".remnic");
const LEGACY_PID_DIR = path.join(resolveHomeDir(), ".engram");
const PID_FILE = path.join(PID_DIR, "server.pid");
const LEGACY_PID_FILE = path.join(LEGACY_PID_DIR, "server.pid");
const LOG_FILE = path.join(PID_DIR, "server.log");
const LEGACY_LOG_FILE = path.join(LEGACY_PID_DIR, "server.log");

// ── Config helpers ───────────────────────────────────────────────────────────

function resolveConfigPath(cliPath?: string): string {
  if (cliPath) return path.resolve(cliPath);
  const envPath = readCompatEnv("REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH");
  if (envPath) return path.resolve(envPath);

  const candidates = [
    path.join(process.cwd(), "remnic.config.json"),
    path.join(process.cwd(), "engram.config.json"),
    path.join(resolveHomeDir(), ".config", "remnic", "config.json"),
    path.join(resolveHomeDir(), ".config", "engram", "config.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(resolveHomeDir(), ".config", "remnic", "config.json");
}

function resolveMemoryDir(): string {
  // Priority: env var > config file > auto-detect
  const configMemoryDir = (() => {
    // Env var takes top priority (deployment override)
    const envMemoryDir = readCompatEnv("REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR");
    if (envMemoryDir) return envMemoryDir;
    // Then config file
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    const remnicCfg = raw.remnic ?? raw.engram ?? raw;
    if (remnicCfg.memoryDir) return remnicCfg.memoryDir;
    // Auto-detect: prefer standalone path if it exists, fall back to OpenClaw
    const home = resolveHomeDir();
    const standalonePath = path.join(home, ".remnic", "memory");
    const legacyStandalonePath = path.join(home, ".engram", "memory");
    const openclawPath = path.join(home, ".openclaw", "workspace", "memory", "local");
    if (fs.existsSync(standalonePath)) return standalonePath;
    if (fs.existsSync(legacyStandalonePath)) return legacyStandalonePath;
    return openclawPath;
  })();

  // Check active space — only if manifest exists (don't bootstrap just to resolve)
  const manifestPath = getManifestPath();
  if (fs.existsSync(manifestPath)) {
    try {
      const active = getActiveSpace();
      if (active?.memoryDir) {
        if (!fs.existsSync(active.memoryDir)) {
          // Recreate missing directory instead of silently falling back
          fs.mkdirSync(active.memoryDir, { recursive: true });
        }
        return active.memoryDir;
      }
      // No active space with memoryDir — fall through to config
    } catch (err: unknown) {
      // getActiveSpace() throws "Active space ... not found" when the activeSpaceId
      // references a space that was deleted — this is recoverable, fall through.
      // Any other error (corrupted JSON, permission denied) is fatal.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("not found")) {
        console.error(`Error: failed to resolve active space from ${manifestPath}: ${msg}`);
        process.exit(1);
      }
      // Active space not found — fall through to config-based dir
    }
  }

  return configMemoryDir;
}

function resolveFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function parseConnectorConfig(args: string[]): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const arg of args) {
    if (arg.startsWith("--config=")) {
      const [key, value] = arg.slice("--config=".length).split("=");
      if (key && value) config[key] = value;
    }
  }
  return config;
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdInit(): void {
  const configPath = path.join(process.cwd(), "remnic.config.json");
  if (fs.existsSync(configPath)) {
    console.log(`Config already exists: ${configPath}`);
    return;
  }

  const template: Record<string, unknown> = {
    remnic: {
      openaiApiKey: "${OPENAI_API_KEY}",
      memoryDir: path.join(process.cwd(), ".remnic", "memory"),
      memoryOsPreset: "balanced",
    },
    server: {
      host: "127.0.0.1",
      port: 4318,
      authToken: "${REMNIC_AUTH_TOKEN}",
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n");
  console.log(`Created ${configPath}`);
  console.log("\nSet these environment variables:");
  console.log("  export OPENAI_API_KEY=sk-...");
  console.log("  export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)");
  console.log("  # ENGRAM_AUTH_TOKEN is still accepted during v1.x");
  console.log("\nThen start the server:");
  console.log("  npx remnic-server");
}

async function cmdStatus(json: boolean): Promise<void> {
  const { running, pid } = isServiceRunning();
  if (json) {
    console.log(JSON.stringify({ running, pid: pid ?? null, pidFile: PID_FILE, logFile: LOG_FILE }));
    return;
  }
  if (!running) {
    console.log("Remnic server: stopped");
    return;
  }
  console.log(`Remnic server: running${pid ? ` (pid ${pid})` : ""}`);

  const port = inferPort();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/engram/v1/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      console.log(`Health: server responded with ${response.status} ${response.statusText}`);
    } else {
      const health = await response.json();
      console.log(`Health: ${health.status ?? "ok"}`);
    }
  } catch {
    console.log("Health: unable to reach server");
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cmdQuery(queryText: string, json: boolean, explain: boolean): Promise<void> {
  if (!queryText) {
    console.error("Usage: remnic query <text>");
    process.exit(1);
  }

  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  const service = new EngramAccessService(orchestrator);

  if (explain) {
    const result = await runExplain(service, queryText);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Query: ${result.query}`);
      console.log(`Tiers used: ${result.tiersUsed.join(" → ")}`);
      console.log(`Total duration: ${result.totalDurationMs}ms`);
      for (const t of result.tierResults) {
        console.log(`  ${t.tier}: ${t.latencyMs}ms (${t.resultsCount} results)`);
      }
    }
    return;
  }

  const result = await service.recall({ query: queryText, mode: "auto" });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const memories = (result as { memories?: Array<{ content: string }> }).memories ?? [];
    if (memories.length === 0) {
      console.log("No results.");
      return;
    }
    for (const m of memories) {
      console.log(`- ${m.content}`);
    }
  }
}

function cmdDoctor(): void {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  checks.push({
    name: "Node.js version",
    ok: nodeMajor >= 22,
    detail: `${nodeVersion} (requires >= 22.12.0)`,
  });

  const configPath = resolveConfigPath();
  const configExists = fs.existsSync(configPath);
  checks.push({ name: "Config file", ok: configExists, detail: configPath });

  const hasApiKey = !!process.env.OPENAI_API_KEY;
  checks.push({
    name: "OPENAI_API_KEY",
    ok: hasApiKey,
    detail: hasApiKey ? "set" : "not set (extraction will not work)",
  });

  const memoryDir = resolveMemoryDir();
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    checks.push({ name: "Memory directory", ok: true, detail: memoryDir });
  } catch {
    checks.push({ name: "Memory directory", ok: false, detail: `cannot create ${memoryDir}` });
  }

  const svcState = isServiceRunning();
  checks.push({
    name: "Server daemon",
    ok: svcState.running,
    detail: svcState.running ? `running${svcState.pid ? ` (pid ${svcState.pid})` : ""}` : "stopped",
  });

  for (const check of checks) {
    const icon = check.ok ? "✓" : "✗";
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
  }
}

function cmdConfig(): void {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    console.log("No config file found. Run `remnic init` to create one.");
    return;
  }
  console.log(`Config: ${configPath}`);
  const rawConfig = fs.readFileSync(configPath, "utf8");
  const redacted = rawConfig.replace(
    /("(?:openaiApiKey|localLlmApiKey|authToken|apiKey|remoteSearchApiKey|meilisearchApiKey|opikApiKey)"\s*:\s*")([^"]*)(")/g,
    '$1[REDACTED]$3',
  );
  console.log(redacted);
}

async function cmdMigrate(json: boolean, rollback: boolean): Promise<void> {
  if (rollback) {
    const result = await rollbackFromEngramMigration({ quiet: json });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.restored.length === 0 && result.removed.length === 0) {
      console.log("No migration rollback state found.");
      return;
    }
    console.log("Rollback complete.");
    if (result.restored.length > 0) {
      console.log(`  Restored: ${result.restored.length}`);
    }
    if (result.removed.length > 0) {
      console.log(`  Removed: ${result.removed.length}`);
    }
    return;
  }

  const result = await migrateFromEngram({ quiet: json });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "fresh-install") {
    console.log("No Engram install found. Nothing to migrate.");
    return;
  }
  if (result.status === "already-migrated") {
    console.log("Migration already completed.");
    return;
  }
  console.log("Migration complete.");
  console.log(`  Copied: ${result.copied.length}`);
  console.log(`  Tokens rewritten: ${result.tokensRegenerated}`);
  console.log(`  Services updated: ${result.servicesReinstalled.length}`);
  console.log(`  Rollback: ${result.rollbackCommand}`);
}

// ── M4 commands ──────────────────────────────────────────────────────────────

function cmdOnboard(dirPath: string, json: boolean): void {
  const directory = path.resolve(dirPath || process.cwd());
  const result = onboard({ directory });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Shape: ${result.shape}`);
  console.log(`Languages: ${result.languages.map((l) => `${l.language} (${(l.confidence * 100).toFixed(0)}%)`).join(", ")}`);
  console.log(`Docs: ${result.docs.length} file(s)`);
  console.log(result.docs.map((s) => `  ${s.kind} (${s.size} bytes)`).join("\n"));
  console.log(`Plan: ${result.plan.priorityFiles.length} priority, ${result.plan.estimatedFiles} total files`);
  console.log(`\nSuggested namespace: ${result.plan.suggestedNamespace}`);
  console.log(`Total files: ${result.totalFiles}`);
  console.log(`Duration: ${result.durationMs}ms`);
}

async function cmdCurate(targetPath: string, json: boolean): Promise<void> {
  const memoryDir = resolveMemoryDir();
  const result = await curate({
    targetPath: path.resolve(targetPath),
    memoryDir,
    source: "curation",
    checkDuplicates: true,
    checkContradictions: true,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Files: ${result.filesProcessed} processed, ${result.filesSkipped} skipped`);
  console.log(`Statements: ${result.statements.length}`);
  if (result.duplicates.length > 0) console.log(`Duplicates: ${result.duplicates.length}`);
  if (result.contradictions.length > 0) console.log(`Contradictions: ${result.contradictions.length}`);
  console.log(`Written: ${result.written.length}`);
  console.log(`Duration: ${result.durationMs}ms`);
}

function cmdReview(action: string, rest: string[]): void {
  const memoryDir = resolveMemoryDir();
  if (action === "list") {
    const result = listReviewItems({ memoryDir });
    if (result.items.length === 0) {
      console.log("No items pending review.");
      return;
    }
    for (const item of result.items) {
      console.log(`[${item.reviewReason}] ${item.id} ${item.content.slice(0, 80)}${item.content.length > 80 ? "..." : ""}`);
      console.log(`  Confidence: ${item.confidence} | Category: ${item.category}`);
      console.log(`  Source: ${item.source} | Created: ${item.created}`);
    }
    return;
  }

  if (action === "approve" || action === "dismiss" || action === "flag") {
    const id = rest[0];
    if (!id) {
      console.error("Usage: remnic review <approve|dismiss|flag> <id>");
      process.exit(1);
    }
    const result = performReview(memoryDir, id, action as ReviewAction);
    console.log(result.message);
  } else {
    console.log("Usage: remnic review <list|approve|dismiss|flag> [id]");
    process.exit(1);
  }
}

function cmdSync(action: string, rest: string[], json: boolean): void {
  // Extract --source before positional args so that rest args can override it
  const sourceIdx = rest.indexOf("--source");
  const sourceDir = sourceIdx >= 0 && rest[sourceIdx + 1] ? rest[sourceIdx + 1] : ".";
  const memoryDir = resolveMemoryDir();

  if (action === "run") {
    const result = syncChanges({ sourceDir, memoryDir });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Scanned: ${result.scanned}`);
      console.log(`Added: ${result.added.length}`);
      console.log(`Modified: ${result.changed.filter((c) => c.type === "modified").length}`);
      console.log(`Deleted: ${result.deleted.length}`);
      console.log(`Unchanged: ${result.unchanged}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "watch") {
    const { stop } = watchForChanges(
      { sourceDir, memoryDir },
      (changes) => {
        console.log(`Changed: ${changes.length} file(s)`);
        for (const c of changes) {
          console.log(`  [${c.type}] ${c.relativePath}`);
        }
      },
    );
    console.log("Watching... (Ctrl+C to stop)");
    process.on("SIGINT", () => {
      stop();
      console.log("Stopped watching.");
    });
  } else {
    console.log("Usage: remnic sync <run|watch> [--source <dir>]");
    process.exit(1);
  }
}

function cmdDedup(json: boolean): void {
  const memoryDir = resolveMemoryDir();
  const result = findDuplicates({ memoryDir });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Scanned: ${result.scanned} memories`);
  console.log(`Found ${result.duplicates.length} duplicate pairs`);
  for (const dup of result.duplicates) {
    console.log(`  [${dup.action}] ${dup.left.content.slice(0, 60)}...`);
    console.log(`    vs: ${dup.right.content.slice(0, 60)}...`);
    console.log(`    Similarity: ${(dup.similarity * 100).toFixed(2)}%`);
  }
  console.log(`Duration: ${result.durationMs}ms`);
}

// ── M5 connectors command ────────────────────────────────────────────────────

async function cmdConnectors(action: string, rest: string[], json: boolean): Promise<void> {
  // For install/remove/doctor, the connector ID is the second non-flag arg after the action
  const nonFlagArgs = rest.filter((a) => !a.startsWith("--"));
  const connectorId = nonFlagArgs[0];

  if (action === "list") {
    const { installed, available } = listConnectors();
    if (json) {
      console.log(JSON.stringify({ installed, available }, null, 2));
    } else {
      console.log("Available connectors:");
      for (const c of available) {
        const icon = c.installed ? "✓" : "○";
        console.log(`  ${icon} ${c.id.padEnd(22)} ${c.name} v${c.version} — ${c.description}`);
      }
    }
  } else if (action === "install") {
    if (!connectorId) {
      console.error("Usage: remnic connectors install <id>");
      process.exit(1);
    }
    const result = installConnector({
      connectorId,
      config: parseConnectorConfig(rest),
      force: rest.includes("--force"),
    });
    console.log(result.message);
    if (result.configPath) console.log(`  Config: ${result.configPath}`);
    if (result.status === "already_installed") console.log("Use --force to reinstall.");
    if (result.status === "config_required") console.log("Set config with --config <key>=<value>");
    if (result.status === "error") console.error(`Error: ${result.message}`);
  } else if (action === "remove") {
    if (!connectorId) {
      console.error("Usage: remnic connectors remove <id>");
      process.exit(1);
    }
    const result = removeConnector(connectorId);
    console.log(result.message);
  } else if (action === "doctor") {
    if (!connectorId) {
      console.error("Usage: remnic connectors doctor <id>");
      process.exit(1);
    }
    const result = await doctorConnector(connectorId);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const check of result.checks) {
        const icon = check.ok ? "✓" : "✗";
        console.log(`  ${icon} ${check.name}: ${check.detail}`);
      }
      console.log(result.healthy ? "\nConnector healthy" : "\nConnector has issues");
    }
  } else {
    console.log("Usage: remnic connectors <list|install|remove|doctor> [id]");
    process.exit(1);
  }
}

// ── M6 space command ──────────────────────────────────────────────────────────

async function cmdSpace(action: string, rest: string[], json: boolean): Promise<void> {
  const nonFlagArgs = rest.filter((a) => !a.startsWith("--"));

  if (action === "list") {
    const spaces = listSpaces();
    if (json) {
      console.log(JSON.stringify(spaces, null, 2));
    } else {
      const active = getActiveSpace();
      for (const s of spaces) {
        const icon = s.id === active.id ? "●" : "○";
        console.log(`  ${icon} ${s.name} (${s.kind}) — ${s.memoryDir}`);
      }
    }
  } else if (action === "switch") {
    const spaceId = nonFlagArgs[0];
    if (!spaceId) {
      console.error("Usage: remnic space switch <id>");
      process.exit(1);
    }
    const result = switchSpace(spaceId);
    console.log(result.message);
  } else if (action === "create") {
    // Extract --parent <id> before computing positional args
    const parentIdx = rest.indexOf("--parent");
    const parentSpaceId = parentIdx >= 0 && rest[parentIdx + 1] ? rest[parentIdx + 1] : undefined;
    // Build positional args excluding --parent and its value
    const positionals: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--parent") { i++; continue; } // skip --parent and its value
      if (rest[i].startsWith("--")) continue;
      positionals.push(rest[i]);
    }
    const name = positionals[0];
    const rawKind = positionals[1] ?? "project";
    const validKinds = ["personal", "project", "team"] as const;
    if (!validKinds.includes(rawKind as typeof validKinds[number])) {
      console.error(`Invalid kind "${rawKind}". Must be one of: ${validKinds.join(", ")}`);
      process.exit(1);
    }
    const kind = rawKind as "personal" | "project" | "team";
    if (!name) {
      console.error("Usage: remnic space create <name> [personal|project|team] [--parent <id>]");
      process.exit(1);
    }
    const space = createSpace({ name, kind, parentSpaceId });
    if (json) {
      console.log(JSON.stringify(space, null, 2));
    } else {
      console.log(`Created space "${space.name}" (${space.id})`);
      console.log(`  Kind: ${space.kind}`);
      console.log(`  Dir: ${space.memoryDir}`);
    }
  } else if (action === "delete") {
    const spaceId = nonFlagArgs[0];
    if (!spaceId) {
      console.error("Usage: remnic space delete <id>");
      process.exit(1);
    }
    deleteSpace(spaceId);
    console.log(`Deleted space "${spaceId}"`);
  } else if (action === "push") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: remnic space push <source> <target>");
      process.exit(1);
    }
    const result = pushToSpace(sourceId, targetId, { force: rest.includes("--force") });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Pushed ${result.memoriesPushed} memories`);
      if (result.conflicts.length > 0) console.log(`Conflicts: ${result.conflicts.length}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "pull") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: remnic space pull <source> <target>");
      process.exit(1);
    }
    const result = pullFromSpace(sourceId, targetId, { force: rest.includes("--force") });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Pulled ${result.memoriesPulled} memories`);
      if (result.conflicts.length > 0) console.log(`Conflicts: ${result.conflicts.length}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "share") {
    const spaceId = nonFlagArgs[0];
    const members = nonFlagArgs.slice(1);
    if (!spaceId || members.length === 0) {
      console.error("Usage: remnic space share <id> <member1> [member2 ...]");
      process.exit(1);
    }
    const result = shareSpace(spaceId, members);
    console.log(result.message);
  } else if (action === "promote") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: remnic space promote <source> <target>");
      process.exit(1);
    }
    const result = promoteSpace(sourceId, targetId, {
      force: rest.includes("--force"),
      forceOverwrite: rest.includes("--force-overwrite"),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Promoted ${result.memoriesPromoted} memories`);
      if (result.conflicts.length > 0) console.log(`Conflicts: ${result.conflicts.length}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "audit") {
    const entries = getAuditLog();
    if (json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      if (entries.length === 0) {
        console.log("No audit entries.");
      } else {
        for (const e of entries.slice(-50)) {
          console.log(`[${e.timestamp}] ${e.action} ${e.details}`);
        }
      }
    }
  } else {
    console.log("Usage: remnic space <list|switch|create|delete|push|pull|share|promote|audit>");
    process.exit(1);
  }
}

// ── M7 benchmark command ───────────────────────────────────────────────────────

async function cmdBenchmark(action: string, rest: string[], json: boolean): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);
  const orchestrator = new Orchestrator(config);
  const service = new EngramAccessService(orchestrator);

  const benchConfig: BenchConfig = {
    queries: rest.filter((a) => !a.startsWith("--")).length > 0
      ? rest.filter((a) => !a.startsWith("--"))
      : undefined,
    explain: rest.includes("--explain"),
    baselinePath: rest.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length),
    reportPath: rest.find((a) => a.startsWith("--report="))?.slice("--report=".length),
  };

  if (action === "run") {
    const suite = await runBenchSuite(service, benchConfig);
    if (json) {
      console.log(JSON.stringify(suite, null, 2));
    } else {
      console.log(`Benchmark suite completed in ${suite.totalDurationMs}ms`);
      for (const r of suite.results) {
        const tiers = r.tiersUsed.join(" → ");
        console.log(`  ${r.query}: ${r.latencyMs}ms (${r.resultsCount} results) [${tiers}]`);
      }
      if (suite.regressions.length > 0) {
        console.log("\nRegressions:");
        for (const reg of suite.regressions) {
          const icon = reg.passed ? "✓" : "✗";
          console.log(`  ${icon} ${reg.metric}: ${reg.currentValue}ms (baseline: ${reg.baselineValue}ms, tolerance: ${reg.tolerance}%)`);
        }
      }
    }
  } else if (action === "check") {
    const baselinePath = benchConfig.baselinePath;
    const baseline = loadBaseline(baselinePath);
    if (!baseline) {
      console.log("No baseline found. Run `remnic benchmark run` first.");
      return;
    }
    const suite = await runBenchSuite(service, benchConfig);
    const metrics: Record<string, number> = {};
    for (const r of suite.results) {
      metrics[r.query] = r.latencyMs;
    }
    const tolerance = benchConfig.regressionTolerance ?? 10;
    const result = checkRegression(metrics, baseline, tolerance);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.passed) {
        console.log("No regressions detected.");
      } else {
        console.log("Regressions detected:");
        for (const reg of result.regressions) {
          if (!reg.passed) {
            console.log(`  ✗ ${reg.metric}: ${reg.currentValue}ms vs ${reg.baselineValue}ms baseline (+${(((reg.currentValue - reg.baselineValue) / reg.baselineValue) * 100).toFixed(1)}%)`);
          }
        }
      }
    }
    if (!result.passed) {
      process.exit(1);
    }
  } else if (action === "report") {
    const reportPath = benchConfig.reportPath;
    const suite = await runBenchSuite(service, { ...benchConfig, reportPath });
    console.log(`Report saved to ${reportPath ?? "benchmarks/report.json"}`);
    if (json) {
      console.log(JSON.stringify(suite.report, null, 2));
    }
  } else {
    console.log("Usage: remnic benchmark <run|check|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]");
    process.exit(1);
  }
}

// ── Daemon management ────────────────────────────────────────────────────────

const LOGS_DIR = path.join(PID_DIR, "logs");
const LAUNCHD_LABEL = "ai.remnic.daemon";
const LEGACY_LAUNCHD_LABEL = "ai.engram.daemon";
const LAUNCHD_PLIST_PATH = path.join(
  resolveHomeDir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
const LEGACY_LAUNCHD_PLIST_PATH = path.join(
  resolveHomeDir(),
  "Library",
  "LaunchAgents",
  `${LEGACY_LAUNCHD_LABEL}.plist`,
);
const SYSTEMD_SERVICE = "remnic.service";
const LEGACY_SYSTEMD_SERVICE = "engram.service";
const SYSTEMD_UNIT_PATH = path.join(
  resolveHomeDir(),
  ".config",
  "systemd",
  "user",
  SYSTEMD_SERVICE,
);
const LEGACY_SYSTEMD_UNIT_PATH = path.join(
  resolveHomeDir(),
  ".config",
  "systemd",
  "user",
  LEGACY_SYSTEMD_SERVICE,
);


function readPid(): number | undefined {
  for (const file of [PID_FILE, LEGACY_PID_FILE]) {
    try {
      return parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    } catch {
      // Try next candidate
    }
  }
  return undefined;
}

function inferPort(): number {
  try {
    const configPath = resolveConfigPath();
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return raw.server?.port ?? 4318;
  } catch {
    return 4318;
  }
}

function resolveNodePath(): string {
  return process.execPath;
}

function resolveServerBin(): string {
  // Prefer built dist (production), fall back to source (dev)
  const distPath = path.resolve(import.meta.dirname, "../../remnic-server/dist/index.js");
  if (fs.existsSync(distPath)) return distPath;
  const srcPath = path.resolve(import.meta.dirname, "../../remnic-server/src/index.ts");
  return srcPath;
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function renderTemplate(templateContent: string, vars: Record<string, string>): string {
  let result = templateContent;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function daemonInstall(): void {
  const home = resolveHomeDir();
  const nodePath = resolveNodePath();
  const serverBin = resolveServerBin();

  // Service templates use plain `node` — TypeScript source won't work
  if (serverBin.endsWith(".ts")) {
    console.error("Error: @remnic/server has not been built. Run 'pnpm run build --filter=@remnic/server' first.");
    console.error(`  Expected: ${path.resolve(import.meta.dirname, "../../remnic-server/dist/index.js")}`);
    console.error(`  Found:    ${serverBin} (TypeScript source — not loadable by node)`);
    process.exit(1);
  }

  const vars = { HOME: home, NODE_PATH: nodePath, REMNIC_SERVER_BIN: serverBin };

  fs.mkdirSync(LOGS_DIR, { recursive: true });

  if (isMacOS()) {
    const templatePath = path.resolve(import.meta.dirname, "../templates/launchd/ai.remnic.daemon.plist");
    const template = fs.readFileSync(templatePath, "utf8");
    const plist = renderTemplate(template, vars);
    fs.mkdirSync(path.dirname(LAUNCHD_PLIST_PATH), { recursive: true });
    fs.writeFileSync(LAUNCHD_PLIST_PATH, plist);
    try {

      childProcess.execSync(`launchctl load -w "${LAUNCHD_PLIST_PATH}"`, { stdio: "pipe" });
    } catch {
      // May already be loaded
    }
    console.log(`Installed launchd service: ${LAUNCHD_PLIST_PATH}`);
    console.log(`  Label: ${LAUNCHD_LABEL}`);
    console.log(`  RunAtLoad: true, KeepAlive: true`);
    console.log(`  Logs: ${LOGS_DIR}/daemon.log`);
  } else if (isLinux()) {
    const templatePath = path.resolve(import.meta.dirname, "../templates/systemd/remnic.service");
    const template = fs.readFileSync(templatePath, "utf8");
    const unit = renderTemplate(template, vars);
    fs.mkdirSync(path.dirname(SYSTEMD_UNIT_PATH), { recursive: true });
    fs.writeFileSync(SYSTEMD_UNIT_PATH, unit);
    try {

      childProcess.execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      childProcess.execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`, { stdio: "pipe" });
      childProcess.execSync(`systemctl --user start ${SYSTEMD_SERVICE}`, { stdio: "pipe" });
    } catch {
      // May fail if systemd not available
    }
    console.log(`Installed systemd user service: ${SYSTEMD_UNIT_PATH}`);
    console.log(`  Restart: on-failure, WantedBy: default.target`);
    console.log(`  Logs: ${LOGS_DIR}/daemon.log`);
  } else {
    console.error(`Unsupported platform: ${process.platform}. Use 'remnic daemon start' for manual mode.`);
    process.exit(1);
  }
}

function daemonUninstall(): void {
  if (isMacOS()) {
    let removed = false;
    for (const plistPath of [LAUNCHD_PLIST_PATH, LEGACY_LAUNCHD_PLIST_PATH]) {
      try {
        childProcess.execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
      } catch {
        // May not be loaded
      }
      try {
        fs.unlinkSync(plistPath);
        removed = true;
        console.log(`Removed launchd service: ${plistPath}`);
      } catch {
        // keep going
      }
    }
    if (!removed) {
      console.log("Launchd plist not found — nothing to remove.");
    }
  } else if (isLinux()) {
    for (const serviceName of [SYSTEMD_SERVICE, LEGACY_SYSTEMD_SERVICE]) {
      try {
        childProcess.execSync(`systemctl --user stop ${serviceName}`, { stdio: "pipe" });
        childProcess.execSync(`systemctl --user disable ${serviceName}`, { stdio: "pipe" });
      } catch {
        // May not be active
      }
    }
    let removed = false;
    for (const unitPath of [SYSTEMD_UNIT_PATH, LEGACY_SYSTEMD_UNIT_PATH]) {
      try {
        fs.unlinkSync(unitPath);
        removed = true;
        console.log(`Removed systemd service: ${unitPath}`);
      } catch {
        // keep going
      }
    }
    if (removed) {
      childProcess.execSync("systemctl --user daemon-reload", { stdio: "pipe" });
    } else {
      console.log("Systemd unit not found — nothing to remove.");
    }
  } else {
    console.error(`Unsupported platform: ${process.platform}.`);
    process.exit(1);
  }
  // Also stop any manually-started daemon
  daemonStop();
}

function isServiceRunning(): { running: boolean; pid?: number } {
  // Check PID file first (manual `daemon start`)
  const pidFromFile = readPid();
  if (pidFromFile) {
    try {
      process.kill(pidFromFile, 0);
      return { running: true, pid: pidFromFile };
    } catch {
      // stale pid file
    }
  }
  // Check service manager (launchd/systemd from `daemon install`)
  if (isMacOS()) {
    const status = firstSuccessfulResult([LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL], (label) => {
      const out = childProcess.execSync(`launchctl list ${label} 2>/dev/null`, { encoding: "utf8" });
      const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
      if (pidMatch) return { running: true, pid: parseInt(pidMatch[1], 10) };
      return out.includes('"PID"') ? { running: true } : undefined;
    });
    if (status) return status;
  } else if (isLinux()) {
    const status = firstSuccessfulResult([SYSTEMD_SERVICE, LEGACY_SYSTEMD_SERVICE], (serviceName) => {
      const out = childProcess.execSync(`systemctl --user is-active ${serviceName} 2>/dev/null`, {
        encoding: "utf8",
      }).trim();
      if (out !== "active") return undefined;
      try {
        const pidOut = childProcess.execSync(
          `systemctl --user show ${serviceName} --property=MainPID --value`,
          { encoding: "utf8" },
        ).trim();
        const spid = parseInt(pidOut, 10);
        if (spid > 0) return { running: true, pid: spid };
      } catch {
        // Keep the service running result even if MainPID lookup fails.
      }
      return { running: true };
    });
    if (status) return status;
  }
  return { running: false };
}

function daemonStatus(): void {
  const { running, pid } = isServiceRunning();
  const port = inferPort();
  const serviceInstalled = isMacOS()
    ? fs.existsSync(LAUNCHD_PLIST_PATH) || fs.existsSync(LEGACY_LAUNCHD_PLIST_PATH)
    : isLinux()
      ? fs.existsSync(SYSTEMD_UNIT_PATH) || fs.existsSync(LEGACY_SYSTEMD_UNIT_PATH)
      : false;

  console.log(`Remnic daemon status:`);
  console.log(`  Running:   ${running ? `yes${pid ? ` (pid ${pid})` : ""}` : "no"}`);
  console.log(`  Port:      ${port}`);
  console.log(`  Service:   ${serviceInstalled ? "installed" : "not installed"}`);
  console.log(`  Platform:  ${process.platform}`);
  console.log(`  PID file:  ${fs.existsSync(PID_FILE) ? PID_FILE : LEGACY_PID_FILE}`);
  console.log(`  Log file:  ${fs.existsSync(LOG_FILE) ? LOG_FILE : LEGACY_LOG_FILE}`);
}

function daemonStart(): void {
  const svc = isServiceRunning();
  if (svc.running) {
    console.log(`Already running${svc.pid ? ` (pid ${svc.pid})` : " (via service manager)"}`);
    return;
  }

  // Try service manager first (for daemons installed via `remnic daemon install`)
  if (isMacOS() && (fs.existsSync(LAUNCHD_PLIST_PATH) || fs.existsSync(LEGACY_LAUNCHD_PLIST_PATH))) {
    const label = firstSuccessfulCandidate([LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL], (candidate) => {
      childProcess.execSync(`launchctl start ${candidate} 2>/dev/null`, { stdio: "pipe" });
    });
    if (label) {
      console.log(`Started remnic daemon via launchd (${label})`);
      return;
    }
  } else if (isLinux() && (fs.existsSync(SYSTEMD_UNIT_PATH) || fs.existsSync(LEGACY_SYSTEMD_UNIT_PATH))) {
    const serviceName = firstSuccessfulCandidate([SYSTEMD_SERVICE, LEGACY_SYSTEMD_SERVICE], (candidate) => {
      childProcess.execSync(`systemctl --user start ${candidate}`, { stdio: "pipe" });
    });
    if (serviceName) {
      console.log(`Started remnic daemon via systemd (${serviceName})`);
      return;
    }
  }

  fs.mkdirSync(PID_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logStream = fs.openSync(LOG_FILE, "a");

  const serverBin = resolveServerBin();
  const isSource = serverBin.endsWith(".ts");

  let cmd: string;
  let args: string[];
  if (isSource) {
    // Dev mode: use npx tsx
    cmd = "npx";
    args = ["tsx", serverBin];
  } else {
    // Production: use node directly
    cmd = process.execPath;
    args = [serverBin];
  }

  const child = childProcess.spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", logStream, logStream],
    env: {
      ...process.env,
      REMNIC_DAEMON: "1",
      ENGRAM_DAEMON: process.env.ENGRAM_DAEMON ?? "1",
    },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`Started remnic server (pid ${child.pid})`);
  console.log(`  Log: ${LOG_FILE}`);
}

function daemonStop(): void {
  // Try service manager first (for daemons started via `remnic daemon install`)
  if (isMacOS() && (fs.existsSync(LAUNCHD_PLIST_PATH) || fs.existsSync(LEGACY_LAUNCHD_PLIST_PATH))) {
    const label = firstSuccessfulCandidate([LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL], (candidate) => {
      childProcess.execSync(`launchctl stop ${candidate} 2>/dev/null`, { stdio: "pipe" });
    });
    if (label) {
      console.log(`Stopped remnic daemon via launchd (${label})`);
      return;
    }
  } else if (isLinux() && (fs.existsSync(SYSTEMD_UNIT_PATH) || fs.existsSync(LEGACY_SYSTEMD_UNIT_PATH))) {
    const serviceName = firstSuccessfulCandidate([SYSTEMD_SERVICE, LEGACY_SYSTEMD_SERVICE], (candidate) => {
      childProcess.execSync(`systemctl --user stop ${candidate}`, { stdio: "pipe" });
    });
    if (serviceName) {
      console.log(`Stopped remnic daemon via systemd (${serviceName})`);
      return;
    }
  }

  // Fall back to PID file (for daemons started via `remnic daemon start`)
  const pid = readPid();
  if (!pid) {
    console.log("Not running");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped remnic server (pid ${pid})`);
  } catch {
    console.log("Process not found (cleaning up PID file)");
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(LEGACY_PID_FILE);
  } catch {
    // ignore
  }
}

function daemonRestart(): void {
  daemonStop();
  setTimeout(() => daemonStart(), 1000);
}

// ── Token management ────────────────────────────────────────────────────────

function cmdTokenGenerate(connector: string): void {
  if (!connector) {
    console.error("Usage: remnic token generate <connector-id>");
    console.error("  e.g.: remnic token generate claude-code");
    process.exit(1);
  }
  const entry = generateToken(connector);
  console.log(`Generated token for ${connector}:`);
  console.log(`  Token:   ${entry.token}`);
  console.log(`  Created: ${entry.createdAt}`);
  console.log(`\nUse this token as the Bearer token when connecting from ${connector}.`);
}

function cmdTokenList(json: boolean): void {
  const tokens = listTokens();
  if (json) {
    console.log(JSON.stringify(tokens, null, 2));
    return;
  }
  if (tokens.length === 0) {
    console.log("No tokens. Generate one with: remnic token generate <connector-id>");
    return;
  }
  console.log("Connector tokens:");
  for (const t of tokens) {
    // Show only first 20 chars of token for security
    const masked = t.token.slice(0, 20) + "…";
    console.log(`  ${t.connector.padEnd(16)} ${masked}  (created ${t.createdAt})`);
  }
}

function cmdTokenRevoke(connector: string): void {
  if (!connector) {
    console.error("Usage: remnic token revoke <connector-id>");
    process.exit(1);
  }
  if (revokeToken(connector)) {
    console.log(`Revoked token for ${connector}`);
  } else {
    console.log(`No token found for ${connector}`);
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== "migrate") {
    await migrateFromEngram();
  }

  switch (command as CommandName) {
    case "init":
      cmdInit();
      break;

    case "migrate": {
      const json = rest.includes("--json");
      const rollback = rest.includes("--rollback");
      await cmdMigrate(json, rollback);
      break;
    }

    case "status": {
      const json = rest.includes("--json");
      await cmdStatus(json);
      break;
    }

    case "query": {
      const json = rest.includes("--json");
      const explain = rest.includes("--explain");
      const queryText = rest.filter((a) => !a.startsWith("--")).join(" ");
      await cmdQuery(queryText, json, explain);
      break;
    }

    case "doctor":
      cmdDoctor();
      break;

    case "config":
      cmdConfig();
      break;

    case "daemon": {
      const action = rest[0] as DaemonAction;
      switch (action) {
        case "start":
          daemonStart();
          break;
        case "stop":
          daemonStop();
          break;
        case "restart":
          daemonRestart();
          break;
        case "install":
          daemonInstall();
          break;
        case "uninstall":
          daemonUninstall();
          break;
        case "status":
          daemonStatus();
          break;
        default:
          console.log("Usage: remnic daemon <start|stop|restart|install|uninstall|status>");
          process.exit(1);
      }
      break;
    }

    case "token": {
      const action = rest[0] as TokenAction;
      const json = rest.includes("--json");
      switch (action) {
        case "generate":
          cmdTokenGenerate(rest[1]);
          break;
        case "list":
          cmdTokenList(json);
          break;
        case "revoke":
          cmdTokenRevoke(rest[1]);
          break;
        default:
          console.log("Usage: remnic token <generate|list|revoke> [connector-id] [--json]");
          process.exit(1);
      }
      break;
    }

    case "tree": {
      const subAction = rest[0];
      const json = rest.includes("--json");
      const outputDir = resolveFlag(rest, "--output") ?? path.join(process.cwd(), ".remnic", "context-tree");
      const categoriesFlag = resolveFlag(rest, "--categories");
      const categories = categoriesFlag ? categoriesFlag.split(",") : undefined;
      const maxPerCategoryRaw = resolveFlag(rest, "--max-per-category");
      let maxPerCategory: number | undefined;
      if (maxPerCategoryRaw !== undefined) {
        maxPerCategory = parseInt(maxPerCategoryRaw, 10);
        if (!Number.isFinite(maxPerCategory) || maxPerCategory < 1) {
          console.error(`Invalid --max-per-category: ${maxPerCategoryRaw}`);
          process.exit(1);
        }
      }

      if (subAction === "generate") {
        const result = await generateContextTree({
          memoryDir: resolveMemoryDir(),
          outputDir,
          categories,
          maxPerCategory,
          includeEntities: !rest.includes("--no-entities"),
          includeQuestions: !rest.includes("--no-questions"),
        });
        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Context tree generated at ${result.outputDir}`);
          console.log(`  Nodes: ${result.nodesGenerated} generated, ${result.nodesSkipped} skipped`);
          for (const [cat, count] of Object.entries(result.categories)) {
            console.log(`  ${cat}: ${count}`);
          }
          console.log(`  Duration: ${result.durationMs}ms`);
        }
      } else if (subAction === "watch") {
        const memoryDir = resolveMemoryDir();
        console.log(`Watching ${memoryDir} for changes…`);
        console.log(`Output: ${outputDir}`);
        console.log("Press Ctrl+C to stop.\n");

        // Initial generation
        const initial = await generateContextTree({
          memoryDir,
          outputDir,
          categories,
          maxPerCategory,
          includeEntities: !rest.includes("--no-entities"),
          includeQuestions: !rest.includes("--no-questions"),
        });
        console.log(`Initial: ${initial.nodesGenerated} nodes (${initial.durationMs}ms)`);

        // Debounced watcher
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const rebuild = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            const t0 = Date.now();
            try {
              const result = await generateContextTree({
                memoryDir,
                outputDir,
                categories,
                maxPerCategory,
                includeEntities: !rest.includes("--no-entities"),
                includeQuestions: !rest.includes("--no-questions"),
              });
              console.log(`[${new Date().toISOString()}] Rebuilt: ${result.nodesGenerated} nodes (${Date.now() - t0}ms)`);
            } catch (err) {
              console.error(`[${new Date().toISOString()}] Rebuild failed:`, err instanceof Error ? err.message : err);
            }
          }, 500);
        };

        fs.watch(memoryDir, { recursive: true }, (_event, filename) => {
          if (filename && filename.startsWith(".")) return;
          rebuild();
        });

        // Keep process alive
        await new Promise(() => {});
      } else if (subAction === "validate") {
        const treeDir = outputDir;
        if (!fs.existsSync(treeDir)) {
          console.error(`Context tree not found at ${treeDir}. Run 'remnic tree generate' first.`);
          process.exit(1);
        }
        const indexPath = path.join(treeDir, "INDEX.md");
        if (!fs.existsSync(indexPath)) {
          console.error(`INDEX.md missing in ${treeDir}. Tree may be corrupt — regenerate.`);
          process.exit(1);
        }
        console.log(`Context tree at ${treeDir} is valid.`);
      } else {
        console.log(`Usage: remnic tree <generate|watch|validate>
  generate                Generate context tree from memory
  watch                   Watch memory dir and regenerate on changes
  validate                Check that context tree exists and is valid

Options:
  --output <dir>          Output directory (default: .remnic/context-tree)
  --categories <list>     Comma-separated categories to include
  --max-per-category <n>  Max nodes per category
  --no-entities           Exclude entity nodes
  --no-questions          Exclude question nodes
  --json                  JSON output (generate only)`);
      }
      break;
    }

    case "onboard": {
      const dir = rest[0] ?? ".";
      const json = rest.includes("--json");
      cmdOnboard(dir, json);
      break;
    }

    case "curate": {
      const targetPath = rest[0];
      const json = rest.includes("--json");
      if (!targetPath) {
        console.error("Usage: remnic curate <path>");
        process.exit(1);
      }
      await cmdCurate(targetPath, json);
      break;
    }

    case "review": {
      const action = rest[0] ?? "list";
      cmdReview(action, rest.slice(1));
      break;
    }

    case "sync": {
      const action = rest[0] ?? "run";
      const json = rest.includes("--json");
      cmdSync(action, rest.slice(1), json);
      break;
    }

    case "dedup": {
      const json = rest.includes("--json");
      cmdDedup(json);
      break;
    }

    case "connectors": {
      const action = rest[0] ?? "list";
      const json = rest.includes("--json");
      await cmdConnectors(action, rest.slice(1), json);
      break;
    }

    case "space": {
      const action = rest[0] ?? "list";
      const json = rest.includes("--json");
      await cmdSpace(action, rest.slice(1), json);
      break;
    }

    case "benchmark": {
      const action = rest[0] ?? "run";
      const json = rest.includes("--json");
      await cmdBenchmark(action, rest.slice(1), json);
      break;
    }

    default:
      console.log(`
remnic — Remnic memory CLI

Usage:
  remnic init                  Create config file
  remnic migrate [--rollback] [--json]  Run or undo first-run Engram migration
  remnic status [--json]       Show server status
  remnic query <text> [--json] [--explain] Query memories (use --explain for tier breakdown)

  remnic doctor                Run diagnostics
  remnic config                Show current config
  remnic daemon <start|stop|restart|install|uninstall|status>  Manage background server
  remnic token <generate|list|revoke> [connector-id]  Manage auth tokens
  remnic tree <generate|watch|validate>  Generate context tree
  remnic onboard [dir] [--json]     Onboard project directory
  remnic curate <path> [--json]  Curate files into memory
  remnic review <list|approve|dismiss|flag> [id]  Review inbox
  remnic sync <run|watch> [--source <dir>] Diff-aware sync
  remnic dedup [--json]             Find duplicate memories
  remnic connectors <list|install|remove|doctor> [id]  Manage connectors
  remnic space <list|switch|create|delete|push|pull|share|promote|audit>  Manage spaces
    create accepts --parent <id> to set parent-child relationship
  remnic benchmark <run|check|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]

Options:
  --json    Output in JSON format
  --help    Show this help
`);
      break;
  }
}

// Auto-run when executed directly (covers: remnic and legacy engram entrypoints,
// or invoked via wrappers that set REMNIC_CLI_BIN / ENGRAM_CLI_BIN)
const argv1 = process.argv[1] ?? "";
const argv1Base = argv1.replace(/\\/g, "/");
if (
  argv1Base.endsWith("remnic.ts") ||
  argv1Base.endsWith("remnic.js") ||
  argv1Base.endsWith("engram.ts") ||
  argv1Base.endsWith("engram.js") ||
  argv1Base.endsWith("/remnic") ||
  argv1Base.endsWith("/engram") ||
  argv1Base.includes("packages/remnic-cli/src/index.") ||
  process.env.REMNIC_CLI_BIN === "1" ||
  process.env.ENGRAM_CLI_BIN === "1"
) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
