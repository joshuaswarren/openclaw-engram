/**
 * @engram/server
 *
 * Standalone Engram memory server.
 *
 * Loads config from `engram.config.json` (or env vars), creates an Orchestrator,
 * and starts the HTTP access server with MCP endpoint — no OpenClaw required.
 *
 * Usage:
 *   npx engram-server
 *   npx engram-server --config ./my-engram.json
 *   npx engram-server --port 4320
 */

import fs from "node:fs";
import path from "node:path";
import { parseConfig, Orchestrator, EngramAccessService, EngramAccessHttpServer, initLogger, log, getAllValidTokens, type PluginConfig } from "@engram/core";

// ── Config loading ──────────────────────────────────────────────────────────

export interface ServerConfig {
  engram: Record<string, unknown>;
  server: {
    host?: string;
    port?: number;
    authToken?: string;
    principal?: string;
    maxBodyBytes?: number;
    adminConsoleEnabled?: boolean;
  };
}

function resolveConfigPath(cliPath?: string): string {
  if (cliPath) return path.resolve(cliPath);

  const envPath = process.env.ENGRAM_CONFIG_PATH;
  if (envPath) return path.resolve(envPath);

  // Check CWD first, then home
  const cwdPath = path.join(process.cwd(), "engram.config.json");
  if (fs.existsSync(cwdPath)) return cwdPath;

  return path.join(
    process.env.HOME ?? "~",
    ".config",
    "engram",
    "config.json",
  );
}

function loadConfigFile(configPath: string): ServerConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return {
    engram: raw.engram ?? raw ?? {},
    server: raw.server ?? {},
  };
}

function envOverrides(): Partial<ServerConfig["server"]> & { engram?: Record<string, unknown> } {
  const overrides: Record<string, unknown> = {};
  const engram: Record<string, unknown> = {};

  // Server env vars
  if (process.env.ENGRAM_PORT) overrides.port = parseInt(process.env.ENGRAM_PORT, 10);
  if (process.env.ENGRAM_HOST) overrides.host = process.env.ENGRAM_HOST;
  if (process.env.ENGRAM_AUTH_TOKEN) overrides.authToken = process.env.ENGRAM_AUTH_TOKEN;

  // Core env vars
  if (process.env.OPENAI_API_KEY) engram.openaiApiKey = process.env.OPENAI_API_KEY;
  if (process.env.ENGRAM_MEMORY_DIR) engram.memoryDir = process.env.ENGRAM_MEMORY_DIR;

  return { ...overrides, ...(Object.keys(engram).length > 0 ? { engram } : {}) };
}

// ── Server startup ──────────────────────────────────────────────────────────

export interface ServerResult {
  config: PluginConfig;
  service: EngramAccessService;
  httpServer: EngramAccessHttpServer;
  host: string;
  port: number;
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
    : { engram: {}, server: {} };

  const env = envOverrides();

  // Merge: file < env < cli flags
  const engramConfig = { ...fileConfig.engram, ...(env.engram ?? {}) };
  const serverConfig = {
    ...fileConfig.server,
    ...env,
    ...(options?.host ? { host: options.host } : {}),
    ...(options?.port ? { port: options.port } : {}),
    ...(options?.authToken ? { authToken: options.authToken } : {}),
  };

  const config = parseConfig(engramConfig);
  const orchestrator = new Orchestrator(config);
  const service = new EngramAccessService(orchestrator);

  const authToken = serverConfig.authToken ?? process.env.ENGRAM_AUTH_TOKEN ?? "";

  // Connector tokens are loaded dynamically per request via authTokensGetter
  // so that token generate/revoke takes effect without server restart
  if (!authToken && getAllValidTokens().length === 0) {
    log.warn("No auth token set — server will reject all requests. Set ENGRAM_AUTH_TOKEN, server.authToken in config, or generate tokens with 'engram token generate'.");
  }

  const httpServer = new EngramAccessHttpServer({
    service,
    host: serverConfig.host ?? "127.0.0.1",
    port: serverConfig.port ?? 4318,
    authToken: authToken || undefined,
    authTokensGetter: () => getAllValidTokens(),
    principal: serverConfig.principal,
    maxBodyBytes: serverConfig.maxBodyBytes,
    adminConsoleEnabled: serverConfig.adminConsoleEnabled ?? false,
  });

  const { host, port } = await httpServer.start();

  return { config, service, httpServer, host, port };
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
engram-server — Standalone Engram memory server

Usage:
  engram-server [options]

Options:
  --config <path>     Path to config file (default: engram.config.json)
  --host <addr>       Bind address (default: 127.0.0.1)
  --port <number>     Port number (default: 4318)
  --auth-token <tok>  Bearer token for auth (or set ENGRAM_AUTH_TOKEN)
  --help              Show this help

Environment:
  ENGRAM_CONFIG_PATH   Config file path
  ENGRAM_PORT          Server port
  ENGRAM_HOST          Bind address
  ENGRAM_AUTH_TOKEN    Auth bearer token
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

  console.log(`Engram server listening on http://${result.host}:${result.port}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await result.httpServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Auto-run when executed directly
// Matches: `node .../engram-server/dist/index.js`, `node .../engram-server/src/index.ts`,
// `npx engram-server`, but NOT test files under the engram-server directory
if (
  process.argv[1] &&
  (/engram-server[\\/](?:dist|src)[\\/]index\.[jt]s$/.test(process.argv[1]) ||
   process.argv[1].endsWith("engram-server"))
) {
  cliMain().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
