/**
 * @remnic/server
 *
 * Standalone Remnic memory server.
 *
 * Loads config from `remnic.config.json` (or env vars), creates an Orchestrator,
 * and starts the HTTP access server with MCP endpoint — no OpenClaw required.
 *
 * Usage:
 *   npx remnic-server
 *   npx remnic-server --config ./my-remnic.json
 *   npx remnic-server --port 4320
 */

import fs from "node:fs";
import path from "node:path";
import { parseConfig, Orchestrator, EngramAccessService, EngramAccessHttpServer, initLogger, log, getAllValidTokens, getAllValidTokensCached, type PluginConfig } from "@remnic/core";

// ── Config loading ──────────────────────────────────────────────────────────

export interface ServerConfig {
  remnic: Record<string, unknown>;
  server: {
    host?: string;
    port?: number;
    authToken?: string;
    principal?: string;
    maxBodyBytes?: number;
    adminConsoleEnabled?: boolean;
  };
}

function readCompatEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

function resolveConfigPath(cliPath?: string): string {
  if (cliPath) return path.resolve(cliPath);

  const envPath = readCompatEnv("REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH");
  if (envPath) return path.resolve(envPath);

  const homeDir = process.env.HOME ?? "~";
  const candidates = [
    path.join(process.cwd(), "remnic.config.json"),
    path.join(process.cwd(), "engram.config.json"),
    path.join(homeDir, ".config", "remnic", "config.json"),
    path.join(homeDir, ".config", "engram", "config.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return path.join(homeDir, ".config", "remnic", "config.json");
}

function loadConfigFile(configPath: string): ServerConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    remnic: raw.remnic ?? raw.engram ?? raw ?? {},
    server: raw.server ?? {},
  };
}

