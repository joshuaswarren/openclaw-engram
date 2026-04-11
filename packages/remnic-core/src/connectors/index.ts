/**
 * @remnic/core — Connector Manager
 *
 * Metadata-driven registry for host adapters (Codex CLI, Claude Code, Cursor, etc.).
 * Manages connector lifecycle: install, remove, configure, health.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { generateToken, revokeToken } from "../tokens.js";

// Native memory artifact materialization for Codex CLI (#378). Surfaced here
// so downstream callers can `import { materializeForNamespace } from "@remnic/core/connectors"`.
export {
  materializeForNamespace,
  ensureSentinel,
  describeMemoriesDir,
  renderMemorySummary,
  renderMemoryMd,
  renderRawMemories,
  renderRolloutSummary,
  validateMemoryMd,
  approximateTokenCount,
  truncateToTokenBudget,
  MATERIALIZE_VERSION,
  SENTINEL_FILE,
  TMP_DIR,
  type MaterializeOptions,
  type MaterializeResult,
  type RolloutSummaryInput,
  type MemoryMdValidation,
} from "./codex-materialize.js";
export {
  runCodexMaterialize,
  type RunMaterializeOptions,
} from "./codex-materialize-runner.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConnectorManifest {
  /** Unique connector ID (e.g. "claude-code", "codex-cli") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Version */
  version: string;
  /** Description */
  description: string;
  /** Capabilities */
  capabilities: ConnectorCapability;
  /** Required config fields */
  configSchema?: Record<string, string>;
  /** Whether currently installed */
  installed?: boolean;
  /** Homepage URL */
  homepage?: string;
  /** Author */
  author?: string;
  /** Repository URL */
  repository?: string;
  /** Tags */
  tags?: string[];
}

export interface ConnectorCapability {
  /** Can observe conversations */
  observe: boolean;
  /** Can recall/query memories */
  recall: boolean;
  /** Can store memories */
  store: boolean;
  /** Can search */
  search: boolean;
  /** Can manage entities */
  entities: boolean;
  /** Supports real-time sync */
  realtimeSync: boolean;
  /** Supports batch operations */
  batch: boolean;
  /** Max memory budget in chars */
  maxBudgetChars?: number;
  /** Connection type */
  connectionType: "mcp" | "http" | "cli" | "sdk" | "embedded";
}

export interface ConnectorInstance {
  /** Connector ID */
  connectorId: string;
  /** Resolved config */
  config: Record<string, unknown>;
  /** Status */
  status: "installed" | "running" | "error" | "disabled";
  /** Installed at timestamp */
  installedAt?: string;
  /** Error message if erro */
  error?: string;
}

export interface ConnectorRegistry {
  /** Known connectors */
  connectors: ConnectorManifest[];
  /** Registry file path */
  registryPath: string;
}

export interface InstallOptions {
  /** Connector ID to install */
  connectorId: string;
  /** Config values */
  config?: Record<string, unknown>;
  /** Memory directory */
  memoryDir?: string;
  /** Whether to force reinstall */
  force?: boolean;
}

export interface InstallResult {
  /** Connector ID */
  connectorId: string;
  /** Status */
  status: "installed" | "already_installed" | "config_required" | "error";
  /** Config path */
  configPath?: string;
  /** Message */
  message: string;
}

export interface RemoveResult {
  /** Connector ID */
  connectorId: string;
  /** Removed config path */
  configPath: string;
  /** Message */
  message: string;
}

export interface DoctorResult {
  /** Connector ID */
  connectorId: string;
  /** Checks */
  checks: DoctorCheck[];
  /** All healthy */
  healthy: boolean;
}

export interface DoctorCheck {
  /** Check name */
  name: string;
  /** Passed */
  ok: boolean;
  /** Detail */
  detail: string;
}

// ── Built-in connector definitions ─────────────────────────────────────────

