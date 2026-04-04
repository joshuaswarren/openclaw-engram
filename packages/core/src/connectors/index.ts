/**
 * @engram/core — Connector Manager
 *
 * Metadata-driven registry for host adapters (Codex CLI, Claude Code, Cursor, etc.).
 * Manages connector lifecycle: install, remove, configure, health.
 */

import fs from "node:fs";
import path from "node:path";

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
      mcpServerUrl: "URL of the MCP Engram server",
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
      mcpServerUrl: "URL of the MCP Engram server",
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
      memoryDir: "Path to Engram memory directory",
    },
    homepage: "https://cursor.com",
    author: "Cursor Inc.",
    tags: ["official", "ide"],
  },
  {
    id: "cline",
    name: "CLINE",
    version: "1.0.0",
    description: "VS Code CLINE extension — memory via MCP",
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
      mcpServerUrl: "URL of the MCP Engram server",
      namespace: "Optional namespace",
    },
    homepage: "https://marketplace.visualstudio.com/items/ms-tools.cline",
    author: "Microsoft",
    tags: ["official", "vscode"],
  },
];

// ── Registry management ───────────────────────────────────────────────────

const REGISTRY_DIR_NAME = ".engram-connectors";

export function getRegistryPath(): string {
  const homeDir = process.env.HOME ?? "~";
  return path.join(homeDir, ".config", "engram", REGISTRY_DIR_NAME);
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

  // Build config from schema defaults + user overrides
  const resolvedConfig: Record<string, unknown> = {
    connectorId: options.connectorId,
    installedAt: new Date().toISOString(),
    ...options.config,
  };
  fs.writeFileSync(configPath, JSON.stringify(resolvedConfig, null, 2));

  return {
    connectorId: options.connectorId,
    status: "installed",
    configPath,
    message: `Installed ${manifest.name} v${manifest.version}`,
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

  fs.unlinkSync(configPath);
  return {
    connectorId,
    configPath,
    message: "Removed",
  };
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
  const homeDir = process.env.HOME ?? "~";
  return path.join(homeDir, ".config", "engram", REGISTRY_DIR_NAME, "connectors");
}
