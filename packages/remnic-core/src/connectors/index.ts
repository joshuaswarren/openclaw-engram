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
  //
  // Token write errors (e.g. read-only HOME with writable XDG_CONFIG_HOME)
  // are non-fatal: we degrade gracefully and proceed with the connector
  // config write rather than aborting the whole install.
  let tokenEntry: ReturnType<typeof generateToken> | null = null;
  try {
    tokenEntry = generateToken(options.connectorId);
  } catch {
    // Non-fatal: token store unavailable. Connector config will still be
    // written; user can run `remnic token generate <id>` to create the token.
  }

  // For the hermes connector, resolve profile/host/port with the following
  // precedence: saved-connector-JSON → explicit options.config → defaults.
  // Reading happens BEFORE we overwrite the connector JSON so that a
  // force-reinstall without re-supplied --config options preserves the
  // previously configured values and writes the new token to the correct
  // Hermes profile rather than resetting to "default"/127.0.0.1/4318.
  let hermesSavedProfile: string | undefined;
  let hermesSavedHost: string | undefined;
  let hermesSavedPort: number | undefined;
  // Resolved values (used both in resolvedConfig and in the YAML update below)
  let hermesResolvedProfile: string | undefined;
  let hermesResolvedHost: string | undefined;
  let hermesResolvedPort: number | undefined;
  if (options.connectorId === "hermes") {
    if (fs.existsSync(configPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (typeof prev?.profile === "string") hermesSavedProfile = prev.profile;
        if (typeof prev?.host === "string") hermesSavedHost = prev.host;
        if (typeof prev?.port === "number") hermesSavedPort = prev.port;
      } catch {
        // Could not read existing config — fall through to defaults
      }
    }
    hermesResolvedProfile =
      (options.config?.profile as string | undefined) ??
      hermesSavedProfile ??
      "default";
    hermesResolvedHost =
      (options.config?.host as string | undefined) ??
      hermesSavedHost ??
      "127.0.0.1";
    hermesResolvedPort =
      (options.config?.port as number | undefined) ??
      hermesSavedPort ??
      4318;
  }

  // Build config from schema defaults + user overrides.
  // Spread user config FIRST, then overlay the daemon-generated token so that
  // a stray `token` key in options.config cannot silently override the value
  // we just wrote to the token store. The connector JSON config and the
  // daemon's tokens.json must agree on which token authorizes this connector.
  // For hermes, also include the resolved profile/host/port so that future
  // force-reinstalls can read them back even if options.config is not supplied.
  const resolvedConfig: Record<string, unknown> = {
    connectorId: options.connectorId,
    installedAt: new Date().toISOString(),
    ...(hermesResolvedProfile !== undefined ? {
      profile: hermesResolvedProfile,
      host: hermesResolvedHost,
      port: hermesResolvedPort,
    } : {}),
    ...options.config,
    ...(tokenEntry ? { token: tokenEntry.token } : {}),
  };
  // Write with owner-only permissions because the JSON may embed the
  // connector bearer token. Matches the 0o600 hardening on
  // ~/.remnic/tokens.json so the token is never world-readable via this
  // secondary location.
  writeSecretFileSync(configPath, JSON.stringify(resolvedConfig, null, 2));

  const notes: string[] = [];

  // Hermes-specific: write the remnic: block to config.yaml.
  // We skip the YAML update when token generation failed: writing an empty token
  // to config.yaml would overwrite a potentially valid existing token and break
  // auth silently. The connector config file is still created; the user can run
  // `remnic token generate hermes` to create the token, then re-run install.
  if (options.connectorId === "hermes") {
    // hermesResolvedProfile/Host/Port were computed above using the correct
    // precedence (saved JSON → explicit options.config → defaults).
    const rawProfile = hermesResolvedProfile!;
    const hermesHost = hermesResolvedHost!;
    const hermesPort = hermesResolvedPort!;

    // Reject path-traversing or otherwise invalid profile values up front.
    let hermesProfile: string | null = null;
    try {
      hermesProfile = sanitizeHermesProfile(rawProfile);
    } catch (err) {
      notes.push(
        `Skipped Hermes config.yaml update: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (hermesProfile !== null) {
      // If the saved profile differs from the new target profile, clean the old
      // profile's config.yaml first so a revoked token block is not left behind.
      // This can happen when the user explicitly passes a different --config profile=
      // on reinstall. On no-args force reinstall hermesSavedProfile === hermesProfile,
      // so this is a no-op in the common case.
      if (hermesSavedProfile !== undefined && hermesSavedProfile !== hermesProfile) {
        try {
          const oldCleanResult = removeHermesConfig({ profile: hermesSavedProfile });
          if (oldCleanResult.updated) {
            notes.push(`Cleaned stale remnic: block from previous profile: ${oldCleanResult.configPath}`);
          }
        } catch {
          // Non-fatal: if we can't clean the old profile, proceed anyway.
        }
      }

      if (!tokenEntry) {
        notes.push(
          "Token store unavailable — skipped Hermes config.yaml update. " +
            "Run `remnic token generate hermes` then reinstall to complete setup.",
        );
      } else {
        try {
          const yamlResult = upsertHermesConfig({
            profile: hermesProfile,
            host: hermesHost,
            port: hermesPort,
            token: tokenEntry.token,
          });
          if (yamlResult.updated) {
            notes.push(`Updated Hermes config: ${yamlResult.configPath}`);
          } else if (yamlResult.skipped) {
            notes.push(`Hermes config not written: ${yamlResult.reason}`);
          }
        } catch (err) {
          notes.push(
            `Hermes config not written: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Health-check the daemon (non-fatal, independent of token availability).
    // /engram/v1/health sits behind bearer auth, so we pass the generated
    // token when we have one — otherwise the probe would always 401 and
    // falsely report the daemon as unreachable.
    const healthToken = tokenEntry?.token;
    const daemonOk = checkDaemonHealth(hermesHost, hermesPort, healthToken);
    if (daemonOk) {
      notes.push("Daemon health check: OK");
    } else {
      notes.push(
        `Daemon not reachable at ${hermesHost}:${hermesPort} — start with: remnic daemon start`,
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
  // Non-fatal: if the token store is read-only or missing, connector removal
  // should still succeed. Stale tokens will be rejected by the daemon when the
  // token file is later accessible.
  try {
    revokeToken(connectorId);
  } catch {
    // Best-effort: log nothing here; caller sees the config removal succeed.
  }

  fs.unlinkSync(configPath);

  const notes: string[] = [];

  // Hermes-specific: strip the remnic: block from config.yaml
  if (connectorId === "hermes") {
    try {
      const yamlResult = removeHermesConfig({ profile: storedProfile });
      if (yamlResult.updated) {
        notes.push(`Removed remnic: block from Hermes config: ${yamlResult.configPath}`);
      } else if (yamlResult.skipped) {
        notes.push(`Hermes config cleanup skipped: ${yamlResult.reason}`);
      }
    } catch (err) {
      notes.push(
        `Hermes config cleanup skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
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

/**
 * Validate and sanitize a Hermes profile name.
 *
 * Profile names appear as a path segment under `~/.hermes/profiles/`, so we
 * must reject any value that could traverse outside that directory. Hermes
 * itself restricts profile names to filesystem-safe identifiers; we mirror
 * that convention and additionally require the resolved config path to stay
 * under the profiles root.
 *
 * Throws on invalid input rather than silently normalizing — the caller
 * should surface the error so the user can supply a valid profile.
 */
function sanitizeHermesProfile(profile: string): string {
  if (typeof profile !== "string" || profile.length === 0) {
    throw new Error("Hermes profile name must be a non-empty string");
  }
  // Disallow anything that isn't a plain profile identifier. We accept
  // letters, digits, hyphen, underscore, and dot — but reject leading dots
  // (hidden dirs) and any path separator or parent-dir reference.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
    throw new Error(
      `Invalid Hermes profile name: ${JSON.stringify(profile)} — must match [A-Za-z0-9][A-Za-z0-9._-]*`,
    );
  }
  if (profile.includes("..")) {
    throw new Error(`Invalid Hermes profile name: ${JSON.stringify(profile)} — must not contain ".."`);
  }
  return profile;
}

function hermesConfigPath(profile: string): string {
  const safeProfile = sanitizeHermesProfile(profile);
  const profilesRoot = path.resolve(os.homedir(), ".hermes", "profiles");
  const cfgPath = path.resolve(profilesRoot, safeProfile, "config.yaml");
  // Defense in depth: ensure the resolved path is still under profilesRoot.
  const rel = path.relative(profilesRoot, cfgPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Invalid Hermes profile path: resolved outside ${profilesRoot}`,
    );
  }
  return cfgPath;
}

/**
 * Validate a Hermes host string before interpolating it into YAML.
 *
 * YAML-injection guard: connector config values come from raw CLI input
 * (`--config host=...`) or config-file JSON, both of which are untrusted.
 * Without validation, a value like `127.0.0.1"\n  session_key: "evil`
 * would emit additional YAML keys into the `remnic:` block and silently
 * override Hermes settings.
 *
 * We accept IPv4, IPv6, and RFC-952/RFC-1123 hostnames — the same
 * character classes any real DNS/listen address would use. Anything with
 * whitespace, quotes, or line breaks is rejected.
 */
function sanitizeHermesHost(host: string): string {
  if (typeof host !== "string" || host.length === 0) {
    throw new Error("Hermes host must be a non-empty string");
  }
  if (host.length > 253) {
    throw new Error(`Hermes host too long (max 253 chars): ${JSON.stringify(host.slice(0, 32))}…`);
  }
  // Allowed chars: hostname letters/digits/dot/hyphen, plus colon and
  // square brackets for IPv6 literals. No whitespace, no quotes, no
  // control characters — those are the values that could break out of
  // the YAML scalar.
  if (!/^[A-Za-z0-9._\-:[\]]+$/.test(host)) {
    throw new Error(
      `Invalid Hermes host: ${JSON.stringify(host)} — must be a plain hostname or IP literal`,
    );
  }
  return host;
}

/**
 * Validate a Hermes port value. Accepts positive integers in [1, 65535].
 *
 * Rejects non-integer numeric strings (e.g. "4318.9") rather than silently
 * truncating them — a fractional port is almost certainly a typo and writing
 * the truncated value to config.yaml would be misleading.
 */
function sanitizeHermesPort(port: number | string): number {
  const numeric = Number(port);
  // Reject NaN, Infinity, -Infinity, and any non-integer (e.g. 4318.9)
  if (!Number.isInteger(numeric)) {
    throw new Error(
      `Invalid Hermes port "${port}": must be a positive integer`,
    );
  }
  if (numeric < 1 || numeric > 65535) {
    throw new Error(`Invalid Hermes port: ${JSON.stringify(port)} — must be an integer in [1, 65535]`);
  }
  return numeric;
}

/**
 * Write a file with owner-only (0o600) permissions.
 *
 * Used for any file that may contain a bearer token. writeFileSync's `mode`
 * option only applies when the file is newly created, so we also chmod
 * afterwards to tighten permissions on pre-existing files. The chmod is
 * best-effort on platforms that don't support POSIX modes.
 */
function writeSecretFileSync(filePath: string, data: string): void {
  fs.writeFileSync(filePath, data, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort on non-POSIX filesystems */
  }
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

  // YAML-injection guard: validate scalar values before interpolating them
  // into the `remnic:` block. sanitizeHermesHost/Port throw on anything
  // that could break out of the scalar context.
  const safeHost = sanitizeHermesHost(opts.host);
  const safePort = sanitizeHermesPort(opts.port);
  // Token is generated by randomBytes + a fixed alphabetic prefix, so it's
  // already safe for YAML scalar interpolation. We still guard against an
  // unexpectedly malformed token reaching this function.
  if (!/^[A-Za-z0-9_]+$/.test(opts.token)) {
    throw new Error("Invalid Hermes token: contains non-alphanumeric characters");
  }

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
    `  host: "${safeHost}"`,
    `  port: ${safePort}`,
    `  token: "${opts.token}"`,
  ].join("\n");

  if (!fs.existsSync(cfgPath)) {
    // Create with just the remnic block. 0o600 because the file now holds
    // a bearer token — matching the permissions on ~/.remnic/tokens.json.
    writeSecretFileSync(cfgPath, block + "\n");
    return { updated: true, skipped: false, configPath: cfgPath };
  }

  const raw = fs.readFileSync(cfgPath, "utf8");

  // Check whether there's an existing remnic: block
  const hasRemnicBlock = /^remnic:/m.test(raw);

  if (!hasRemnicBlock) {
    // Append the block (preserve existing content)
    const separator = raw.endsWith("\n") ? "\n" : "\n\n";
    writeSecretFileSync(cfgPath, raw + separator + block + "\n");
    return { updated: true, skipped: false, configPath: cfgPath };
  }

  // Update the existing block. Strategy: replace the content of the remnic:
  // section by matching from `^remnic:` to the next top-level key or end-of-file.
  // We rewrite only the host/port/token sub-keys inside the block; other keys
  // under remnic: (e.g. session_key, timeout) are preserved.
  //
  // Trailing-newline handling: split("\n") on a file that ends with "\n" produces
  // a final empty-string element. If that element is still inside the remnic block
  // when we hit it, it gets pushed to newLines via the else branch — placing a
  // blank line between existing sub-keys and any newly-appended missing sub-keys.
  // We strip the trailing empty element before the loop and re-add a single "\n"
  // at write time, normalising the file to always end with exactly one newline.
  const splitLines = raw.split("\n");
  // Remove trailing empty element produced by a file that ends with "\n"
  if (splitLines.length > 0 && splitLines[splitLines.length - 1] === "") {
    splitLines.pop();
  }
  const lines = splitLines;
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
        // Emit any un-written keys before closing the block. Uses the
        // already-validated safeHost/safePort values.
        if (!written.host) newLines.push(`  host: "${safeHost}"`);
        if (!written.port) newLines.push(`  port: ${safePort}`);
        if (!written.token) newLines.push(`  token: "${opts.token}"`);
        blockWritten = true;
        inRemnicBlock = false;
        newLines.push(line);
        continue;
      }

      // Replace host/port/token lines; preserve other sub-keys
      if (/^\s+host:/.test(line)) {
        newLines.push(`  host: "${safeHost}"`);
        written.host = true;
      } else if (/^\s+port:/.test(line)) {
        newLines.push(`  port: ${safePort}`);
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
    if (!written.host) newLines.push(`  host: "${safeHost}"`);
    if (!written.port) newLines.push(`  port: ${safePort}`);
    if (!written.token) newLines.push(`  token: "${opts.token}"`);
  }

  // Always write exactly one trailing newline, matching the create and append paths.
  writeSecretFileSync(cfgPath, newLines.join("\n") + "\n");
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

  // Use writeSecretFileSync to keep the file at 0o600 even after the token
  // has been removed. The file previously held a bearer token (so it was
  // written with 0o600 originally); preserving that mode prevents a window
  // where a rewrite with default umask temporarily widens permissions.
  writeSecretFileSync(cfgPath, newLines.length > 0 ? newLines.join("\n") + "\n" : "");
  return { updated: true, skipped: false, configPath: cfgPath };
}

// ── Daemon health check (synchronous, non-fatal) ────────────────────────────

/**
 * Probe exit-code contract (used by checkDaemonHealth):
 *   0 — HTTP 200 (healthy)
 *   2 — HTTP 401 (token cache miss: retry after TTL)
 *   1 — any other HTTP status or network error
 */
const HEALTH_EXIT_OK = 0;
const HEALTH_EXIT_UNAUTHORIZED = 2;

/**
 * Ping /engram/v1/health synchronously.
 * Returns true if the daemon responds with HTTP 200, false otherwise.
 * Uses child_process.spawnSync to run a one-liner Node script so that the
 * existing synchronous installConnector() flow does not need to become async.
 *
 * Data (host, port, token) are passed via environment variables — NOT
 * interpolated into the script string — to prevent injection from
 * user-supplied config values.
 *
 * /engram/v1/health is protected by bearer auth in the access HTTP server,
 * so the caller must pass the connector token (or the configured server
 * token) or the probe will always return 401 and report the daemon as
 * unreachable even when it is running.
 *
 * 401 handling: the daemon caches valid tokens with a 5-second TTL
 * (getAllValidTokensCached). A freshly-rotated token may not appear in the
 * cache for up to 5 s after rotation. We tolerate a single 401 by sleeping
 * one cache TTL (6000 ms = 5 s TTL + 1 s buffer) and retrying exactly once.
 */
function checkDaemonHealth(host: string, port: number, authToken?: string): boolean {
  try {
    // Validate port: must be an integer in [1, 65535].
    // This guards against user config supplying a non-numeric string.
    const safePort = Math.trunc(Number(port));
    if (!Number.isFinite(safePort) || safePort < 1 || safePort > 65535) {
      return false;
    }
    // Data (host, port, token) are passed via env vars, never interpolated
    // into the script string, preventing any code-injection from malformed
    // config values.
    // Exit codes: 0 = 200 OK, 2 = 401 Unauthorized, 1 = other error.
    const script = [
      "const http = require('http');",
      "const headers = {};",
      "if (process.env.REMNIC_HEALTH_TOKEN) {",
      "  headers['authorization'] = 'Bearer ' + process.env.REMNIC_HEALTH_TOKEN;",
      "}",
      "const req = http.get({",
      "  host: process.env.REMNIC_HEALTH_HOST,",
      "  port: parseInt(process.env.REMNIC_HEALTH_PORT, 10),",
      "  path: '/engram/v1/health',",
      "  headers,",
      "  timeout: 3000,",
      "}, (res) => { process.exit(res.statusCode === 200 ? 0 : res.statusCode === 401 ? 2 : 1); });",
      "req.on('error', () => process.exit(1));",
      "req.on('timeout', () => { req.destroy(); process.exit(1); });",
    ].join("\n");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REMNIC_HEALTH_HOST: host,
      REMNIC_HEALTH_PORT: String(safePort),
    };
    if (authToken) {
      env.REMNIC_HEALTH_TOKEN = authToken;
    }
    const spawnOpts = { timeout: 4000, env };
    const result = spawnSync(process.execPath, ["-e", script], spawnOpts);

    if (result.status === HEALTH_EXIT_OK) {
      return true;
    }

    if (result.status === HEALTH_EXIT_UNAUTHORIZED) {
      // The daemon's token cache (5 s TTL) has not yet picked up the freshly
      // rotated token. Sleep one TTL + buffer and retry exactly once.
      console.error(
        "[remnic/connectors] health probe got 401 — retrying after token cache TTL...",
      );
      // Synchronous sleep via spawnSync (avoids making the caller async).
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], {
        timeout: 7000,
        env: {},
      });
      const retry = spawnSync(process.execPath, ["-e", script], spawnOpts);
      return retry.status === HEALTH_EXIT_OK;
    }

    return false;
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