const BUILTIN_CONNECTORS: ConnectorManifest[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    version: "1.0.0",
    description: "Anthropic's Claude Code CLI — direct memory access via MCP",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: true,
      realtimeSync: true,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
      namespace: "Optional namespace (default: 'default')",
    },
    homepage: "https://claude.ai/code",
    author: "Anthropic",
    tags: ["official", "ai", "claude"],
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    version: "1.0.0",
    description: "OpenAI Codex CLI — memory via MCP tool",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: false,
      entities: false,
      realtimeSync: false,
      batch: true,
      maxBudgetChars: 8000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
      namespace: "Optional namespace",
    },
    homepage: "https://openai.com/codex",
    author: "OpenAI",
    tags: ["official", "ai", "codex"],
  },
  {
    id: "cursor",
    name: "Cursor IDE",
    version: "1.0.0",
    description: "Cursor IDE — memory via config file + tool calls",
    capabilities: {
      observe: false,
      recall: true,
      store: false,
      search: true,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "embedded",
    },
    configSchema: {
      memoryDir: "Path to Remnic memory directory",
    },
    homepage: "https://cursor.com",
    author: "Cursor Inc.",
    tags: ["official", "ide"],
  },
  {
    id: "cline",
    name: "Cline",
    version: "1.0.0",
    description: "VS Code Cline extension — memory via MCP",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: false,
      entities: false,
      realtimeSync: false,
      batch: true,
      maxBudgetChars: 8000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
      namespace: "Optional namespace",
    },
    homepage: "https://github.com/cline/cline",
    author: "Cline",
    tags: ["community", "vscode"],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    version: "1.0.0",
    description: "GitHub Copilot — memory via MCP server",
    capabilities: {
      observe: false,
      recall: true,
      store: false,
      search: true,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 16000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
    },
    homepage: "https://github.com/features/copilot",
    author: "GitHub",
    tags: ["official", "ai", "github"],
  },
  {
    id: "roo-code",
    name: "Roo Code",
    version: "1.0.0",
    description: "Roo Code — memory via MCP",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: false,
      entities: false,
      realtimeSync: false,
      batch: true,
      maxBudgetChars: 16000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
      namespace: "Optional namespace",
    },
    homepage: "https://roocode.com",
    author: "Roo Code",
    tags: ["community", "vscode"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    version: "1.0.0",
    description: "Windsurf IDE — memory via MCP",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
    },
    homepage: "https://windsurf.com",
    author: "Codeium",
    tags: ["official", "ide"],
  },
  {
    id: "amp",
    name: "Amp",
    version: "1.0.0",
    description: "Amp coding agent — memory via MCP",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
    },
    homepage: "https://ampcode.com",
    author: "Sourcegraph",
    tags: ["official", "ai"],
  },
  {
    id: "replit",
    name: "Replit Agent",
    version: "1.0.0",
    description: "Replit Agent — memory via HTTP API (reduced capabilities)",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: false,
      entities: false,
      realtimeSync: false,
      batch: false,
      maxBudgetChars: 8000,
      connectionType: "http",
    },
    configSchema: {
      apiUrl: "URL of the Remnic HTTP API",
      authToken: "Bearer token for authentication",
    },
    homepage: "https://replit.com",
    author: "Replit",
    tags: ["official", "cloud"],
  },
  {
    id: "generic-mcp",
    name: "Generic MCP Client",
    version: "1.0.0",
    description: "Any MCP-compatible client — connect via standard MCP protocol",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: true,
      realtimeSync: true,
      batch: true,
      maxBudgetChars: 64000,
      connectionType: "mcp",
    },
    configSchema: {
      mcpServerUrl: "URL of the MCP Remnic server",
      namespace: "Optional namespace",
      authToken: "Bearer token for authentication",
    },
    homepage: "https://github.com/joshuaswarren/remnic",
    author: "Remnic",
    tags: ["generic", "mcp"],
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    version: "1.0.0",
    description: "Hermes Agent MemoryProvider — automatic recall/observe on every turn via Python plugin protocol",
    capabilities: {
      observe: true,
      recall: true,
      store: true,
      search: true,
      entities: false,
      realtimeSync: true,
      batch: false,
      maxBudgetChars: 32000,
      connectionType: "http",
    },
    configSchema: {
      host: "Remnic daemon host (default: 127.0.0.1)",
      port: "Remnic daemon port (default: 4318)",
      profile: "Hermes profile name (default: default)",
    },
    homepage: "https://github.com/joshuaswarren/remnic/tree/main/packages/plugin-hermes",
    author: "Remnic",
    tags: ["official", "python", "hermes"],
  },
];

