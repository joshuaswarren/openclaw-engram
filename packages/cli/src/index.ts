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
 */

import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { parseConfig, Orchestrator, EngramAccessService, initLogger } from "@engram/core";

// ── Types ────────────────────────────────────────────────────────────────────

type CommandName =
  | "init"
  | "status"
  | "query"
  | "doctor"
  | "config"
  | "daemon";

type DaemonAction = "start" | "stop" | "restart";

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

function cmdQuery(queryText: string, json: boolean): void {
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

  service
    .recall({ query: queryText, mode: "auto" })
    .then((result) => {
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
    })
    .catch((err: Error) => {
      console.error("Query failed:", err.message);
      process.exit(1);
    });
}

function cmdDoctor(): void {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Node version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  checks.push({
    name: "Node.js version",
    ok: nodeMajor >= 22,
    detail: `${nodeVersion} (requires >= 22.12.0)`,
  });

  // 2. Config file
  const configPath = resolveConfigPath();
  const configExists = fs.existsSync(configPath);
  checks.push({ name: "Config file", ok: configExists, detail: configPath });

  // 3. API key
  const hasApiKey = !!process.env.OPENAI_API_KEY;
  checks.push({ name: "OPENAI_API_KEY", ok: hasApiKey, detail: hasApiKey ? "set" : "not set (extraction will not work)" });

  // 4. Memory dir writable
  const memoryDir = path.join(process.env.HOME ?? "~", ".openclaw", "workspace", "memory", "local");
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    checks.push({ name: "Memory directory", ok: true, detail: memoryDir });
  } catch {
    checks.push({ name: "Memory directory", ok: false, detail: `cannot create ${memoryDir}` });
  }

  // 5. Daemon
  checks.push({
    name: "Server daemon",
    ok: isDaemonRunning(),
    detail: isDaemonRunning() ? `running (pid ${readPid()})` : "stopped",
  });

  // Print results
  for (const check of checks) {
    const icon = check.ok ? "✓" : "✗";
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
  }

  const allOk = checks.every((c) => c.ok);
  if (!allOk) {
    console.log("\nSome checks failed. Run `engram init` to get started.");
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

// ── Daemon management ────────────────────────────────────────────────────────

function isDaemonRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    // Process doesn't exist — clean up stale PID file
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
    }

    case "query": {
      const json = rest.includes("--json");
      const queryText = rest.filter((a) => !a.startsWith("--")).join(" ");
      await cmdQuery(queryText, json);
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
