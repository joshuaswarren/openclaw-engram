/**
 * @engram/cli
 *
 * Command-line interface for Engram memory.
 *
 * Commands:
 *   init              Create engram.config.json in the current directory
 *   status            Show server/daemon status
 *   query <text>      Query memories
 *   doctor            Run diagnostics
 *   config            Show current config
 *   daemon start      Start background server
 *   daemon stop       Stop background server
 *   daemon restart    Restart background server
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
import { spawn } from "node:child_process";
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
} from "@engram/core";
import {
  runBenchSuite,
  runExplain,
  loadBaseline,
  saveBaseline,
  checkRegression,
  type BenchConfig,
} from "@engram/bench";

// ── Types ────────────────────────────────────────────────────────────────────

type CommandName =
  | "init"
  | "status"
  | "query"
  | "doctor"
  | "config"
  | "daemon"
  | "tree"
  | "onboard"
  | "curate"
  | "review"
  | "sync"
  | "dedup"
  | "connectors"
  | "space"
  | "benchmark";

type DaemonAction = "start" | "stop" | "restart";
type ReviewAction = "approve" | "dismiss" | "flag";

// ── Constants ────────────────────────────────────────────────────────────────

const PID_DIR = path.join(process.env.HOME ?? "~", ".engram");
const PID_FILE = path.join(PID_DIR, "server.pid");
const LOG_FILE = path.join(PID_DIR, "server.log");

// ── Config helpers ───────────────────────────────────────────────────────────

function resolveConfigPath(cliPath?: string): string {
  if (cliPath) return path.resolve(cliPath);
  const envPath = process.env.ENGRAM_CONFIG_PATH;
  if (envPath) return path.resolve(envPath);
  const cwdPath = path.join(process.cwd(), "engram.config.json");
  if (fs.existsSync(cwdPath)) return cwdPath;
  return path.join(process.env.HOME ?? "~", ".config", "engram", "config.json");
}

function resolveMemoryDir(): string {
  // Priority: env var > config file > auto-detect
  const configMemoryDir = (() => {
    // Env var takes top priority (deployment override)
    if (process.env.ENGRAM_MEMORY_DIR) return process.env.ENGRAM_MEMORY_DIR;
    // Then config file
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    const engramCfg = raw.engram ?? raw;
    if (engramCfg.memoryDir) return engramCfg.memoryDir;
    // Auto-detect: prefer standalone path if it exists, fall back to OpenClaw
    const home = process.env.HOME ?? "~";
    const standalonePath = path.join(home, ".engram", "memory");
    const openclawPath = path.join(home, ".openclaw", "workspace", "memory", "local");
    return fs.existsSync(standalonePath) ? standalonePath : openclawPath;
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
  const configPath = path.join(process.cwd(), "engram.config.json");
  if (fs.existsSync(configPath)) {
    console.log(`Config already exists: ${configPath}`);
    return;
  }

  const template: Record<string, unknown> = {
    engram: {
      openaiApiKey: "${OPENAI_API_KEY}",
      memoryDir: path.join(process.cwd(), ".engram", "memory"),
      memoryOsPreset: "balanced",
    },
    server: {
      host: "127.0.0.1",
      port: 4318,
      authToken: "${ENGRAM_AUTH_TOKEN}",
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n");
  console.log(`Created ${configPath}`);
  console.log("\nSet these environment variables:");
  console.log("  export OPENAI_API_KEY=sk-...");
  console.log("  export ENGRAM_AUTH_TOKEN=$(openssl rand -hex 32)");
  console.log("\nThen start the server:");
  console.log("  npx engram-server");
}

async function cmdStatus(json: boolean): Promise<void> {
  const running = isDaemonRunning();
  if (json) {
    console.log(JSON.stringify({ running, pidFile: PID_FILE, logFile: LOG_FILE }));
    return;
  }
  if (!running) {
    console.log("Engram server: stopped");
    return;
  }
  const pid = readPid();
  console.log(`Engram server: running (pid ${pid})`);

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
    console.error("Usage: engram query <text>");
    process.exit(1);
  }

  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const engramCfg = raw.engram ?? raw;
  const config = parseConfig(engramCfg);
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

  checks.push({
    name: "Server daemon",
    ok: isDaemonRunning(),
    detail: isDaemonRunning() ? `running (pid ${readPid()})` : "stopped",
  });

  for (const check of checks) {
    const icon = check.ok ? "✓" : "✗";
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
  }
}

function cmdConfig(): void {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    console.log("No config file found. Run `engram init` to create one.");
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
      console.error("Usage: engram review <approve|dismiss|flag> <id>");
      process.exit(1);
    }
    const result = performReview(memoryDir, id, action as ReviewAction);
    console.log(result.message);
  } else {
    console.log("Usage: engram review <list|approve|dismiss|flag> [id]");
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
    console.log("Usage: engram sync <run|watch> [--source <dir>]");
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
      console.error("Usage: engram connectors install <id>");
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
      console.error("Usage: engram connectors remove <id>");
      process.exit(1);
    }
    const result = removeConnector(connectorId);
    console.log(result.message);
  } else if (action === "doctor") {
    if (!connectorId) {
      console.error("Usage: engram connectors doctor <id>");
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
    console.log("Usage: engram connectors <list|install|remove|doctor> [id]");
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
      console.error("Usage: engram space switch <id>");
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
      console.error("Usage: engram space create <name> [personal|project|team] [--parent <id>]");
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
      console.error("Usage: engram space delete <id>");
      process.exit(1);
    }
    deleteSpace(spaceId);
    console.log(`Deleted space "${spaceId}"`);
  } else if (action === "push") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: engram space push <source> <target>");
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
      console.error("Usage: engram space pull <source> <target>");
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
      console.error("Usage: engram space share <id> <member1> [member2 ...]");
      process.exit(1);
    }
    const result = shareSpace(spaceId, members);
    console.log(result.message);
  } else if (action === "promote") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: engram space promote <source> <target>");
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
    console.log("Usage: engram space <list|switch|create|delete|push|pull|share|promote|audit>");
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
  const engramCfg = raw.engram ?? raw;
  const config = parseConfig(engramCfg);
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
      console.log("No baseline found. Run `engram benchmark run` first.");
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
    console.log("Usage: engram benchmark <run|check|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]");
    process.exit(1);
  }
}

// ── Daemon management ────────────────────────────────────────────────────────

function isDaemonRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
    return false;
  }
}

function readPid(): number | undefined {
  try {
    return parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    return undefined;
  }
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

function daemonStart(): void {
  if (isDaemonRunning()) {
    console.log(`Already running (pid ${readPid()})`);
    return;
  }
  fs.mkdirSync(PID_DIR, { recursive: true });
  const logStream = fs.openSync(LOG_FILE, "a");
  const child = spawn(
    "npx",
    ["tsx", path.resolve(import.meta.dirname, "../../server/src/index.ts")],
    {
      detached: true,
      stdio: ["ignore", logStream, logStream],
      env: {
        ...process.env,
        ENGRAM_DAEMON: "1",
      },
    },
  );
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`Started engram server (pid ${child.pid})`);
  console.log(`  Log: ${LOG_FILE}`);
}

function daemonStop(): void {
  const pid = readPid();
  if (!pid) {
    console.log("Not running");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped engram server (pid ${pid})`);
  } catch {
    console.log("Process not found (cleaning up PID file)");
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

function daemonRestart(): void {
  daemonStop();
  setTimeout(() => daemonStart(), 1000);
}

// ── CLI entry ────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;

  switch (command as CommandName) {
    case "init":
      cmdInit();
      break;

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
        default:
          console.log("Usage: engram daemon <start|stop|restart>");
          process.exit(1);
      }
      break;
    }

    case "tree": {
      const subAction = rest[0];
      const json = rest.includes("--json");
      const outputDir = resolveFlag(rest, "--output") ?? path.join(process.cwd(), ".engram", "context-tree");
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
      } else if (subAction === "validate") {
        const treeDir = outputDir;
        if (!fs.existsSync(treeDir)) {
          console.error(`Context tree not found at ${treeDir}. Run 'engram tree generate' first.`);
          process.exit(1);
        }
        const indexPath = path.join(treeDir, "INDEX.md");
        if (!fs.existsSync(indexPath)) {
          console.error(`INDEX.md missing in ${treeDir}. Tree may be corrupt — regenerate.`);
          process.exit(1);
        }
        console.log(`Context tree at ${treeDir} is valid.`);
      } else {
        console.log(`Usage: engram tree <generate|validate>
  --output <dir>          Output directory (default: .engram/context-tree)
  --categories <list>     Comma-separated categories to include
  --max-per-category <n>  Max nodes per category
  --no-entities           Exclude entity nodes
  --no-questions          Exclude question nodes
  --json                  JSON output`);
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
        console.error("Usage: engram curate <path>");
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
engram — Engram memory CLI

Usage:
  engram init                  Create config file
  engram status [--json]       Show server status
  engram query <text> [--json] [--explain] Query memories (use --explain for tier breakdown)

  engram doctor                Run diagnostics
  engram config                Show current config
  engram daemon <start|stop|restart>  Manage background server
  engram tree <generate|watch|validate>  Generate context tree
  engram onboard [dir] [--json]     Onboard project directory
  engram curate <path> [--json]  Curate files into memory
  engram review <list|approve|dismiss|flag> [id]  Review inbox
  engram sync <run|watch> [--source <dir>] Diff-aware sync
  engram dedup [--json]             Find duplicate memories
  engram connectors <list|install|remove|doctor> [id]  Manage connectors
  engram space <list|switch|create|delete|push|pull|share|promote|audit>  Manage spaces
    create accepts --parent <id> to set parent-child relationship
  engram benchmark <run|check|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]

Options:
  --json    Output in JSON format
  --help    Show this help
`);
      break;
  }
}

// Auto-run when executed directly (covers: npx tsx engram.ts, node engram.js, symlinked `engram`,
// npx tsx packages/cli/src/index.ts, or invoked via bin/engram.cjs which sets ENGRAM_CLI_BIN=1)
const argv1 = process.argv[1] ?? "";
const argv1Base = argv1.replace(/\\/g, "/");
if (
  argv1Base.endsWith("engram.ts") ||
  argv1Base.endsWith("engram.js") ||
  argv1Base.endsWith("/engram") ||
  argv1Base.includes("packages/cli/src/index.") ||
  process.env.ENGRAM_CLI_BIN === "1"
) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