// ── Registry management ───────────────────────────────────────────────────

const REGISTRY_DIR_NAME = ".engram-connectors";

export function getRegistryPath(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "engram")
    : path.join(process.env.HOME ?? "~", ".config", "engram");
  return path.join(configDir, REGISTRY_DIR_NAME, "registry.json");
}

export function loadRegistry(): ConnectorRegistry {
  const regPath = getRegistryPath();

  if (!fs.existsSync(regPath)) {
    // First time — bootstrap with built-in connectors
    const registry: ConnectorRegistry = {
      connectors: BUILTIN_CONNECTORS,
      registryPath: regPath,
    };
    saveRegistry(registry);
    return registry;
  }

  const raw = fs.readFileSync(regPath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    // Merge built-ins with any custom connectors
    const customIds = new Set((parsed.connectors ?? []).map((c: ConnectorManifest) => c.id));
    const merged = [
      ...BUILTIN_CONNECTORS.filter((b) => !customIds.has(b.id)),
      ...(parsed.connectors ?? []),
    ];
    return {
      connectors: merged,
      registryPath: regPath,
    };
  } catch {
    const registry: ConnectorRegistry = {
      connectors: BUILTIN_CONNECTORS,
      registryPath: regPath,
    };
    saveRegistry(registry);
    return registry;
  }
}

export function saveRegistry(registry: ConnectorRegistry): void {
  const regPath = registry.registryPath;
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(regPath, JSON.stringify({ connectors: registry.connectors }, null, 2));
}

// ── List connectors ────────────────────────────────────────────────────────

export function listConnectors(): {
  installed: ConnectorInstance[];
  available: ConnectorManifest[];
} {
  const registry = loadRegistry();
  const connectorsDir = getConnectorsDir();
  const installedIds = new Set<string>();

  // Find installed connectors
  if (fs.existsSync(connectorsDir)) {
    for (const entry of fs.readdirSync(connectorsDir)) {
      if (entry.endsWith(".json")) {
        try {
          const config = JSON.parse(
            fs.readFileSync(path.join(connectorsDir, entry), "utf8"),
          );
          installedIds.add(config.connectorId as string);
        } catch {
          // ignore malformed configs
        }
      }
    }
  }

  // Mark installed vs available
  const available: ConnectorManifest[] = registry.connectors.map((manifest) => ({
    ...manifest,
    installed: installedIds.has(manifest.id),
  }));

  // Build installed list
  const installed: ConnectorInstance[] = [];
  for (const id of installedIds) {
    const configPath = path.join(connectorsDir, `${id}.json`);
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      installed.push({
        connectorId: id,
        config,
        status: "installed",
        installedAt: config.installedAt as string | undefined,
      });
    } catch {
      // ignore
    }
  }

  return { installed, available };
}

// ── Install connector ───────────────────────────────────────────────────────

