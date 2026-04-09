/**
 * OEO Bridge — Embedded vs Delegate mode for the OpenClaw Remnic bridge.
 *
 * Embedded mode (default): Starts EMO in-process AND exposes HTTP :4318
 * so external agents (Claude Code, Codex, etc.) can share the same memory.
 *
 * Delegate mode: Connects to a running EMO daemon instead of starting in-process.
 * Used when `remnic daemon install` has been run and the daemon is already active.
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
const LEGACY_HEALTH_PATH = "/engram/v1/health";

function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~";
}

function readCompatEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

function configPathCandidates(): string[] {
  const envPath = readCompatEnv("REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH");
  return [
    ...(envPath ? [path.resolve(envPath)] : []),
    path.join(resolveHomeDir(), ".config", "remnic", "config.json"),
    path.join(resolveHomeDir(), ".config", "engram", "config.json"),
    path.join(process.cwd(), "remnic.config.json"),
    path.join(process.cwd(), "engram.config.json"),
  ];
}

/**
 * Detect whether a daemon is already running by checking the PID file
 * and the system service manager (launchd on macOS, systemd on Linux).
 */
function isDaemonRunning(): boolean {
  for (const pidFile of [
    path.join(resolveHomeDir(), ".remnic", "server.pid"),
    path.join(resolveHomeDir(), ".engram", "server.pid"),
  ]) {
    try {
      const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      process.kill(pid, 0);
      return true;
    } catch {
      // PID file missing or stale — continue checking
    }
  }
  try {
    if (process.platform === "darwin") {
      for (const label of ["ai.remnic.daemon", "ai.engram.daemon"]) {
        const out = execSync(`launchctl list ${label} 2>/dev/null`, { encoding: "utf8" });
        if (out.includes('"PID"')) return true;
      }
    } else if (process.platform === "linux") {
      for (const unit of ["remnic.service", "engram.service"]) {
        const out = execSync(`systemctl --user is-active ${unit} 2>/dev/null`, { encoding: "utf8" }).trim();
        if (out === "active") return true;
      }
    }
  } catch {
    // service not registered
  }
  return false;
}

/**
 * Read daemon port from environment or remnic config.
 */
function readDaemonPort(): number {
  const envPort = readCompatEnv("REMNIC_PORT", "ENGRAM_PORT");
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  try {
    for (const p of configPathCandidates()) {
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
 * - If REMNIC_BRIDGE_MODE env is set, use that.
 * - If a daemon is already running, use delegate mode.
 * - Otherwise, use embedded mode.
 */
export function detectBridgeMode(): BridgeConfig {
  const envMode = readCompatEnv("REMNIC_BRIDGE_MODE", "ENGRAM_BRIDGE_MODE")?.toLowerCase();

  if (envMode === "delegate") {
    return {
      mode: "delegate",
      daemonHost: readCompatEnv("REMNIC_HOST", "ENGRAM_HOST") ?? DEFAULT_HOST,
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
      daemonHost: readCompatEnv("REMNIC_HOST", "ENGRAM_HOST") ?? DEFAULT_HOST,
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
  const tokenPaths = [
    path.join(resolveHomeDir(), ".remnic", "tokens.json"),
    path.join(resolveHomeDir(), ".engram", "tokens.json"),
  ];
  try {
    for (const tokensPath of tokenPaths) {
      if (!existsSync(tokensPath)) continue;
      const store = JSON.parse(readFileSync(tokensPath, "utf8"));
      const tokens = Array.isArray(store.tokens) ? store.tokens : [];
      if (tokens.length > 0 && tokens[0].token) return tokens[0].token;
      if (typeof store === "object" && store !== null) {
        for (const val of Object.values(store)) {
          if (
            typeof val === "string" &&
            val.length > 0 &&
            (val.startsWith("remnic_") || val.startsWith("engram_"))
          ) {
            return val;
          }
        }
      }
    }
  } catch {
    // ignore — fall through to config/env
  }
  try {
    for (const p of configPathCandidates()) {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        if (raw.server?.authToken) return raw.server.authToken;
      }
    }
  } catch {
    // ignore
  }
  return (
    process.env.OPENCLAW_REMNIC_ACCESS_TOKEN ??
    process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN ??
    readCompatEnv("REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN") ??
    ""
  );
}

/**
 * Check if the daemon is reachable via HTTP health check.
 * Uses the authenticated legacy health endpoint for compatibility.
 */
export async function checkDaemonHealth(host: string, port: number): Promise<boolean> {
  try {
    const { request } = await import("node:http");
    const token = loadAnyToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    return new Promise((resolve) => {
      const req = request(
        { hostname: host, port, path: LEGACY_HEALTH_PATH, method: "GET", timeout: 2000, headers },
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