function envOverrides(): Partial<ServerConfig["server"]> & { remnic?: Record<string, unknown> } {
  const overrides: Record<string, unknown> = {};
  const remnic: Record<string, unknown> = {};

  const port = readCompatEnv("REMNIC_PORT", "ENGRAM_PORT");
  const host = readCompatEnv("REMNIC_HOST", "ENGRAM_HOST");
  const authToken = readCompatEnv("REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN");
  if (port) overrides.port = parseInt(port, 10);
  if (host) overrides.host = host;
  if (authToken) overrides.authToken = authToken;

  if (process.env.OPENAI_API_KEY) remnic.openaiApiKey = process.env.OPENAI_API_KEY;
  const memoryDir = readCompatEnv("REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR");
  if (memoryDir) remnic.memoryDir = memoryDir;

  return { ...overrides, ...(Object.keys(remnic).length > 0 ? { remnic } : {}) };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Like `setTimeout` wrapped in a Promise, but respects an `AbortSignal`.
 * Resolves immediately (without throwing) when the signal fires so the
 * caller can check `signal.aborted` and exit cleanly.
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Server startup ──────────────────────────────────────────────────────────

export interface ServerResult {
  config: PluginConfig;
  service: EngramAccessService;
  httpServer: EngramAccessHttpServer;
  host: string;
  port: number;
  /** Cancel any pending startup-sync retry timers. Called automatically on shutdown. */
  cancelStartupSync: () => void;
}

export async function startServer(options?: {
  configPath?: string;
  host?: string;
  port?: number;
  authToken?: string;
}): Promise<ServerResult> {
  initLogger();

  const configPath = resolveConfigPath(options?.configPath);
  const fileConfig = fs.existsSync(configPath)
    ? loadConfigFile(configPath)
    : { remnic: {}, server: {} };

  const env = envOverrides();

  // Merge: file < env < cli flags
  const remnicConfig = { ...fileConfig.remnic, ...(env.remnic ?? {}) };
  const serverConfig = {
    ...fileConfig.server,
    ...env,
    ...(options?.host ? { host: options.host } : {}),
    ...(options?.port ? { port: options.port } : {}),
    ...(options?.authToken ? { authToken: options.authToken } : {}),
  };

  const config = parseConfig(remnicConfig);
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();

  // Start the HTTP server immediately so health checks, MCP handshakes,
  // and liveness probes can connect while deferred init is still running.
  const service = new EngramAccessService(orchestrator);

  const authToken = serverConfig.authToken ?? readCompatEnv("REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN") ?? "";

  // Connector tokens are loaded dynamically per request via authTokensGetter
  // so that token generate/revoke takes effect without server restart
  if (!authToken && getAllValidTokens().length === 0) {
    log.warn("No auth token set — server will reject all requests. Set REMNIC_AUTH_TOKEN, server.authToken in config, or generate tokens with 'remnic token generate'.");
  }

  const httpServer = new EngramAccessHttpServer({
    service,
    host: serverConfig.host ?? "127.0.0.1",
    port: serverConfig.port ?? 4318,
    authToken: authToken || undefined,
    authTokensGetter: () => getAllValidTokensCached(),
    principal: serverConfig.principal,
    maxBodyBytes: serverConfig.maxBodyBytes,
    adminConsoleEnabled: serverConfig.adminConsoleEnabled ?? false,
    citationsEnabled: config.citationsEnabled,
    citationsAutoDetect: config.citationsAutoDetect,
  });

  const { host, port } = await httpServer.start();

  // Fire-and-forget: wait for deferred init (QMD probe, collection setup,
  // warmup) then check QMD availability and retry if needed. This does NOT
  // block the server listener — connections are accepted immediately above.
  // An AbortController allows the shutdown handler to cancel pending retries.
  const startupSyncAbort = new AbortController();

  orchestrator.deferredReady.then(() => {
    if (!orchestrator.qmd.isAvailable() && orchestrator.qmd.debugStatus() !== "backend=noop") {
      const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
      (async () => {
        for (const delay of RETRY_DELAYS_MS) {
          await abortableDelay(delay, startupSyncAbort.signal);

          if (startupSyncAbort.signal.aborted) {
            log.debug("QMD startup-sync retry: cancelled by shutdown");
            return;
          }

          const synced = await orchestrator.startupSearchSync();
          if (!synced) {
            log.debug(`QMD startup-sync retry: not available yet (next retry in ${RETRY_DELAYS_MS[RETRY_DELAYS_MS.indexOf(delay) + 1] ?? "n/a"}ms)`);
            continue;
          }

          return; // sync succeeded, stop retrying
        }

        log.warn("QMD startup-sync retry: exhausted all retries; search index may be stale");
      })().catch((err) => {
        log.warn(`QMD startup-sync retry: unexpected error: ${err}`);
      });
    }
  }).catch((err) => {
    log.warn(`Deferred init error: ${err}`);
  });

  return { config, service, httpServer, host, port, cancelStartupSync: () => startupSyncAbort.abort() };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

function parseCliArgs(argv: string[]): Record<string, string | undefined> {
  const args: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

export async function cliMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);

  if (args.help) {
    console.log(`
remnic-server — Standalone Remnic memory server

Usage:
  remnic-server [options]

Options:
  --config <path>     Path to config file (default: remnic.config.json)
  --host <addr>       Bind address (default: 127.0.0.1)
  --port <number>     Port number (default: 4318)
  --auth-token <tok>  Bearer token for auth (or set REMNIC_AUTH_TOKEN)
  --help              Show this help

Environment:
  REMNIC_CONFIG_PATH   Config file path (ENGRAM_CONFIG_PATH also supported)
  REMNIC_PORT          Server port (ENGRAM_PORT also supported)
  REMNIC_HOST          Bind address (ENGRAM_HOST also supported)
  REMNIC_AUTH_TOKEN    Auth bearer token (ENGRAM_AUTH_TOKEN also supported)
  REMNIC_MEMORY_DIR    Override memory directory (ENGRAM_MEMORY_DIR also supported)
  OPENAI_API_KEY       OpenAI API key for extraction
`);
    process.exit(0);
  }

  const result = await startServer({
    configPath: args.config,
    host: args.host,
    port: args.port ? parseInt(args.port, 10) : undefined,
    authToken: args["auth-token"],
  });

  console.log(`Remnic server listening on http://${result.host}:${result.port}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    result.cancelStartupSync();
    await result.httpServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Auto-run when executed directly
// Matches: `node .../remnic-server/dist/index.js`, `node .../remnic-server/src/index.ts`,
// `npx remnic-server`, `npx engram-server`, but NOT test files under those directories
if (
  process.argv[1] &&
  (/remnic-server[\\/](?:dist|src)[\\/]index\.[jt]s$/.test(process.argv[1]) ||
   /engram-server[\\/](?:dist|src)[\\/]index\.[jt]s$/.test(process.argv[1]) ||
   process.argv[1].endsWith("remnic-server") ||
   process.argv[1].endsWith("engram-server"))
) {
  cliMain().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
