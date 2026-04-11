/**
 * @remnic/core — Connector Manager
 *
 * Metadata-driven registry for host adapters (Codex CLI, Claude Code, Cursor, etc.).
 * Manages connector lifecycle: install, remove, configure, health.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { coerceInstallExtension } from "./coerce.js";

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

// ── Helpers (Finding 4) ───────────────────────────────────────────────────

// Re-export coerceInstallExtension from the shared coerce module so existing
// import sites (`import { coerceInstallExtension } from "./index.js"`) keep
// working without change.
export { coerceInstallExtension } from "./coerce.js";

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

  // Build config from schema defaults + user overrides
  const resolvedConfig: Record<string, unknown> = {
    connectorId: options.connectorId,
    installedAt: new Date().toISOString(),
    ...options.config,
  };

  // Codex CLI: also drop the phase-2 memory extension unless the caller
  // explicitly opted out via `config.installExtension: false`.
  let extensionMessage = "";
  if (options.connectorId === "codex-cli") {
    // Finding 1: coerce string "false"/"true" from CLI config parsing to a real
    // boolean before the gate check, then persist the coerced value so it is
    // stored as a boolean in the config file.
    const coerced = coerceInstallExtension(resolvedConfig.installExtension);
    if (coerced !== undefined) {
      resolvedConfig.installExtension = coerced;
    }
    const shouldInstall = resolvedConfig.installExtension !== false;
    // Persist the effective installExtension boolean explicitly so that
    // removeConnector's provenance check (Finding 3) can match. When the caller
    // did not pass the key, the default is true — write it so later removal
    // knows Remnic owned the install.
    resolvedConfig.installExtension = shouldInstall;
    // Resolve the Codex home path NOW so we can persist the absolute path
    // into the saved config. This guarantees removeConnector can target the
    // exact same directory later even if $CODEX_HOME is unset or changed.
    const codexHomeOverride =
      typeof resolvedConfig.codexHome === "string" && resolvedConfig.codexHome.length > 0
        ? (resolvedConfig.codexHome as string)
        : null;
    const resolvedCodexHome = resolveCodexHome(codexHomeOverride);
    resolvedConfig.codexHome = resolvedCodexHome;

    if (shouldInstall) {
      try {
        const extensionSourceOverride =
          typeof resolvedConfig.extensionSourceDir === "string" &&
          resolvedConfig.extensionSourceDir.length > 0
            ? (resolvedConfig.extensionSourceDir as string)
            : null;
        const extResult = installCodexMemoryExtension({
          codexHome: resolvedCodexHome,
          sourceDir: extensionSourceOverride,
        });
        extensionMessage = ` (memory extension: ${extResult.remnicExtensionDir})`;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "unknown error";
        return {
          connectorId: options.connectorId,
          status: "error",
          message: `Memory extension install failed — ${errMsg}`,
        };
      }
    } else {
      extensionMessage = " (memory extension: skipped via installExtension=false)";
    }
  }

  // Finding 5: strip internal/test-only keys that must never be persisted to
  // the config file. These keys are used at install time only (e.g. to inject
  // a synthetic extension source dir in tests) and have no meaning on disk.
  // Denylist — add any future test-only keys here with a comment.
  const INTERNAL_KEYS_DENYLIST = [
    "extensionSourceDir", // test-only override for the plugin-codex source path
  ];
  for (const key of INTERNAL_KEYS_DENYLIST) {
    delete resolvedConfig[key];
  }

  fs.writeFileSync(configPath, JSON.stringify(resolvedConfig, null, 2));

  return {
    connectorId: options.connectorId,
    status: "installed",
    configPath,
    message: `Installed ${manifest.name} v${manifest.version}${extensionMessage}`,
  };
}

// ── Remove connector ───────────────────────────────────────────────────────

export function removeConnector(connectorId: string): RemoveResult {
  const configDir = getConnectorsDir();
  const configPath = path.join(configDir, `${connectorId}.json`);

  // For codex-cli, read the saved config BEFORE touching anything so we have
  // both the persisted codexHome and the installExtension flag available for
  // later use in extension removal (Findings 1, 3, 4, 5).
  let codexHomeOverride: string | null = null;
  let savedInstallExtension: boolean | undefined = undefined;
  // Finding 1: track whether config parsing succeeded. If parsing throws, we
  // cannot trust any metadata and must fail closed (skip extension removal).
  let configParsed = false;
  if (connectorId === "codex-cli" && fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      configParsed = true;
      if (typeof parsed.codexHome === "string" && parsed.codexHome.length > 0) {
        codexHomeOverride = parsed.codexHome;
      }
      // Finding 4: coerce saved installExtension so string "false" still works.
      const coerced = coerceInstallExtension(parsed.installExtension);
      if (coerced !== undefined) {
        savedInstallExtension = coerced;
      }
    } catch {
      // Finding 1: config is malformed — log debug and fail closed.
      // codexHomeOverride and savedInstallExtension remain unset; configParsed
      // stays false so extension removal is skipped below.
      console.debug(
        "[remnic/connectors] removeConnector: codex-cli.json parse failed — skipping extension removal to avoid touching unverified paths",
      );
    }
  }

  if (!fs.existsSync(configPath)) {
    // Config file is missing — we have no evidence that this installation ever
    // managed the extension directory, so it is unsafe to remove it (the user
    // may have self-managed it or installed with installExtension=false).
    // Skip removeCodexMemoryExtension entirely in this recovery path.
    return {
      connectorId,
      configPath,
      message: "Not installed",
    };
  }

  // Finding 5: remove extension BEFORE deleting the config file. If extension
  // removal throws (e.g. EPERM/EBUSY), we re-throw WITHOUT deleting the config
  // so the user can retry — the config still has the persisted codexHome needed
  // to locate the extension directory.
  let extensionMessage = "";
  if (connectorId === "codex-cli") {
    // Finding 1: config parse failed — skip extension removal entirely.
    if (!configParsed) {
      extensionMessage = " (memory extension: skipped — config parse failed)";
    // Finding 4: skip extension deletion when installExtension was explicitly disabled.
    } else if (savedInstallExtension === false) {
      extensionMessage = " (memory extension: skipped — installExtension=false)";
    // Finding 3: require EXPLICIT provenance (installExtension===true AND a saved
    // codexHome) before removing the extension. Legacy configs that pre-date this
    // feature have no installExtension key, so savedInstallExtension is undefined;
    // without provenance we cannot be sure Remnic ever owned the directory.
    } else if (savedInstallExtension !== true || codexHomeOverride === null) {
      extensionMessage = " (memory extension: skipped — no install provenance in saved config)";
    } else {
      const extResult = removeCodexMemoryExtension({ codexHome: codexHomeOverride });
      extensionMessage = extResult.removed
        ? ` (memory extension removed: ${extResult.remnicExtensionDir})`
        : " (no memory extension present)";
    }
  }

  // Config deletion happens AFTER extension removal (Finding 5). If extension
  // removal threw above, we never reach this line and the config is preserved.
  fs.unlinkSync(configPath);

  return {
    connectorId,
    configPath,
    message: `Removed${extensionMessage}`,
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

// ── Codex memory extension install ────────────────────────────────────────

/**
 * Name of the Codex memories folder. Matches Codex's
 * `MEMORIES_SUBDIR = "memories"`.
 */