export function installConnector(options: InstallOptions): InstallResult {
  const registry = loadRegistry();
  const manifest = registry.connectors.find((c) => c.id === options.connectorId);

  if (!manifest) {
    return {
      connectorId: options.connectorId,
      status: "error",
      message: `Unknown connector: ${options.connectorId}`,
    };
  }

  // Check if already installed
  const existing = listConnectors().installed.find(
    (c) => c.connectorId === options.connectorId,
  );

  if (existing && !options.force) {
    return {
      connectorId: options.connectorId,
      status: "already_installed",
      message: "Already installed. Use --force to reinstall.",
    };
  }

  // Write config
  const configDir = getConnectorsDir();
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = path.join(configDir, `${options.connectorId}.json`);

  // Generate a per-connector auth token so the daemon can authenticate
  // requests from this connector. generateToken() is idempotent — it filters
  // the old entry and writes a fresh one, so force-reinstall produces a new
  // token automatically. We do this for every connector because:
  //   a) token gen is always safe and idempotent
  //   b) several connectors (replit, hermes) need it to avoid 401s
  //   c) any connector that doesn't use token auth simply ignores the entry
  const tokenEntry = generateToken(options.connectorId);

  // Build config from schema defaults + user overrides
  const resolvedConfig: Record<string, unknown> = {
    connectorId: options.connectorId,
    installedAt: new Date().toISOString(),
    token: tokenEntry.token,
    ...options.config,
  };
  fs.writeFileSync(configPath, JSON.stringify(resolvedConfig, null, 2));

  const notes: string[] = [];

  // Hermes-specific: write the remnic: block to config.yaml
  if (options.connectorId === "hermes") {
    const profile = (options.config?.profile as string | undefined) ?? "default";
    const host = (options.config?.host as string | undefined) ?? "127.0.0.1";
    const port = (options.config?.port as number | undefined) ?? 4318;
    const yamlResult = upsertHermesConfig({
      profile,
      host,
      port,
      token: tokenEntry.token,
    });
    if (yamlResult.updated) {
      notes.push(`Updated Hermes config: ${yamlResult.configPath}`);
    } else if (yamlResult.skipped) {
      notes.push(`Hermes config not written: ${yamlResult.reason}`);
    }

    // Health-check the daemon (non-fatal)
    const daemonOk = checkDaemonHealth(host, port);
    if (daemonOk) {
      notes.push("Daemon health check: OK");
    } else {
      notes.push(
        `Daemon not reachable at ${host}:${port} — start with: remnic daemon start`,
      );
    }
  }

  const suffix = notes.length > 0 ? `\n  ${notes.join("\n  ")}` : "";
  return {
    connectorId: options.connectorId,
    status: "installed",
    configPath,
    message: `Installed ${manifest.name} v${manifest.version}${suffix}`,
  };
}

// ── Remove connector ───────────────────────────────────────────────────────

export function removeConnector(connectorId: string): RemoveResult {
  const configDir = getConnectorsDir();
  const configPath = path.join(configDir, `${connectorId}.json`);

  if (!fs.existsSync(configPath)) {
    return {
      connectorId,
      configPath,
      message: "Not installed",
    };
  }

  // Read connector config before deleting it (needed for hermes profile lookup)
  let storedProfile = "default";
  if (connectorId === "hermes") {
    try {
      const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (typeof stored?.profile === "string") storedProfile = stored.profile;
    } catch {
      // use default profile
    }
  }

  // Revoke the auth token for this connector so the daemon stops accepting it.
  revokeToken(connectorId);

  fs.unlinkSync(configPath);

  const notes: string[] = [];

  // Hermes-specific: strip the remnic: block from config.yaml
  if (connectorId === "hermes") {
    const yamlResult = removeHermesConfig({ profile: storedProfile });
    if (yamlResult.updated) {
      notes.push(`Removed remnic: block from Hermes config: ${yamlResult.configPath}`);
    } else if (yamlResult.skipped) {
      notes.push(`Hermes config cleanup skipped: ${yamlResult.reason}`);
    }
  }

  const suffix = notes.length > 0 ? `\n  ${notes.join("\n  ")}` : "";
  return {
    connectorId,
    configPath,
    message: `Removed${suffix}`,
  };
}

// ── Hermes config.yaml helpers ─────────────────────────────────────────────────

interface HermesConfigResult {
  updated: boolean;
  skipped: boolean;
  reason?: string;
  configPath: string;
}

function hermesConfigPath(profile: string): string {
  return path.join(os.homedir(), ".hermes", "profiles", profile, "config.yaml");
}

/**
 * Upsert the `remnic:` block in a Hermes profile config.yaml.
 *
 * Rules:
 * - If the profile directory does not exist, skip with a warning (we do not
 *   create arbitrary Hermes state).
 * - If config.yaml does not exist, create it with only the remnic: block.
 * - If config.yaml exists and already contains a `remnic:` block, update the
 *   host/port/token lines in-place (line-based, preserves comments elsewhere).
 * - If config.yaml exists with no `remnic:` block, append one.
 * - Idempotent on repeated calls.
 */
