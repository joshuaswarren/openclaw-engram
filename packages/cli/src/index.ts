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
 *   curate <path>      Curate files into memory
 *   review            Review inbox management
 *   sync              Diff-aware sync
 *   dedup             Find duplicate memories
 */

import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
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
  findContradictions,
} from "@engram/core";

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
  | "dedup";

type DaemonAction = "start" | "stop" | "restart";
type ReviewAction = "approve" | "dismiss" | "flag";

// ── Constants ────────────────────────────────────────────────────────────────

const PID_DIR = path.join(process.env.HOME ?? "~", ".engram");
const PID_FILE = path.join(PID_DIR, "server.pid");
const LOG_FILE = path.join(PID_DIR, "server.log");
const SOCKET_FILE = path.join(PID_DIR, "server.sock");

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
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const engramCfg = raw.engram ?? raw;
  return engramCfg.memoryDir ?? path.join(process.env.HOME ?? "~", ".openclaw", "workspace", "memory", "local");
}

// ── Commands ───────────────────────────────────────────────────────────────────────

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

function cmdStatus(json: boolean): void {
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

  // Try health check
  try {
    const port = inferPort();
    const result = execSync(`curl -sf http://127.0.0.1:${port}/engram/v1/health`, {
      timeout: 3000,
      encoding: "utf8",
    });
    const health = JSON.parse(result);
    console.log(`Health: ${health.status ?? "ok"}`);
  } catch {
    console.log("Health: unable to reach server");
  }
}

async function cmdQuery(queryText: string, json: boolean): Promise<void> {
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
  const service = new EngramAccessService(orchestrator);

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
  checks.push({ name: "OPENAI_API_KEY", ok: hasApiKey, detail: hasApiKey ? "set" : "not set (extraction will not work)" });
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
  console.log(fs.readFileSync(configPath, "utf8"));
}

// ── M4 commands ────────────────────────────────────────────────────────────────

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
  console.log(`  ${s.kind} (${s.size} bytes)`);
  }).join(", "));
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
  console.log(`Duration: ${result.durationMs}m`);
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
      console.log(`[${item.reviewReason}] ${item.id.slice(0, 8)}... ${item.content.slice(0, 80)}${item.content.length > 80 ? "..." : ""}`);
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
  const sourceDir = rest[0] ?? ".";
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
  } else if (action === "watch") {
    const { stop } = watchForChanges(
      { sourceDir, memoryDir },
      (changes) => {
        console.log(`Changed: ${changes.length} files(s)`);
          console.log(`  [${c.type}] ${c.relativePath}`);
        },
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
    console.log(`Duration: ${result.durationMs}m`);
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
      cmdStatus(json);
      break;

    case "query": {
      const json = rest.includes("--json");
      const queryText = rest.filter((a) => !a.startsWith("--")).join(" ");
      await cmdQuery(queryText, json);
      break;

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

    case "tree": {
      const subAction = rest[0];
      if (subAction === "generate" || subAction === "watch" || subAction === "validate") {
        console.log(`Tree ${subAction} — not yet implemented`);
      } else {
        console.log("Usage: engram tree <generate|watch|validate>");
      }
      break;

    case "onboard": {
      const dir = rest[0] ?? ".";
      const json = rest.includes("--json");
      cmdOnboard(dir, json);
      break;

    case "curate": {
      const targetPath = rest[0];
      const json = rest.includes("--json");
      if (!targetPath) {
        console.error("Usage: engram curate <path>");
        process.exit(1);
      }
      await cmdCurate(targetPath, json);
      break;

    case "review": {
      const action = rest[0] ?? "list";
      cmdReview(action, rest.slice(1));
      break;

    case "sync": {
      const action = rest[0] ?? "run";
      const json = rest.includes("--json");
      cmdSync(action, rest.slice(1), json);
      break;

    case "dedup": {
      const json = rest.includes("--json");
      cmdDedup(json);
      break;

    default:
      console.log(`
engram — Engram memory CLI

Usage:
  engram init                  Create config file
  engram status [--json]       Show server status
  engram query <text> [--json] Query memories
  engram doctor                Run diagnostics
  engram config                Show current config
  engram daemon <start|stop|restart>  Manage background server
  engram tree <generate|watch|validate>  Generate context tree
  engram onboard [dir] [--json]     Onboard project directory
  engram curate <path> [--json]  Curate files into memory
  engram review <list|approve|dismiss|flag> [id]  Review inbox
  engram sync <run|watch> [--source <dir>] Diff-aware sync
  engram dedup [--json]             Find duplicate memories

Options:
  --json    Output in JSON format
  --help    Show this help
`);
      break;
  }
}

// Auto-run when executed directly
if (
  process.argv[1]?.endsWith("engram.ts") ||
  process.argv[1]?.endsWith("engram.js")
) {
  main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}