const CODEX_MEMORIES_SUBDIR = "memories";

/**
 * Name of the Codex memory-extensions folder. Matches Codex's
 * `EXTENSIONS_SUBDIR = "memories_extensions"`.
 *
 * Codex computes the extensions root as a **sibling** of the memories dir via
 * Rust's `Path::with_file_name("memories_extensions")` — so for the default
 * Codex home the layout is:
 *
 *     ~/.codex/memories/
 *     ~/.codex/memories_extensions/
 *
 * Extension files live **outside** of `memories/`, never inside it.
 */
const CODEX_EXTENSIONS_SUBDIR = "memories_extensions";

/** Folder name Remnic installs its extension under. */
const REMNIC_EXTENSION_DIR_NAME = "remnic";

export interface CodexMemoryExtensionPaths {
  /** Resolved Codex home directory (e.g. `~/.codex`). */
  codexHome: string;
  /** Resolved Codex memories directory (`<codex_home>/memories`). */
  memoriesDir: string;
  /** Sibling extensions root (`<codex_home>/memories_extensions`). */
  extensionsRoot: string;
  /** The specific Remnic extension directory inside the extensions root. */
  remnicExtensionDir: string;
}

export interface InstallCodexMemoryExtensionOptions {
  /** Optional override for `$CODEX_HOME`. Highest priority. */
  codexHome?: string | null;
  /** Optional override for the plugin-codex extension source directory. */
  sourceDir?: string | null;
}