export function upsertHermesConfig(opts: {
  profile: string;
  host: string;
  port: number;
  token: string;
}): HermesConfigResult {
  const cfgPath = hermesConfigPath(opts.profile);
  const profileDir = path.dirname(cfgPath);

  if (!fs.existsSync(profileDir)) {
    return {
      updated: false,
      skipped: true,
      reason: `Hermes profile directory not found: ${profileDir}`,
      configPath: cfgPath,
    };
  }

  const block = [
    "remnic:",
    `  host: "${opts.host}"`,
    `  port: ${opts.port}`,
    `  token: "${opts.token}"`,
  ].join("\n");

  if (!fs.existsSync(cfgPath)) {
    // Create with just the remnic block
    fs.writeFileSync(cfgPath, block + "\n");
    return { updated: true, skipped: false, configPath: cfgPath };
  }

  const raw = fs.readFileSync(cfgPath, "utf8");

  // Check whether there's an existing remnic: block
  const hasRemnicBlock = /^remnic:/m.test(raw);

  if (!hasRemnicBlock) {
    // Append the block (preserve existing content)
    const separator = raw.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(cfgPath, raw + separator + block + "\n");
    return { updated: true, skipped: false, configPath: cfgPath };
  }

  // Update the existing block. Strategy: replace the content of the remnic:
  // section by matching from `^remnic:` to the next top-level key or end-of-file.
  // We rewrite only the host/port/token sub-keys inside the block; other keys
  // under remnic: (e.g. session_key, timeout) are preserved.
  const lines = raw.split("\n");
  const newLines: string[] = [];
  let inRemnicBlock = false;
  let blockWritten = false;

  // Track which sub-keys we've emitted
  const written = { host: false, port: false, token: false };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^remnic:/.test(line)) {
      inRemnicBlock = true;
      newLines.push(line);
      continue;
    }

    if (inRemnicBlock) {
      // A line that starts with a non-space character and is not empty signals
      // the start of the next top-level YAML key — we've left the remnic block.
      if (line.length > 0 && !/^\s/.test(line)) {
        // Emit any un-written keys before closing the block
        if (!written.host) newLines.push(`  host: "${opts.host}"`);
        if (!written.port) newLines.push(`  port: ${opts.port}`);
        if (!written.token) newLines.push(`  token: "${opts.token}"`);
        blockWritten = true;
        inRemnicBlock = false;
        newLines.push(line);
        continue;
      }

      // Replace host/port/token lines; preserve other sub-keys
      if (/^\s+host:/.test(line)) {
        newLines.push(`  host: "${opts.host}"`);
        written.host = true;
      } else if (/^\s+port:/.test(line)) {
        newLines.push(`  port: ${opts.port}`);
        written.port = true;
      } else if (/^\s+token:/.test(line)) {
        newLines.push(`  token: "${opts.token}"`);
        written.token = true;
      } else {
        newLines.push(line);
      }
      continue;
    }

    newLines.push(line);
  }

  if (inRemnicBlock && !blockWritten) {
    // File ended while still inside the remnic block
    if (!written.host) newLines.push(`  host: "${opts.host}"`);
    if (!written.port) newLines.push(`  port: ${opts.port}`);
    if (!written.token) newLines.push(`  token: "${opts.token}"`);
  }

  fs.writeFileSync(cfgPath, newLines.join("\n"));
  return { updated: true, skipped: false, configPath: cfgPath };
}

/**
 * Remove the `remnic:` block from a Hermes profile config.yaml.
 * Idempotent — if the block is absent, returns skipped.
 */
