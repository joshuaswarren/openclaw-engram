/**
 * OEO Bridge — Embedded vs Delegate mode for OpenClaw Engram Orchestrator.
 *
 * Embedded mode (default): Starts EMO in-process AND exposes HTTP :4318
 * so external agents (Claude Code, Codex, etc.) can share the same memory.
 *
 * Delegate mode: Connects to a running EMO daemon instead of starting in-process.
 * Used when `engram daemon install` has been run and the daemon is already active.
 */

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

export type BridgeMode = "embedded" | "delegate";

export interface BridgeConfig {
  mode: BridgeMode;
  daemonHost: string;
  daemonPort: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4318;

function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~";
}

/**
 * Detect whether a daemon is already running by checking the PID file
 * and the system service manager (launchd on macOS, systemd on Linux).
 */
function isDaemonRunning(): boolean {
  // Check PID file (manual `engram daemon start`)
  const pidFile = path.join(resolveHomeDir(), ".engram", "server.pid");
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    // PID file missing or stale — check service manager
  }
  // Check launchd (macOS) or systemd (Linux) for daemons started via `engram daemon install`
  try {
    if (process.platform === "darwin") {
      const out = execSync("launchctl list ai.engram.daemon 2>/dev/null", { encoding: "utf8" });
      if (out.includes('"PID"')) return true;
    } else if (process.platform === "linux") {
      const out = execSync("systemctl --user is-active engram.service 2>/dev/null", { encoding: "utf8" }).trim();
      if (out === "active") return true;
    }
  } catch {
    // service not registered
  }
  return false;
}

/**
 * Read daemon port from environment or engram config.
 */
function readDaemonPort(): number {
  // Environment takes precedence (matches daemon startup behavior)
  const envPort = process.env.ENGRAM_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  try {
    const configPaths = [
      path.join(resolveHomeDir(), ".config", "engram", "config.json"),
      path.join(process.cwd(), "engram.config.json"),
    ];
    for (const p of configPaths) {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        if (raw.server?.port) return raw.server.port;
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_PORT;
}

/**
 * Determine bridge mode:
 * - If ENGRAM_BRIDGE_MODE env is set, use that.
 * - If a daemon is already running, use delegate mode.
 * - Otherwise, use embedded mode.
 */
export function detectBridgeMode(): BridgeConfig {
  const envMode = process.env.ENGRAM_BRIDGE_MODE?.toLowerCase();

  if (envMode === "delegate") {
    return {
      mode: "delegate",
      daemonHost: process.env.ENGRAM_HOST ?? DEFAULT_HOST,
      daemonPort: readDaemonPort(),
    };
  }

  if (envMode === "embedded") {
    return {
      mode: "embedded",
      daemonHost: DEFAULT_HOST,
      daemonPort: readDaemonPort(),
    };
  }

  // Auto-detect: if daemon is running, delegate; otherwise embedded
  if (isDaemonRunning()) {
    return {
      mode: "delegate",
      daemonHost: process.env.ENGRAM_HOST ?? DEFAULT_HOST,
      daemonPort: readDaemonPort(),
    };
  }

  return {
    mode: "embedded",
    daemonHost: DEFAULT_HOST,
    daemonPort: readDaemonPort(),
  };
}

/**
 * Load the first valid auth token for health check.
 */
function loadAnyToken(): string {
  try {
    const tokensPath = path.join(resolveHomeDir(), ".engram", "tokens.json");
    if (existsSync(tokensPath)) {
      const store = JSON.parse(readFileSync(tokensPath, "utf8"));
      // New array format
      const tokens = Array.isArray(store.tokens) ? store.tokens : [];
      if (tokens.length > 0 && tokens[0].token) return tokens[0].token;
      // Legacy flat-map format: {"connector": "token_value", ...}
      if (typeof store === "object" && store !== null) {
        for (const val of Object.values(store)) {
          if (typeof val === "string" && val.length > 0 && val.startsWith("engram_")) return val;
        }
      }
    }
  } catch {
    // ignore — fall through to config/env
  }
  // Check config file authToken (matches server startup)
  try {
    const configPaths = [
      path.join(resolveHomeDir(), ".config", "engram", "config.json"),
      path.join(process.cwd(), "engram.config.json"),
    ];
    for (const p of configPaths) {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        if (raw.server?.authToken) return raw.server.authToken;
      }
    }
  } catch {
    // ignore
  }
  return process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN ?? process.env.ENGRAM_AUTH_TOKEN ?? "";
}

/**
 * Check if the daemon is reachable via HTTP health check.
 * Uses the authenticated /engram/v1/health endpoint.
 */
export async function checkDaemonHealth(host: string, port: number): Promise<boolean> {
  try {
    const { request } = await import("node:http");
    const token = loadAnyToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    return new Promise((resolve) => {
      const req = request(
        { hostname: host, port, path: "/engram/v1/health", method: "GET", timeout: 2000, headers },
        (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  } catch {
    return false;
  }
}
