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
 * Detect whether a daemon is already running by checking the PID file.
 */
function isDaemonRunning(): boolean {
  const pidFile = path.join(resolveHomeDir(), ".engram", "server.pid");
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Read daemon port from engram config.
 */
function readDaemonPort(): number {
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
 * Check if the daemon is reachable via HTTP health check.
 */
export async function checkDaemonHealth(host: string, port: number): Promise<boolean> {
  try {
    const { request } = await import("node:http");
    return new Promise((resolve) => {
      const req = request(
        { hostname: host, port, path: "/health", method: "GET", timeout: 2000 },
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