export function removeHermesConfig(opts: { profile: string }): HermesConfigResult {
  const cfgPath = hermesConfigPath(opts.profile);

  if (!fs.existsSync(cfgPath)) {
    return {
      updated: false,
      skipped: true,
      reason: "Hermes config.yaml not found",
      configPath: cfgPath,
    };
  }

  const raw = fs.readFileSync(cfgPath, "utf8");
  if (!/^remnic:/m.test(raw)) {
    return {
      updated: false,
      skipped: true,
      reason: "No remnic: block found in config.yaml",
      configPath: cfgPath,
    };
  }

  // Strip the remnic: block and its indented children
  const lines = raw.split("\n");
  const newLines: string[] = [];
  let inRemnicBlock = false;

  for (const line of lines) {
    if (/^remnic:/.test(line)) {
      inRemnicBlock = true;
      continue;
    }
    if (inRemnicBlock) {
      if (line.length > 0 && !/^\s/.test(line)) {
        inRemnicBlock = false;
        newLines.push(line);
      }
      // else: still in the block — skip the line
      continue;
    }
    newLines.push(line);
  }

  // Trim trailing blank lines left behind after the block removal
  while (newLines.length > 0 && newLines[newLines.length - 1]?.trim() === "") {
    newLines.pop();
  }

  fs.writeFileSync(cfgPath, newLines.length > 0 ? newLines.join("\n") + "\n" : "");
  return { updated: true, skipped: false, configPath: cfgPath };
}

// ── Daemon health check (synchronous, non-fatal) ────────────────────────────

/**
 * Ping /engram/v1/health synchronously.
 * Returns true if the daemon responds with HTTP 200, false otherwise.
 * Uses child_process.spawnSync to run a one-liner Node script so that the
 * existing synchronous installConnector() flow does not need to become async.
 */
function checkDaemonHealth(host: string, port: number): boolean {
  try {
    const script = [
      "const http = require('http');",
      `const req = http.get({host:${JSON.stringify(host)},port:${port},path:'/engram/v1/health',timeout:3000}, (res) => {`,
      "  process.exit(res.statusCode === 200 ? 0 : 1);",
      "});",
      "req.on('error', () => process.exit(1));",
      "req.on('timeout', () => { req.destroy(); process.exit(1); });",
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], { timeout: 4000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ── Doctor ────────────────────────────────────────────────────────────────────

export async function doctorConnector(connectorId: string): Promise<DoctorResult> {
  const installed = listConnectors().installed;
  const instance = installed.find((c) => c.connectorId === connectorId);

  if (!instance) {
    return {
      connectorId,
      checks: [{ name: "Installed", ok: false, detail: "Not installed" }],
      healthy: false,
    };
  }

  const configPath = path.join(getConnectorsDir(), `${connectorId}.json`);
  const checks: DoctorCheck[] = [];

  // Check config exists
  checks.push({
    name: "Config file",
    ok: fs.existsSync(configPath),
    detail: configPath,
  });

  // Check config is valid JSON
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    JSON.parse(raw);
    checks.push({ name: "Config valid", ok: true, detail: "OK" });
  } catch (e) {
    checks.push({ name: "Config valid", ok: false, detail: String(e) });
  }

  // Check MCP server reachable (if applicable)
  const mcpUrl = instance.config.mcpServerUrl as string | undefined;
  if (mcpUrl) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(mcpUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      checks.push({ name: "MCP server", ok: response.ok, detail: mcpUrl });
    } catch (e) {
      checks.push({
        name: "MCP server",
        ok: false,
        detail: `Cannot reach ${mcpUrl}: ${e instanceof Error ? e.message : "unknown"}`,
      });
    }
  }

  // Check memory dir (if applicable)
  const memoryDir = instance.config.memoryDir as string | undefined;
  if (memoryDir) {
    if (fs.existsSync(memoryDir)) {
      checks.push({ name: "Memory directory", ok: true, detail: memoryDir });
    } else {
      checks.push({ name: "Memory directory", ok: false, detail: `Not found: ${memoryDir}` });
    }
  }

  const healthy = checks.every((c) => c.ok);
  return { connectorId, checks, healthy };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getConnectorsDir(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "engram")
    : path.join(process.env.HOME ?? "~", ".config", "engram");
  return path.join(configDir, REGISTRY_DIR_NAME, "connectors");
}