export interface InstallCodexMemoryExtensionResult extends CodexMemoryExtensionPaths {
  /** Absolute path to the installed `instructions.md`. */
  instructionsPath: string;
  /** Number of files copied. */
  filesCopied: number;
}

export interface RemoveCodexMemoryExtensionOptions {
  codexHome?: string | null;
}

export interface RemoveCodexMemoryExtensionResult extends CodexMemoryExtensionPaths {
  /** True if an existing `remnic` extension directory was removed. */
  removed: boolean;
}

/**
 * Resolve the Codex home directory. Precedence:
 *   1. explicit `override` argument (from config)
 *   2. `$CODEX_HOME` env var
 *   3. `~/.codex`
 */
export function resolveCodexHome(override?: string | null): string {
  if (override && typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  const envHome = process.env.CODEX_HOME;
  if (envHome && envHome.trim().length > 0) {
    return path.resolve(envHome.trim());
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  // Use path.resolve so the result is always absolute. When both HOME and
  // USERPROFILE are unset we fall back to the literal "~" sentinel and
  // path.resolve("~", ".codex") resolves it against cwd — not ideal, but
  // still an absolute path. A cleaner error can be added later if needed.
  return path.resolve(home, ".codex");
}

/**
 * Compute the Codex memories + memory-extensions layout for a given Codex home.
 *
 * The extensions root is computed as a **sibling** of the memories dir by
 * taking `path.dirname(memoriesDir)` and joining `memories_extensions`. This
 * mirrors Rust's `with_file_name("memories_extensions")` semantics used by
 * Codex's `memory_extensions_root()`. Do NOT place the extension inside
 * `<codex_home>/memories/`.
 */
export function resolveCodexMemoryExtensionPaths(
  codexHomeOverride?: string | null,
): CodexMemoryExtensionPaths {
  const codexHome = resolveCodexHome(codexHomeOverride);
  const memoriesDir = path.join(codexHome, CODEX_MEMORIES_SUBDIR);
  // Sibling computation: with_file_name(EXTENSIONS_SUBDIR)
  const extensionsRoot = path.join(path.dirname(memoriesDir), CODEX_EXTENSIONS_SUBDIR);
  const remnicExtensionDir = path.join(extensionsRoot, REMNIC_EXTENSION_DIR_NAME);
  return { codexHome, memoriesDir, extensionsRoot, remnicExtensionDir };
}

/**
 * Locate the plugin-codex `memories_extensions/remnic/` source directory on
 * disk. Search order:
 *   1. explicit `override`
 *   2. resolve via `@remnic/plugin-codex` package (handles global npm installs)
 *   3. sibling `node_modules/@remnic/plugin-codex` relative to this module
 *   4. walk upward from this file's location (monorepo development)
 *   5. walk upward from `process.cwd()` (monorepo fallback)
 *
 * Returns the absolute path or throws a descriptive error listing all paths
 * searched when none exist.
 */
export function locatePluginCodexExtensionSource(override?: string | null): string {
  if (override && typeof override === "string" && override.trim().length > 0) {
    const resolved = path.resolve(override.trim());
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
    throw new Error(`Codex extension source directory not found: ${resolved}`);
  }

  const EXTENSION_SUBPATH = path.join("memories_extensions", "remnic");
  const WORKSPACE_RELATIVE_PATH = path.join(
    "packages",
    "plugin-codex",
    "memories_extensions",
    "remnic",
  );

  const searched: string[] = [];

  // Primary path: the bundled payload shipped with @remnic/core itself.
  // The `codex/` subdirectory lives alongside this source file and is
  // included in the package `files` field so it ships with the npm artifact.
  // This ensures installCodexMemoryExtension works even when @remnic/plugin-codex
  // is not installed (e.g. a user installs only @remnic/core + remnic-cli).
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    // When compiled: dist/connectors/index.js → dist/connectors/codex/
    // When run via tsx/ts-node on src: src/connectors/codex/
    const bundledCandidate = path.join(moduleDir, "codex");
    searched.push(bundledCandidate);
    if (fs.existsSync(bundledCandidate) && fs.statSync(bundledCandidate).isDirectory()) {
      return bundledCandidate;
    }
  } catch {
    // import.meta.url unavailable — not running as ESM, skip bundled path.
  }

  // Finding 2 — path 1: resolve via `@remnic/plugin-codex` package.json.
  // This covers global `npm install -g @remnic/remnic-core` or pnpm global installs
  // where the package lives under the global node_modules tree.
  try {
    const requireFromHere = createRequire(import.meta.url);
    const pluginPkgJsonPath = requireFromHere.resolve("@remnic/plugin-codex/package.json");
    const pluginPkgRoot = path.dirname(pluginPkgJsonPath);
    const candidate = path.join(pluginPkgRoot, EXTENSION_SUBPATH);
    searched.push(candidate);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // @remnic/plugin-codex not installed — fall through to next strategy.
  }

  // Finding 2 — path 2: sibling node_modules under the module's own directory.
  // Handles cases like:
  //   .../node_modules/@remnic/remnic-core/src/connectors/index.js
  //   .../node_modules/@remnic/plugin-codex/memories_extensions/remnic
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    let dir = moduleDir;
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(
        dir,
        "node_modules",
        "@remnic",
        "plugin-codex",
        EXTENSION_SUBPATH,
      );
      searched.push(candidate);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url unavailable — not running as ESM.
  }

  // Finding 2 — path 3 & 4: walk upward from this file's location and from
  // process.cwd() looking for the monorepo layout (`packages/plugin-codex/…`).
  const anchors: string[] = [];
  try {
    anchors.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // Not running under ESM with import.meta — skip.
  }
  anchors.push(process.cwd());

  for (const anchor of anchors) {
    let dir = anchor;
    for (let depth = 0; depth < 12; depth += 1) {
      const candidate = path.join(dir, WORKSPACE_RELATIVE_PATH);
      searched.push(candidate);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  throw new Error(
    "Could not locate the plugin-codex memories_extensions/remnic source directory.\n" +
      "Paths searched:\n" +
      searched.map((p) => `  - ${p}`).join("\n") +
      "\nInstall @remnic/plugin-codex or pass sourceDir explicitly.",
  );
}

/** Recursive synchronous directory copy. */
function copyDirRecursiveSync(src: string, dest: string): number {
  let count = 0;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursiveSync(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      count += 1;
    }
    // Skip symlinks, sockets, etc. — extension content is plain files.
  }
  return count;
}

/**
 * Install the Remnic memory extension into `<codex_home>/memories_extensions/remnic/`
 * atomically. The copy is written to a sibling `.remnic.tmp-<pid>-<ts>` directory
 * and then renamed into place, so a concurrent Codex phase-2 run never sees a
 * half-written extension.
 *
 * This function is **idempotent and scoped**: it only touches the `remnic`
 * subfolder inside `memories_extensions/`. Adjacent extensions (other
 * vendors) are never read, written, or removed.
 */
export function installCodexMemoryExtension(
  options: InstallCodexMemoryExtensionOptions = {},
): InstallCodexMemoryExtensionResult {
  const paths = resolveCodexMemoryExtensionPaths(options.codexHome ?? null);
  const sourceDir = locatePluginCodexExtensionSource(options.sourceDir ?? null);

  fs.mkdirSync(paths.extensionsRoot, { recursive: true });

  // Clean any stale tmp from a previous crashed run by scanning the
  // extensions root for any `.remnic.tmp-*` prefixed entry. We must do this
  // BEFORE creating the new tmp directory. Per-entry errors are swallowed so
  // one bad entry doesn't abort cleanup of the rest.
  //
  // Finding 2: only remove tmp dirs that are provably stale (older than
  // STALE_TMP_THRESHOLD_MS). Dirs younger than the threshold belong to a
  // concurrent install that is still in progress; deleting them would corrupt
  // the other process's atomic rename.
  const tmpPrefix = `.${REMNIC_EXTENSION_DIR_NAME}.tmp-`;
  const STALE_TMP_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  const now = Date.now();
  try {
    const existingEntries = fs.readdirSync(paths.extensionsRoot);
    for (const entry of existingEntries) {
      if (!entry.startsWith(tmpPrefix)) continue;
      const stalePath = path.join(paths.extensionsRoot, entry);
      try {
        const stat = fs.statSync(stalePath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs < STALE_TMP_THRESHOLD_MS) {
          // Too recent — leave it alone; another install is likely still running.
          continue;
        }
        fs.rmSync(stalePath, { recursive: true, force: true });
      } catch {
        // swallow — one bad entry should not abort the others
      }
    }
  } catch {
    // extensions root just-created / unreadable — nothing to clean
  }

  const tmpName = `${tmpPrefix}${process.pid}-${Date.now()}`;
  const tmpDir = path.join(paths.extensionsRoot, tmpName);

  let filesCopied = 0;
  try {
    filesCopied = copyDirRecursiveSync(sourceDir, tmpDir);

    // Atomic replace: rename old remnic/ to a timestamped backup, then rename
    // the tmp dir into place.  If the second rename fails, restore from backup
    // so the old extension is never permanently lost.
    const backupDir = `${paths.remnicExtensionDir}.bak-${Date.now()}`;
    const hadExisting = fs.existsSync(paths.remnicExtensionDir);
    if (hadExisting) {
      fs.renameSync(paths.remnicExtensionDir, backupDir);
    }
    try {
      fs.renameSync(tmpDir, paths.remnicExtensionDir);
    } catch (renameErr) {
      // New rename failed — restore backup so the old extension survives.
      if (hadExisting) {
        try {
          fs.renameSync(backupDir, paths.remnicExtensionDir);
        } catch {
          // swallow — backup restore best-effort
        }
      }
      throw renameErr;
    }
    // New extension is in place — remove the backup.
    if (hadExisting) {
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
      } catch {
        // swallow — stale backup is harmless
      }
    }
  } catch (err) {
    // Best-effort cleanup so we never leave .tmp garbage behind.
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // swallow
      }
    }
    throw err;
  }

  const instructionsPath = path.join(paths.remnicExtensionDir, "instructions.md");

  return {
    ...paths,
    instructionsPath,
    filesCopied,
  };
}

/**
 * Remove the Remnic memory extension. Only touches
 * `<codex_home>/memories_extensions/remnic/` — never adjacent extensions.
 */
export function removeCodexMemoryExtension(
  options: RemoveCodexMemoryExtensionOptions = {},
): RemoveCodexMemoryExtensionResult {
  const paths = resolveCodexMemoryExtensionPaths(options.codexHome ?? null);
  let removed = false;
  if (fs.existsSync(paths.remnicExtensionDir)) {
    fs.rmSync(paths.remnicExtensionDir, { recursive: true, force: true });
    removed = true;
  }
  return { ...paths, removed };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getConnectorsDir(): string {
  const configDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "engram")
    : path.join(process.env.HOME ?? "~", ".config", "engram");
  return path.join(configDir, REGISTRY_DIR_NAME, "connectors");
}
