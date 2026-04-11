/**
 * @remnic/cli
 *
 * Command-line interface for Remnic memory.
 *
 * Commands:
 *   init              Create remnic.config.json in the current directory
 *   status            Show server/daemon status
 *   query <text>      Query memories
 *   doctor            Run diagnostics
 *   config            Show current config
 *   daemon start      Start background server
 *   daemon stop       Stop background server
 *   daemon restart    Restart background server
 *   daemon install    Install as system service (launchd/systemd)
 *   daemon uninstall  Remove system service
 *   daemon status     Show daemon status
 *   token generate    Generate auth token for a connector
 *   token list        List all auth tokens
 *   token revoke      Revoke auth token for a connector
 *   tree              Generate context tree
 *   onboard [dir]     Onboard project directory
 *   curate <path>     Curate files into memory
 *   review            Review inbox management
 *   sync              Diff-aware sync
 *   dedup             Find duplicate memories
 *   connectors        Manage host adapters
 */

import fs from "node:fs";
import path from "node:path";
import * as childProcess from "node:child_process";
import {
  parseConfig,
  Orchestrator,
  EngramAccessService,
  initLogger,
  onboard,
  curate,
  listReviewItems,
  performReview,
  syncChanges,
  watchForChanges,
  findDuplicates,
  listConnectors,
  installConnector,
  removeConnector,
  doctorConnector,
  generateToken,
  listTokens,
  revokeToken,
  listSpaces,
  getActiveSpace,
  createSpace,
  deleteSpace,
  switchSpace,
  pushToSpace,
  pullFromSpace,
  shareSpace,
  promoteSpace,
  getAuditLog,
  getManifestPath,
  generateContextTree,
  migrateFromEngram,
  rollbackFromEngramMigration,
  buildBriefing,
  parseBriefingWindow,
  parseBriefingFocus,
  validateBriefingFormat,
  resolveBriefingSaveDir,
  briefingFilename,
  FileCalendarSource,
} from "@remnic/core";
import {
  runBenchSuite,
  runExplain,
  loadBaseline,
  saveBaseline,
  checkRegression,
  type BenchConfig,
} from "@remnic/bench";
import { firstSuccessfulCandidate, firstSuccessfulResult } from "./service-candidates.js";
export { hasFlag, resolveFlag } from "./cli-args.js";
import { hasFlag, resolveFlag } from "./cli-args.js";
import { parseConnectorConfig, stripConfigArgv } from "./parse-connector-config.js";

export { parseConnectorConfig, stripConfigArgv };

// ── Types ────────────────────────────────────────────────────────────────────

type CommandName =
  | "init"
  | "migrate"
  | "status"
  | "query"
  | "doctor"
  | "config"
  | "daemon"
  | "token"
  | "tree"
  | "onboard"
  | "curate"
  | "review"
  | "sync"
  | "dedup"
  | "connectors"
  | "space"
  | "benchmark"
  | "briefing"
  | "openclaw";

type DaemonAction = "start" | "stop" | "restart" | "install" | "uninstall" | "status";
type TokenAction = "generate" | "list" | "revoke";
type ReviewAction = "approve" | "dismiss" | "flag";

// ── Constants ────────────────────────────────────────────────────────────────

function readCompatEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~";
}

/** Expand a leading `~` or `$HOME` to the real home directory. */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return resolveHomeDir() + p.slice(1);
  }
  return p;
}

const PID_DIR = path.join(resolveHomeDir(), ".remnic");
const LEGACY_PID_DIR = path.join(resolveHomeDir(), ".engram");
const PID_FILE = path.join(PID_DIR, "server.pid");
const LEGACY_PID_FILE = path.join(LEGACY_PID_DIR, "server.pid");
const LOG_FILE = path.join(PID_DIR, "server.log");
const LEGACY_LOG_FILE = path.join(LEGACY_PID_DIR, "server.log");

// ── Config helpers ───────────────────────────────────────────────────────────

function resolveConfigPath(cliPath?: string): string {
  if (cliPath) return path.resolve(cliPath);
  const envPath = readCompatEnv("REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH");
  if (envPath) return path.resolve(envPath);

  const candidates = [
    path.join(process.cwd(), "remnic.config.json"),
    path.join(process.cwd(), "engram.config.json"),
    path.join(resolveHomeDir(), ".config", "remnic", "config.json"),
    path.join(resolveHomeDir(), ".config", "engram", "config.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(resolveHomeDir(), ".config", "remnic", "config.json");
}

function resolveMemoryDir(): string {
  // Priority: env var > config file > auto-detect
  const configMemoryDir = (() => {
    // Env var takes top priority (deployment override)
    const envMemoryDir = readCompatEnv("REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR");
    if (envMemoryDir) return envMemoryDir;
    // Then config file
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    const remnicCfg = raw.remnic ?? raw.engram ?? raw;
    if (remnicCfg.memoryDir) return remnicCfg.memoryDir;
    // Auto-detect: prefer standalone path if it exists, fall back to OpenClaw
    const home = resolveHomeDir();
    const standalonePath = path.join(home, ".remnic", "memory");
    const legacyStandalonePath = path.join(home, ".engram", "memory");
    const openclawPath = path.join(home, ".openclaw", "workspace", "memory", "local");
    if (fs.existsSync(standalonePath)) return standalonePath;
    if (fs.existsSync(legacyStandalonePath)) return legacyStandalonePath;
    return openclawPath;
  })();

  // Check active space — only if manifest exists (don't bootstrap just to resolve)
  const manifestPath = getManifestPath();
  if (fs.existsSync(manifestPath)) {
    try {
      const active = getActiveSpace();
      if (active?.memoryDir) {
        if (!fs.existsSync(active.memoryDir)) {
          // Recreate missing directory instead of silently falling back
          fs.mkdirSync(active.memoryDir, { recursive: true });
        }
        return active.memoryDir;
      }
      // No active space with memoryDir — fall through to config
    } catch (err: unknown) {
      // getActiveSpace() throws "Active space ... not found" when the activeSpaceId
      // references a space that was deleted — this is recoverable, fall through.
      // Any other error (corrupted JSON, permission denied) is fatal.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("not found")) {
        console.error(`Error: failed to resolve active space from ${manifestPath}: ${msg}`);
        process.exit(1);
      }
      // Active space not found — fall through to config-based dir
    }
  }

  return configMemoryDir;
}

/**
 * Like resolveFlag, but rejects the next token if it looks like another flag
 * (starts with "-"). Prevents `--config --yes` from treating --yes as the
 * config path. Use this variant only for flags that require a value argument.
 */
function resolveFlagStrict(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const next = args[idx + 1];
  return next.startsWith("-") ? undefined : next;
}
// ── OpenClaw config helpers ───────────────────────────────────────────────────

/**
 * The canonical plugin id used in plugins.entries and plugins.slots.memory.
 * Must match the `id` field in openclaw.plugin.json (and the shim for legacy).
 * PR #405 renames the plugin from "openclaw-engram" → "openclaw-remnic"; this
 * constant reflects the post-rename id so that `remnic openclaw install`
 * configures the new package (@remnic/plugin-openclaw) by default.
 * If you are still running the legacy "openclaw-engram" package, the slot will
 * not match until you upgrade — use `remnic doctor` to diagnose.
 */
const REMNIC_OPENCLAW_PLUGIN_ID = "openclaw-remnic";
const REMNIC_OPENCLAW_LEGACY_PLUGIN_ID = "openclaw-engram";

// Primary env var takes precedence; legacy env var is checked as fallback.
// This matches the priority convention in readCompatEnv() (primary > legacy > default).
const DEFAULT_OPENCLAW_CONFIG_PATHS_FOR_DOCTOR = [
  process.env.OPENCLAW_CONFIG_PATH,
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH,
  path.join(resolveHomeDir(), ".openclaw", "openclaw.json"),
].filter(Boolean) as string[];

function resolveOpenclawConfigPath(cliPath?: string): string {
  if (cliPath) return path.resolve(cliPath);

  // Env-var paths are always honoured regardless of whether the file exists yet
  // (a first-time install needs to create the file at the configured location).
  // Only fall through to existence-probing when no env var is set.
  const envPath =
    process.env.OPENCLAW_CONFIG_PATH || process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  if (envPath) return path.resolve(envPath);

  // No env var: return the first existing default path, or the canonical default.
  for (const candidate of DEFAULT_OPENCLAW_CONFIG_PATHS_FOR_DOCTOR) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(resolveHomeDir(), ".openclaw", "openclaw.json");
}

function readOpenclawConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `OpenClaw config at ${configPath} contains invalid JSON — refusing to overwrite.\n` +
      `Fix the file manually, then re-run.\nParse error: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `OpenClaw config at ${configPath} is not a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed}) — refusing to overwrite.`,
    );
  }
  return parsed as Record<string, unknown>;
}
// ── Commands ─────────────────────────────────────────────────────────────────

function cmdInit(): void {
  const configPath = path.join(process.cwd(), "remnic.config.json");
  if (fs.existsSync(configPath)) {
    console.log(`Config already exists: ${configPath}`);
    return;
  }

  const template: Record<string, unknown> = {
    remnic: {
      openaiApiKey: "${OPENAI_API_KEY}",
      memoryDir: path.join(process.cwd(), ".remnic", "memory"),
      memoryOsPreset: "balanced",
    },
    server: {
      host: "127.0.0.1",
      port: 4318,
      authToken: "${REMNIC_AUTH_TOKEN}",
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(template, null, 2) + "\n");
  console.log(`Created ${configPath}`);
  console.log("\nSet these environment variables:");
  console.log("  export OPENAI_API_KEY=sk-...");
  console.log("  export REMNIC_AUTH_TOKEN=$(openssl rand -hex 32)");
  console.log("  # ENGRAM_AUTH_TOKEN is still accepted during v1.x");
  console.log("\nThen start the server:");
  console.log("  npx remnic-server");
}

async function cmdStatus(json: boolean): Promise<void> {
  const { running, pid } = isServiceRunning();
  if (json) {
    console.log(JSON.stringify({ running, pid: pid ?? null, pidFile: PID_FILE, logFile: LOG_FILE }));
    return;
  }
  if (!running) {
    console.log("Remnic server: stopped");
    return;
  }
  console.log(`Remnic server: running${pid ? ` (pid ${pid})` : ""}`);

  const port = inferPort();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/engram/v1/health`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      console.log(`Health: server responded with ${response.status} ${response.statusText}`);
    } else {
      const health = await response.json();
      console.log(`Health: ${health.status ?? "ok"}`);
    }
  } catch {
    console.log("Health: unable to reach server");
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cmdQuery(queryText: string, json: boolean, explain: boolean): Promise<void> {
  if (!queryText) {
    console.error("Usage: remnic query <text>");
    process.exit(1);
  }

  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  const service = new EngramAccessService(orchestrator);

  if (explain) {
    const result = await runExplain(service, queryText);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Query: ${result.query}`);
      console.log(`Tiers used: ${result.tiersUsed.join(" → ")}`);
      console.log(`Total duration: ${result.totalDurationMs}ms`);
      for (const t of result.tierResults) {
        console.log(`  ${t.tier}: ${t.latencyMs}ms (${t.resultsCount} results)`);
      }
    }
    return;
  }

  const result = await service.recall({ query: queryText, mode: "auto" });
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
}

async function cmdBriefing(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);

  if (!config.briefing.enabled) {
    console.error("Briefing is disabled in config (briefing.enabled = false).");
    process.exit(1);
  }

  const sinceFlag = resolveFlag(rest, "--since");
  const focusFlag = resolveFlag(rest, "--focus");
  const formatFlag = resolveFlag(rest, "--format");
  const save = rest.includes("--save") || config.briefing.saveByDefault;

  if (hasFlag(rest, "--since") && sinceFlag === undefined) {
    console.error("Missing value for --since. Accepted: yesterday, today, NNh, NNd, NNw.");
    process.exit(1);
  }

  if (hasFlag(rest, "--format") && formatFlag === undefined) {
    console.error("Missing value for --format. Accepted: markdown, json.");
    process.exit(1);
  }

  // Guard --focus the same way: if the flag is present but has no trailing
  // value (or the next token is another flag like `--save`), reject it rather
  // than silently consuming the next flag as the focus filter.
  if (hasFlag(rest, "--focus") && (focusFlag === undefined || focusFlag.startsWith("--"))) {
    console.error(
      "Missing value for --focus. Expected: project:<id>, topic:<name>, or person:<id>.",
    );
    process.exit(1);
  }

  const token = sinceFlag ?? config.briefing.defaultWindow;
  const window = parseBriefingWindow(token);
  if (!window) {
    console.error(
      `Invalid --since value: ${token}. Accepted: yesterday, today, NNh, NNd, NNw.`,
    );
    process.exit(1);
  }

  // Validate --focus: only treat undefined / empty strings as "no filter".
  // Anything else that parses to null (e.g. "project:", "topic:") is malformed
  // and must be rejected so a templating miss never silently broadens the
  // briefing from a targeted view to all memories. Mirrors the access-service
  // rejection in packages/remnic-core/src/access-service.ts.
  const rawFocus = typeof focusFlag === "string" ? focusFlag.trim() : "";
  const focus = rawFocus.length > 0 ? parseBriefingFocus(rawFocus) : null;
  if (rawFocus.length > 0 && !focus) {
    console.error(
      `Invalid --focus value: expected project:<id>, topic:<name>, or person:<id>, got: ${focusFlag}`,
    );
    process.exit(1);
  }
  // Honor the global --json flag: treat it as shorthand for --format json.
  // If both --json and --format are supplied and they conflict, fail fast.
  const jsonFlag = rest.includes("--json");
  if (jsonFlag && formatFlag !== undefined && formatFlag !== "json") {
    console.error(
      `Conflicting flags: --json and --format ${formatFlag}. Use one or the other.`,
    );
    process.exit(1);
  }
  const effectiveFormatFlag = jsonFlag ? "json" : formatFlag;
  const formatError = validateBriefingFormat(effectiveFormatFlag);
  if (formatError) {
    console.error(formatError);
    process.exit(1);
  }
  const format: "markdown" | "json" =
    effectiveFormatFlag === "json" ? "json" : effectiveFormatFlag === "markdown" ? "markdown" : config.briefing.defaultFormat;

  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  const storage = await orchestrator.getStorage(config.defaultNamespace);

  const calendarSource = config.briefing.calendarSource
    ? new FileCalendarSource(config.briefing.calendarSource)
    : undefined;

  const result = await buildBriefing({
    storage,
    window,
    focus,
    namespace: config.defaultNamespace,
    calendarSource,
    maxFollowups: config.briefing.maxFollowups,
    allowLlm: config.briefing.llmFollowups,
    openaiApiKey: config.openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    model: config.model,
  });

  const payload = format === "json" ? JSON.stringify(result.json, null, 2) : result.markdown;
  console.log(payload);

  if (save) {
    try {
      const saveDir = resolveBriefingSaveDir(config.briefing.saveDir);
      fs.mkdirSync(saveDir, { recursive: true });
      // Use the window's end time (not wall-clock) so the filename is stable
      // regardless of when the command runs — a briefing covering --since 3d
      // gets the same name whether run just before or after UTC midnight.
      const filename = briefingFilename(new Date(result.window.to), format);
      const filePath = path.join(saveDir, filename);
      fs.writeFileSync(filePath, payload + (payload.endsWith("\n") ? "" : "\n"));
      console.error(`Saved briefing: ${filePath}`);
    } catch (err) {
      console.error(`Failed to save briefing: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
}

function cmdDoctor(): void {
  const checks: Array<{ name: string; ok: boolean; warn?: boolean; detail: string; remediation?: string }> = [];

  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  checks.push({
    name: "Node.js version",
    ok: nodeMajor >= 22,
    detail: `${nodeVersion} (requires >= 22.12.0)`,
  });

  const configPath = resolveConfigPath();
  const configExists = fs.existsSync(configPath);
  checks.push({ name: "Config file", ok: configExists, detail: configPath });

  const hasApiKey = !!process.env.OPENAI_API_KEY;
  checks.push({
    name: "OPENAI_API_KEY",
    ok: hasApiKey,
    detail: hasApiKey ? "set" : "not set (extraction will not work)",
  });

  const memoryDir = resolveMemoryDir();
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    checks.push({ name: "Memory directory", ok: true, detail: memoryDir });
  } catch {
    checks.push({ name: "Memory directory", ok: false, detail: `cannot create ${memoryDir}` });
  }

  const svcState = isServiceRunning();
  checks.push({
    name: "Server daemon",
    ok: svcState.running,
    detail: svcState.running ? `running${svcState.pid ? ` (pid ${svcState.pid})` : ""}` : "stopped",
  });

  // ── OpenClaw config checks ──────────────────────────────────────────────────
  const openclawConfigPath = resolveOpenclawConfigPath();
  const openclawConfigExists = fs.existsSync(openclawConfigPath);
  let openclawConfig: Record<string, unknown> = {};
  let openclawConfigValid = false;

  if (openclawConfigExists) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(openclawConfigPath, "utf-8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        openclawConfig = parsed as Record<string, unknown>;
        openclawConfigValid = true;
      } else {
        // Valid JSON but not an object (e.g. null, array, string) — treat as invalid
        openclawConfigValid = false;
      }
    } catch {
      openclawConfigValid = false;
    }
  }

  checks.push({
    name: "OpenClaw config file",
    ok: openclawConfigExists && openclawConfigValid,
    warn: openclawConfigExists && !openclawConfigValid,
    detail: openclawConfigExists
      ? openclawConfigValid
        ? openclawConfigPath
        : `${openclawConfigPath} (invalid JSON)`
      : `${openclawConfigPath} (not found)`,
    remediation: openclawConfigExists && !openclawConfigValid
      ? "Fix the JSON syntax in your OpenClaw config file."
      : !openclawConfigExists
      ? "Run `remnic openclaw install` to create the OpenClaw config with the Remnic entry."
      : undefined,
  });

  if (openclawConfigValid) {
    const plugins = (openclawConfig.plugins ?? {}) as Record<string, unknown>;
    const entries =
      plugins.entries &&
      typeof plugins.entries === "object" &&
      !Array.isArray(plugins.entries)
        ? plugins.entries as Record<string, unknown>
        : null;
    const slots = plugins.slots && typeof plugins.slots === "object"
      ? plugins.slots as Record<string, unknown>
      : null;

    const entriesIsArray = Array.isArray(plugins.entries);
    checks.push({
      name: "OpenClaw plugins.entries",
      ok: !!entries,
      detail: entries ? "present" : entriesIsArray ? "invalid (array)" : "missing",
      remediation: !entries
        ? "Run `remnic openclaw install` to add the Remnic plugin entry."
        : undefined,
    });

    if (entries) {
      const hasNew = REMNIC_OPENCLAW_PLUGIN_ID in entries;
      const hasLegacy = REMNIC_OPENCLAW_LEGACY_PLUGIN_ID in entries;
      checks.push({
        name: "OpenClaw plugin entry",
        ok: hasNew,
        warn: !hasNew && hasLegacy,
        detail: hasNew
          ? `${REMNIC_OPENCLAW_PLUGIN_ID} entry found`
          : hasLegacy
          ? `only legacy ${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID} entry found (upgrade recommended)`
          : "no Remnic entry found",
        remediation: !hasNew && hasLegacy
          ? `Run \`remnic openclaw install\` to migrate from the legacy ${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID} to ${REMNIC_OPENCLAW_PLUGIN_ID}.`
          : !hasNew
          ? "Run `remnic openclaw install` to add the Remnic plugin entry."
          : undefined,
      });

      const slotValue = slots?.memory as string | undefined;
      const validEntryIds = Object.keys(entries);
      const slotMissing = !slotValue;
      const slotMismatch = !slotMissing && !validEntryIds.includes(slotValue);

      // Slot is healthy if it references any present entry id.
      // Legacy REMNIC_OPENCLAW_LEGACY_PLUGIN_ID is functional; REMNIC_OPENCLAW_PLUGIN_ID is preferred.
      const slotMatchesEntry = !slotMissing && !slotMismatch;
      const slotIsLegacy = slotMatchesEntry && slotValue === REMNIC_OPENCLAW_LEGACY_PLUGIN_ID;
      const slotIsPreferred = slotMatchesEntry && slotValue === REMNIC_OPENCLAW_PLUGIN_ID;
      checks.push({
        name: "OpenClaw plugins.slots.memory",
        ok: slotIsPreferred,
        warn: slotIsLegacy,
        detail: slotMissing
          ? "(unset)"
          : slotMismatch
          ? `"${slotValue}" (not found in entries: ${validEntryIds.join(", ")})`
          : `"${slotValue}"`,
        remediation: slotMissing
          ? `Run \`remnic openclaw install\` to set plugins.slots.memory = "${REMNIC_OPENCLAW_PLUGIN_ID}". Without this, hooks never fire.`
          : slotMismatch
          ? `plugins.slots.memory = "${slotValue}" but no matching entry exists. Run \`remnic openclaw install\` to fix.`
          : slotIsLegacy
          ? `Slot is set to the legacy id "${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}". Run \`remnic openclaw install\` to migrate to "${REMNIC_OPENCLAW_PLUGIN_ID}" (optional — hooks fire with either id while the legacy entry is present).`
          : slotMatchesEntry && !slotIsPreferred && !slotIsLegacy
          ? `plugins.slots.memory = "${slotValue}" points to another plugin. Run \`remnic openclaw install\` to set it to "${REMNIC_OPENCLAW_PLUGIN_ID}".`
          : undefined,
      });

      // Check memoryDir exists on disk
      const entryToCheck = (entries[REMNIC_OPENCLAW_PLUGIN_ID] ?? entries[REMNIC_OPENCLAW_LEGACY_PLUGIN_ID]) as Record<string, unknown> | undefined;
      const entryConfig = entryToCheck?.config && typeof entryToCheck.config === "object"
        ? entryToCheck.config as Record<string, unknown>
        : null;
      const configuredMemoryDir = entryConfig?.memoryDir as string | undefined;
      if (configuredMemoryDir) {
        const resolvedMemDir = path.resolve(expandTilde(configuredMemoryDir));
        let memDirOk = false;
        let memDirDetail = `${resolvedMemDir} (not found)`;
        let memDirRemediation: string | undefined = `Run \`remnic openclaw install --memory-dir "${resolvedMemDir}"\` to create the directory.`;
        if (fs.existsSync(resolvedMemDir)) {
          try {
            const stat = fs.statSync(resolvedMemDir);
            if (stat.isDirectory()) {
              memDirOk = true;
              memDirDetail = resolvedMemDir;
              memDirRemediation = undefined;
            } else {
              memDirDetail = `${resolvedMemDir} (exists but is not a directory)`;
              memDirRemediation = `Remove the file at ${resolvedMemDir} and run \`remnic openclaw install --memory-dir "${resolvedMemDir}"\` to create it as a directory.`;
            }
          } catch {
            memDirDetail = `${resolvedMemDir} (cannot stat)`;
          }
        }
        checks.push({
          name: "OpenClaw memoryDir",
          ok: memDirOk,
          warn: !memDirOk,
          detail: memDirDetail,
          remediation: memDirRemediation,
        });
      }
    }
  }

  for (const check of checks) {
    const icon = check.ok ? "✓" : check.warn ? "⚠" : "✗";
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
    if (!check.ok && check.remediation) {
      console.log(`      → ${check.remediation}`);
    }
  }
}

function cmdConfig(): void {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    console.log("No config file found. Run `remnic init` to create one.");
    return;
  }
  console.log(`Config: ${configPath}`);
  const rawConfig = fs.readFileSync(configPath, "utf8");
  const redacted = rawConfig.replace(
    /("(?:openaiApiKey|localLlmApiKey|authToken|apiKey|remoteSearchApiKey|meilisearchApiKey|opikApiKey)"\s*:\s*")([^"]*)(")/g,
    '$1[REDACTED]$3',
  );
  console.log(redacted);
}

async function cmdMigrate(json: boolean, rollback: boolean): Promise<void> {
  if (rollback) {
    const result = await rollbackFromEngramMigration({ quiet: json });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.restored.length === 0 && result.removed.length === 0) {
      console.log("No migration rollback state found.");
      return;
    }
    console.log("Rollback complete.");
    if (result.restored.length > 0) {
      console.log(`  Restored: ${result.restored.length}`);
    }
    if (result.removed.length > 0) {
      console.log(`  Removed: ${result.removed.length}`);
    }
    return;
  }

  const result = await migrateFromEngram({ quiet: json });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "fresh-install") {
    console.log("No Engram install found. Nothing to migrate.");
    return;
  }
  if (result.status === "already-migrated") {
    console.log("Migration already completed.");
    return;
  }
  console.log("Migration complete.");
  console.log(`  Copied: ${result.copied.length}`);
  console.log(`  Tokens rewritten: ${result.tokensRegenerated}`);
  console.log(`  Services updated: ${result.servicesReinstalled.length}`);
  console.log(`  Rollback: ${result.rollbackCommand}`);
}

// ── M4 commands ──────────────────────────────────────────────────────────────

function cmdOnboard(dirPath: string, json: boolean): void {
  const directory = path.resolve(dirPath || process.cwd());
  const result = onboard({ directory });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Shape: ${result.shape}`);
  console.log(`Languages: ${result.languages.map((l) => `${l.language} (${(l.confidence * 100).toFixed(0)}%)`).join(", ")}`);
  console.log(`Docs: ${result.docs.length} file(s)`);
  console.log(result.docs.map((s) => `  ${s.kind} (${s.size} bytes)`).join("\n"));
  console.log(`Plan: ${result.plan.priorityFiles.length} priority, ${result.plan.estimatedFiles} total files`);
  console.log(`\nSuggested namespace: ${result.plan.suggestedNamespace}`);
  console.log(`Total files: ${result.totalFiles}`);
  console.log(`Duration: ${result.durationMs}ms`);
}

async function cmdCurate(targetPath: string, json: boolean): Promise<void> {
  const memoryDir = resolveMemoryDir();
  const result = await curate({
    targetPath: path.resolve(targetPath),
    memoryDir,
    source: "curation",
    checkDuplicates: true,
    checkContradictions: true,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Files: ${result.filesProcessed} processed, ${result.filesSkipped} skipped`);
  console.log(`Statements: ${result.statements.length}`);
  if (result.duplicates.length > 0) console.log(`Duplicates: ${result.duplicates.length}`);
  if (result.contradictions.length > 0) console.log(`Contradictions: ${result.contradictions.length}`);
  console.log(`Written: ${result.written.length}`);
  console.log(`Duration: ${result.durationMs}ms`);
}

function cmdReview(action: string, rest: string[]): void {
  const memoryDir = resolveMemoryDir();
  if (action === "list") {
    const result = listReviewItems({ memoryDir });
    if (result.items.length === 0) {
      console.log("No items pending review.");
      return;
    }
    for (const item of result.items) {
      console.log(`[${item.reviewReason}] ${item.id} ${item.content.slice(0, 80)}${item.content.length > 80 ? "..." : ""}`);
      console.log(`  Confidence: ${item.confidence} | Category: ${item.category}`);
      console.log(`  Source: ${item.source} | Created: ${item.created}`);
    }
    return;
  }

  if (action === "approve" || action === "dismiss" || action === "flag") {
    const id = rest[0];
    if (!id) {
      console.error("Usage: remnic review <approve|dismiss|flag> <id>");
      process.exit(1);
    }
    const result = performReview(memoryDir, id, action as ReviewAction);
    console.log(result.message);
  } else {
    console.log("Usage: remnic review <list|approve|dismiss|flag> [id]");
    process.exit(1);
  }
}

function cmdSync(action: string, rest: string[], json: boolean): void {
  // Extract --source before positional args so that rest args can override it
  const sourceIdx = rest.indexOf("--source");
  const sourceDir = sourceIdx >= 0 && rest[sourceIdx + 1] ? rest[sourceIdx + 1] : ".";
  const memoryDir = resolveMemoryDir();

  if (action === "run") {
    const result = syncChanges({ sourceDir, memoryDir });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Scanned: ${result.scanned}`);
      console.log(`Added: ${result.added.length}`);
      console.log(`Modified: ${result.changed.filter((c) => c.type === "modified").length}`);
      console.log(`Deleted: ${result.deleted.length}`);
      console.log(`Unchanged: ${result.unchanged}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "watch") {
    const { stop } = watchForChanges(
      { sourceDir, memoryDir },
      (changes) => {
        console.log(`Changed: ${changes.length} file(s)`);
        for (const c of changes) {
          console.log(`  [${c.type}] ${c.relativePath}`);
        }
      },
    );
    console.log("Watching... (Ctrl+C to stop)");
    process.on("SIGINT", () => {
      stop();
      console.log("Stopped watching.");
    });
  } else {
    console.log("Usage: remnic sync <run|watch> [--source <dir>]");
    process.exit(1);
  }
}

function cmdDedup(json: boolean): void {
  const memoryDir = resolveMemoryDir();
  const result = findDuplicates({ memoryDir });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Scanned: ${result.scanned} memories`);
  console.log(`Found ${result.duplicates.length} duplicate pairs`);
  for (const dup of result.duplicates) {
    console.log(`  [${dup.action}] ${dup.left.content.slice(0, 60)}...`);
    console.log(`    vs: ${dup.right.content.slice(0, 60)}...`);
    console.log(`    Similarity: ${(dup.similarity * 100).toFixed(2)}%`);
  }
  console.log(`Duration: ${result.durationMs}ms`);
}

// ── M5 connectors command ────────────────────────────────────────────────────

async function cmdConnectors(action: string, rest: string[], json: boolean): Promise<void> {
  // For install/remove/doctor, the connector ID is the first non-flag positional
  // arg. We must strip the value tokens consumed by split-form `--config key=value`
  // flags BEFORE filtering for non-flags, otherwise `installExtension=false`
  // (the value of `--config installExtension=false`) would be mistaken for the
  // connector ID when the user writes:
  //   remnic connectors install --config installExtension=false codex-cli
  const strippedRest = stripConfigArgv(rest);
  const nonFlagArgs = strippedRest.filter((a) => !a.startsWith("--"));
  const connectorId = nonFlagArgs[0];

  if (action === "list") {
    const { installed, available } = listConnectors();
    if (json) {
      console.log(JSON.stringify({ installed, available }, null, 2));
    } else {
      console.log("Available connectors:");
      for (const c of available) {
        const icon = c.installed ? "✓" : "○";
        console.log(`  ${icon} ${c.id.padEnd(22)} ${c.name} v${c.version} — ${c.description}`);
      }
    }
  } else if (action === "install") {
    if (!connectorId) {
      console.error("Usage: remnic connectors install <id>");
      process.exit(1);
    }
    const result = installConnector({
      connectorId,
      config: parseConnectorConfig(rest),
      force: rest.includes("--force"),
    });
    if (result.status === "error") {
      console.error(result.message);
      process.exit(1);
    }
    console.log(result.message);
    if (result.configPath) console.log(`  Config: ${result.configPath}`);
    if (result.status === "already_installed") console.log("Use --force to reinstall.");
    if (result.status === "config_required") console.log("Set config with --config <key>=<value>");
  } else if (action === "remove") {
    if (!connectorId) {
      console.error("Usage: remnic connectors remove <id>");
      process.exit(1);
    }
    const result = removeConnector(connectorId);
    if (result.status === "error") {
      console.error(result.message);
      process.exit(1);
    }
    console.log(result.message);
    if (result.status === "skipped" && result.reason === "config-parse-failed") {
      // A malformed codex-cli.json means we could not verify or complete removal.
      // This is not a benign no-op — the connector may still be partially installed.
      // Exit non-zero so automation does not treat a failed removal as success.
      console.error(
        `Error: removal skipped because the connector config could not be parsed. ` +
          `Fix or delete the config file at ${result.configPath} manually and retry.`,
      );
      process.exit(1);
    }
  } else if (action === "doctor") {
    if (!connectorId) {
      console.error("Usage: remnic connectors doctor <id>");
      process.exit(1);
    }
    const result = await doctorConnector(connectorId);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const check of result.checks) {
        const icon = check.ok ? "✓" : "✗";
        console.log(`  ${icon} ${check.name}: ${check.detail}`);
      }
      console.log(result.healthy ? "\nConnector healthy" : "\nConnector has issues");
    }
  } else {
    console.log("Usage: remnic connectors <list|install|remove|doctor> [id]");
    process.exit(1);
  }
}

// ── M6 space command ──────────────────────────────────────────────────────────

async function cmdSpace(action: string, rest: string[], json: boolean): Promise<void> {
  const nonFlagArgs = rest.filter((a) => !a.startsWith("--"));

  if (action === "list") {
    const spaces = listSpaces();
    if (json) {
      console.log(JSON.stringify(spaces, null, 2));
    } else {
      const active = getActiveSpace();
      for (const s of spaces) {
        const icon = s.id === active.id ? "●" : "○";
        console.log(`  ${icon} ${s.name} (${s.kind}) — ${s.memoryDir}`);
      }
    }
  } else if (action === "switch") {
    const spaceId = nonFlagArgs[0];
    if (!spaceId) {
      console.error("Usage: remnic space switch <id>");
      process.exit(1);
    }
    const result = switchSpace(spaceId);
    console.log(result.message);
  } else if (action === "create") {
    // Extract --parent <id> before computing positional args
    const parentIdx = rest.indexOf("--parent");
    const parentSpaceId = parentIdx >= 0 && rest[parentIdx + 1] ? rest[parentIdx + 1] : undefined;
    // Build positional args excluding --parent and its value
    const positionals: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--parent") { i++; continue; } // skip --parent and its value
      if (rest[i].startsWith("--")) continue;
      positionals.push(rest[i]);
    }
    const name = positionals[0];
    const rawKind = positionals[1] ?? "project";
    const validKinds = ["personal", "project", "team"] as const;
    if (!validKinds.includes(rawKind as typeof validKinds[number])) {
      console.error(`Invalid kind "${rawKind}". Must be one of: ${validKinds.join(", ")}`);
      process.exit(1);
    }
    const kind = rawKind as "personal" | "project" | "team";
    if (!name) {
      console.error("Usage: remnic space create <name> [personal|project|team] [--parent <id>]");
      process.exit(1);
    }
    const space = createSpace({ name, kind, parentSpaceId });
    if (json) {
      console.log(JSON.stringify(space, null, 2));
    } else {
      console.log(`Created space "${space.name}" (${space.id})`);
      console.log(`  Kind: ${space.kind}`);
      console.log(`  Dir: ${space.memoryDir}`);
    }
  } else if (action === "delete") {
    const spaceId = nonFlagArgs[0];
    if (!spaceId) {
      console.error("Usage: remnic space delete <id>");
      process.exit(1);
    }
    deleteSpace(spaceId);
    console.log(`Deleted space "${spaceId}"`);
  } else if (action === "push") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: remnic space push <source> <target>");
      process.exit(1);
    }
    const result = pushToSpace(sourceId, targetId, { force: rest.includes("--force") });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Pushed ${result.memoriesPushed} memories`);
      if (result.conflicts.length > 0) console.log(`Conflicts: ${result.conflicts.length}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "pull") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: remnic space pull <source> <target>");
      process.exit(1);
    }
    const result = pullFromSpace(sourceId, targetId, { force: rest.includes("--force") });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Pulled ${result.memoriesPulled} memories`);
      if (result.conflicts.length > 0) console.log(`Conflicts: ${result.conflicts.length}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "share") {
    const spaceId = nonFlagArgs[0];
    const members = nonFlagArgs.slice(1);
    if (!spaceId || members.length === 0) {
      console.error("Usage: remnic space share <id> <member1> [member2 ...]");
      process.exit(1);
    }
    const result = shareSpace(spaceId, members);
    console.log(result.message);
  } else if (action === "promote") {
    const sourceId = nonFlagArgs[0];
    const targetId = nonFlagArgs[1];
    if (!sourceId || !targetId) {
      console.error("Usage: remnic space promote <source> <target>");
      process.exit(1);
    }
    const result = promoteSpace(sourceId, targetId, {
      force: rest.includes("--force"),
      forceOverwrite: rest.includes("--force-overwrite"),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Promoted ${result.memoriesPromoted} memories`);
      if (result.conflicts.length > 0) console.log(`Conflicts: ${result.conflicts.length}`);
      console.log(`Duration: ${result.durationMs}ms`);
    }
  } else if (action === "audit") {
    const entries = getAuditLog();
    if (json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      if (entries.length === 0) {
        console.log("No audit entries.");
      } else {
        for (const e of entries.slice(-50)) {
          console.log(`[${e.timestamp}] ${e.action} ${e.details}`);
        }
      }
    }
  } else {
    console.log("Usage: remnic space <list|switch|create|delete|push|pull|share|promote|audit>");
    process.exit(1);
  }
}

// ── M7 benchmark command ───────────────────────────────────────────────────────

async function cmdBenchmark(action: string, rest: string[], json: boolean): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);
  const orchestrator = new Orchestrator(config);
  const service = new EngramAccessService(orchestrator);

  const benchConfig: BenchConfig = {
    queries: rest.filter((a) => !a.startsWith("--")).length > 0
      ? rest.filter((a) => !a.startsWith("--"))
      : undefined,
    explain: rest.includes("--explain"),
    baselinePath: rest.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length),
    reportPath: rest.find((a) => a.startsWith("--report="))?.slice("--report=".length),
  };

  if (action === "run") {
    const suite = await runBenchSuite(service, benchConfig);
    if (json) {
      console.log(JSON.stringify(suite, null, 2));
    } else {
      console.log(`Benchmark suite completed in ${suite.totalDurationMs}ms`);
      for (const r of suite.results) {
        const tiers = r.tiersUsed.join(" → ");
        console.log(`  ${r.query}: ${r.latencyMs}ms (${r.resultsCount} results) [${tiers}]`);
      }
      if (suite.regressions.length > 0) {
        console.log("\nRegressions:");
        for (const reg of suite.regressions) {
          const icon = reg.passed ? "✓" : "✗";
          console.log(`  ${icon} ${reg.metric}: ${reg.currentValue}ms (baseline: ${reg.baselineValue}ms, tolerance: ${reg.tolerance}%)`);
        }
      }
    }
  } else if (action === "check") {
    const baselinePath = benchConfig.baselinePath;
    const baseline = loadBaseline(baselinePath);
    if (!baseline) {
      console.log("No baseline found. Run `remnic benchmark run` first.");
      return;
    }
    const suite = await runBenchSuite(service, benchConfig);
    const metrics: Record<string, number> = {};
    for (const r of suite.results) {
      metrics[r.query] = r.latencyMs;
    }
    const tolerance = benchConfig.regressionTolerance ?? 10;
    const result = checkRegression(metrics, baseline, tolerance);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.passed) {
        console.log("No regressions detected.");
      } else {
        console.log("Regressions detected:");
        for (const reg of result.regressions) {
          if (!reg.passed) {
            console.log(`  ✗ ${reg.metric}: ${reg.currentValue}ms vs ${reg.baselineValue}ms baseline (+${(((reg.currentValue - reg.baselineValue) / reg.baselineValue) * 100).toFixed(1)}%)`);
          }
        }
      }
    }
    if (!result.passed) {
      process.exit(1);
    }
  } else if (action === "report") {
    const reportPath = benchConfig.reportPath;
    const suite = await runBenchSuite(service, { ...benchConfig, reportPath });
    console.log(`Report saved to ${reportPath ?? "benchmarks/report.json"}`);
    if (json) {
      console.log(JSON.stringify(suite.report, null, 2));
    }
  } else {
    console.log("Usage: remnic benchmark <run|check|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]");
    process.exit(1);
  }
}

// ── Daemon management ────────────────────────────────────────────────────────

const LOGS_DIR = path.join(PID_DIR, "logs");
const LAUNCHD_LABEL = "ai.remnic.daemon";
const LEGACY_LAUNCHD_LABEL = "ai.engram.daemon";
const LAUNCHD_PLIST_PATH = path.join(
  resolveHomeDir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);
const LEGACY_LAUNCHD_PLIST_PATH = path.join(
  resolveHomeDir(),
  "Library",
  "LaunchAgents",
  `${LEGACY_LAUNCHD_LABEL}.plist`,
);
const SYSTEMD_SERVICE = "remnic.service";
const LEGACY_SYSTEMD_SERVICE = "engram.service";
const SYSTEMD_UNIT_PATH = path.join(
  resolveHomeDir(),
  ".config",
  "systemd",
  "user",
  SYSTEMD_SERVICE,
);
const LEGACY_SYSTEMD_UNIT_PATH = path.join(
  resolveHomeDir(),
  ".config",
  "systemd",
  "user",
  LEGACY_SYSTEMD_SERVICE,
);


function readPid(): number | undefined {
  for (const file of [PID_FILE, LEGACY_PID_FILE]) {
    try {
      return parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    } catch {
      // Try next candidate
    }
  }
  return undefined;
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

function resolveNodePath(): string {
  return process.execPath;
}

function resolveServerBin(): string {
  // Prefer built dist (production), fall back to source (dev)
  const distPath = path.resolve(import.meta.dirname, "../../remnic-server/dist/index.js");
  if (fs.existsSync(distPath)) return distPath;
  const srcPath = path.resolve(import.meta.dirname, "../../remnic-server/src/index.ts");
  return srcPath;
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function renderTemplate(templateContent: string, vars: Record<string, string>): string {
  let result = templateContent;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function daemonInstall(): void {
  const home = resolveHomeDir();
  const nodePath = resolveNodePath();
  const serverBin = resolveServerBin();

  // Service templates use plain `node` — TypeScript source won't work
  if (serverBin.endsWith(".ts")) {
    console.error("Error: @remnic/server has not been built. Run 'pnpm run build --filter=@remnic/server' first.");
    console.error(`  Expected: ${path.resolve(import.meta.dirname, "../../remnic-server/dist/index.js")}`);
    console.error(`  Found:    ${serverBin} (TypeScript source — not loadable by node)`);
    process.exit(1);
  }

  const vars = { HOME: home, NODE_PATH: nodePath, REMNIC_SERVER_BIN: serverBin };

  fs.mkdirSync(LOGS_DIR, { recursive: true });

  if (isMacOS()) {
    const templatePath = path.resolve(import.meta.dirname, "../templates/launchd/ai.remnic.daemon.plist");
    const template = fs.readFileSync(templatePath, "utf8");
    const plist = renderTemplate(template, vars);
    fs.mkdirSync(path.dirname(LAUNCHD_PLIST_PATH), { recursive: true });
    fs.writeFileSync(LAUNCHD_PLIST_PATH, plist);
    try {

      childProcess.execSync(`launchctl load -w "${LAUNCHD_PLIST_PATH}"`, { stdio: "pipe" });
    } catch {
      // May already be loaded
    }
    console.log(`Installed launchd service: ${LAUNCHD_PLIST_PATH}`);
    console.log(`  Label: ${LAUNCHD_LABEL}`);
    console.log(`  RunAtLoad: true, KeepAlive: true`);
    console.log(`  Logs: ${LOGS_DIR}/daemon.log`);
  } else if (isLinux()) {
    const templatePath = path.resolve(import.meta.dirname, "../templates/systemd/remnic.service");
    const template = fs.readFileSync(templatePath, "utf8");
    const unit = renderTemplate(template, vars);
    fs.mkdirSync(path.dirname(SYSTEMD_UNIT_PATH), { recursive: true });
    fs.writeFileSync(SYSTEMD_UNIT_PATH, unit);
    try {

      childProcess.execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      childProcess.execSync(`systemctl --user enable ${SYSTEMD_SERVICE}`, { stdio: "pipe" });
      childProcess.execSync(`systemctl --user start ${SYSTEMD_SERVICE}`, { stdio: "pipe" });
    } catch {
      // May fail if systemd not available
    }
    console.log(`Installed systemd user service: ${SYSTEMD_UNIT_PATH}`);
    console.log(`  Restart: on-failure, WantedBy: default.target`);
    console.log(`  Logs: ${LOGS_DIR}/daemon.log`);
  } else {
    console.error(`Unsupported platform: ${process.platform}. Use 'remnic daemon start' for manual mode.`);
    process.exit(1);
  }
}

function daemonUninstall(): void {
  if (isMacOS()) {
    let removed = false;
    for (const plistPath of [LAUNCHD_PLIST_PATH, LEGACY_LAUNCHD_PLIST_PATH]) {
      try {
        childProcess.execSync(`launchctl unload "${plistPath}"`, { stdio: "pipe" });
      } catch {
        // May not be loaded
      }
      try {
        fs.unlinkSync(plistPath);
        removed = true;
        console.log(`Removed launchd service: ${plistPath}`);
      } catch {
        // keep going
      }
    }
    if (!removed) {
      console.log("Launchd plist not found — nothing to remove.");
    }
  } else if (isLinux()) {
    for (const serviceName of [SYSTEMD_SERVICE, LEGACY_SYSTEMD_SERVICE]) {
      try {
        childProcess.execSync(`systemctl --user stop ${serviceName}`, { stdio: "pipe" });
        childProcess.execSync(`systemctl --user disable ${serviceName}`, { stdio: "pipe" });
      } catch {
        // May not be active
      }
    }
    let removed = false;
    for (const unitPath of [SYSTEMD_UNIT_PATH, LEGACY_SYSTEMD_UNIT_PATH]) {
      try {
        fs.unlinkSync(unitPath);
        removed = true;
        console.log(`Removed systemd service: ${unitPath}`);
      } catch {
        // keep going
      }
    }
    if (removed) {
      try {
        childProcess.execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      } catch {
        // Keep uninstall best-effort when user systemd is unavailable.
      }
    } else {
      console.log("Systemd unit not found — nothing to remove.");
    }
  } else {
    console.error(`Unsupported platform: ${process.platform}.`);
    process.exit(1);
  }
  // Also stop any manually-started daemon
  daemonStop();
}

function isServiceRunning(): { running: boolean; pid?: number } {
  // Check PID file first (manual `daemon start`)
  const pidFromFile = readPid();
  if (pidFromFile) {
    try {
      process.kill(pidFromFile, 0);
      return { running: true, pid: pidFromFile };
    } catch {
      // stale pid file
    }
  }
  // Check service manager (launchd/systemd from `daemon install`)
  if (isMacOS()) {
    const status = firstSuccessfulResult([LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL], (label) => {
      const out = childProcess.execSync(`launchctl list ${label} 2>/dev/null`, { encoding: "utf8" });
      const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
      if (pidMatch) return { running: true, pid: parseInt(pidMatch[1], 10) };
      return out.includes('"PID"') ? { running: true } : undefined;
    });
    if (status) return status;
  } else if (isLinux()) {
    const status = firstSuccessfulResult([SYSTEMD_SERVICE, LEGACY_SYSTEMD_SERVICE], (serviceName) => {
      const out = childProcess.execSync(`systemctl --user is-active ${serviceName} 2>/dev/null`, {
        encoding: "utf8",
      }).trim();
      if (out !== "active") return undefined;
      try {
        const pidOut = childProcess.execSync(
          `systemctl --user show ${serviceName} --property=MainPID --value`,
          { encoding: "utf8" },
        ).trim();
        const spid = parseInt(pidOut, 10);
        if (spid > 0) return { running: true, pid: spid };
      } catch {
        // Keep the service running result even if MainPID lookup fails.
      }
      return { running: true };
    });
    if (status) return status;
  }
  return { running: false };
}

function daemonStatus(): void {
  const { running, pid } = isServiceRunning();
  const port = inferPort();
  const serviceInstalled = isMacOS()
    ? fs.existsSync(LAUNCHD_PLIST_PATH) || fs.existsSync(LEGACY_LAUNCHD_PLIST_PATH)
    : isLinux()
      ? fs.existsSync(SYSTEMD_UNIT_PATH) || fs.existsSync(LEGACY_SYSTEMD_UNIT_PATH)
      : false;

  console.log(`Remnic daemon status:`);
  console.log(`  Running:   ${running ? `yes${pid ? ` (pid ${pid})` : ""}` : "no"}`);
  console.log(`  Port:      ${port}`);
  console.log(`  Service:   ${serviceInstalled ? "installed" : "not installed"}`);
  console.log(`  Platform:  ${process.platform}`);
  console.log(`  PID file:  ${fs.existsSync(PID_FILE) ? PID_FILE : LEGACY_PID_FILE}`);
  console.log(`  Log file:  ${fs.existsSync(LOG_FILE) ? LOG_FILE : LEGACY_LOG_FILE}`);
}

function daemonStart(): void {
  const svc = isServiceRunning();
  if (svc.running) {
    console.log(`Already running${svc.pid ? ` (pid ${svc.pid})` : " (via service manager)"}`);
    return;
  }

  // Try service manager first (for daemons installed via `remnic daemon install`)
  if (isMacOS() && (fs.existsSync(LAUNCHD_PLIST_PATH) || fs.existsSync(LEGACY_LAUNCHD_PLIST_PATH))) {
    const label = firstSuccessfulCandidate([LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL], (candidate) => {
      childProcess.execSync(`launchctl start ${candidate} 2>/dev/null`, { stdio: "pipe" });
    });
    if (label) {
      console.log(`Started remnic daemon via launchd (${label})`);
      return;
    }
  } else if (isLinux() && (fs.existsSync(SYSTEMD_UNIT_PATH) || fs.existsSync(LEGACY_SYSTEMD_UNIT_PATH))) {
    const serviceName = firstSuccessfulCandidate([SYSTEMD_SERVICE, LEGACY_SYSTEMD_SERVICE], (candidate) => {
      childProcess.execSync(`systemctl --user start ${candidate}`, { stdio: "pipe" });
    });
    if (serviceName) {
      console.log(`Started remnic daemon via systemd (${serviceName})`);
      return;
    }
  }

  fs.mkdirSync(PID_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logStream = fs.openSync(LOG_FILE, "a");

  const serverBin = resolveServerBin();
  const isSource = serverBin.endsWith(".ts");

  let cmd: string;
  let args: string[];
  if (isSource) {
    // Dev mode: use npx tsx
    cmd = "npx";
    args = ["tsx", serverBin];
  } else {
    // Production: use node directly
    cmd = process.execPath;
    args = [serverBin];
  }

  const child = childProcess.spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", logStream, logStream],
    env: {
      ...process.env,
      REMNIC_DAEMON: "1",
      ENGRAM_DAEMON: process.env.ENGRAM_DAEMON ?? "1",
    },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  console.log(`Started remnic server (pid ${child.pid})`);
  console.log(`  Log: ${LOG_FILE}`);
}

function daemonStop(): void {
  // Try service manager first (for daemons started via `remnic daemon install`)
  if (isMacOS() && (fs.existsSync(LAUNCHD_PLIST_PATH) || fs.existsSync(LEGACY_LAUNCHD_PLIST_PATH))) {
    const label = firstSuccessfulCandidate([LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL], (candidate) => {
      childProcess.execSync(`launchctl stop ${candidate} 2>/dev/null`, { stdio: "pipe" });
    });
    if (label) {
      console.log(`Stopped remnic daemon via launchd (${label})`);
      return;
    }
  } else if (isLinux() && (fs.existsSync(SYSTEMD_UNIT_PATH) || fs.existsSync(LEGACY_SYSTEMD_UNIT_PATH))) {
    const serviceName = firstSuccessfulCandidate([SYSTEMD_SERVICE, LEGACY_SYSTEMD_SERVICE], (candidate) => {
      childProcess.execSync(`systemctl --user stop ${candidate}`, { stdio: "pipe" });
    });
    if (serviceName) {
      console.log(`Stopped remnic daemon via systemd (${serviceName})`);
      return;
    }
  }

  // Fall back to PID file (for daemons started via `remnic daemon start`)
  const pid = readPid();
  if (!pid) {
    console.log("Not running");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped remnic server (pid ${pid})`);
  } catch {
    console.log("Process not found (cleaning up PID file)");
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(LEGACY_PID_FILE);
  } catch {
    // ignore
  }
}

function daemonRestart(): void {
  daemonStop();
  setTimeout(() => daemonStart(), 1000);
}

// ── Token management ────────────────────────────────────────────────────────

function cmdTokenGenerate(connector: string): void {
  if (!connector) {
    console.error("Usage: remnic token generate <connector-id>");
    console.error("  e.g.: remnic token generate claude-code");
    process.exit(1);
  }
  const entry = generateToken(connector);
  console.log(`Generated token for ${connector}:`);
  console.log(`  Token:   ${entry.token}`);
  console.log(`  Created: ${entry.createdAt}`);
  console.log(`\nUse this token as the Bearer token when connecting from ${connector}.`);
}

function cmdTokenList(json: boolean): void {
  const tokens = listTokens();
  if (json) {
    console.log(JSON.stringify(tokens, null, 2));
    return;
  }
  if (tokens.length === 0) {
    console.log("No tokens. Generate one with: remnic token generate <connector-id>");
    return;
  }
  console.log("Connector tokens:");
  for (const t of tokens) {
    // Show only first 20 chars of token for security
    const masked = t.token.slice(0, 20) + "…";
    console.log(`  ${t.connector.padEnd(16)} ${masked}  (created ${t.createdAt})`);
  }
}

function cmdTokenRevoke(connector: string): void {
  if (!connector) {
    console.error("Usage: remnic token revoke <connector-id>");
    process.exit(1);
  }
  if (revokeToken(connector)) {
    console.log(`Revoked token for ${connector}`);
  } else {
    console.log(`No token found for ${connector}`);
  }
}

// ── OpenClaw install command ──────────────────────────────────────────────────

interface OpenclawInstallOptions {
  yes: boolean;
  dryRun: boolean;
  memoryDir?: string;
  configPath?: string;
}

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  // In non-interactive environments, default to yes
  if (!process.stdin.isTTY) return defaultYes;
  process.stdout.write(question + " ");
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        const answer = buf.slice(0, nl).trim().toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") {
          resolve(defaultYes || answer !== "");
        } else if (answer === "n" || answer === "no") {
          resolve(false);
        } else {
          resolve(defaultYes);
        }
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function cmdOpenclawInstall(opts: OpenclawInstallOptions): Promise<void> {
  const configPath = resolveOpenclawConfigPath(opts.configPath);
  const fallbackMemoryDir = path.join(resolveHomeDir(), ".openclaw", "workspace", "memory", "local");

  console.log(`OpenClaw config: ${configPath}`);

  const existingConfig = readOpenclawConfig(configPath);
  const plugins = (existingConfig.plugins ?? {}) as Record<string, unknown>;

  // Validate plugins.entries before using the `in` operator — a malformed but
  // parse-valid config (e.g. "entries": 1) must produce a clear error rather
  // than a cryptic TypeError.
  const rawEntries = plugins.entries;
  if (rawEntries !== undefined && (typeof rawEntries !== "object" || rawEntries === null || Array.isArray(rawEntries))) {
    throw new Error(
      `OpenClaw config at ${configPath} has an invalid plugins.entries field (expected an object, got ${Array.isArray(rawEntries) ? "array" : typeof rawEntries}). ` +
      `Fix the file manually and re-run.`,
    );
  }
  const entries = (rawEntries ?? {}) as Record<string, unknown>;
  const slots = (plugins.slots ?? {}) as Record<string, unknown>;

  // Check for legacy entry. REMNIC_OPENCLAW_PLUGIN_ID is the canonical (post-#405) id.
  // REMNIC_OPENCLAW_LEGACY_PLUGIN_ID is the pre-#405 id retained for rollback/migration.
  const hasLegacy = REMNIC_OPENCLAW_LEGACY_PLUGIN_ID in entries;
  const hasNew = REMNIC_OPENCLAW_PLUGIN_ID in entries;
  const currentSlot = slots.memory as string | undefined;

  let migrateLegacy = false;
  if (hasLegacy && !opts.yes) {
    migrateLegacy = await promptYesNo(
      `Found legacy '${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}' entry. Migrate to '${REMNIC_OPENCLAW_PLUGIN_ID}'? [Y/n]`,
      true,
    );
  } else if (hasLegacy) {
    migrateLegacy = true;
  }

  // Build the new config.
  // When migrating (migrateLegacy=true): merge legacy config values so operators
  // don't lose settings like custom models, then let the existing new-entry config
  // and the explicit memoryDir take precedence.
  // When NOT migrating: only carry forward the existing openclaw-remnic config (if any).
  const legacyEntry = entries[REMNIC_OPENCLAW_LEGACY_PLUGIN_ID] as Record<string, unknown> | undefined;
  const existingNewEntry = entries[REMNIC_OPENCLAW_PLUGIN_ID] as Record<string, unknown> | undefined;

  const legacyConfigToMerge =
    migrateLegacy && legacyEntry?.config && typeof legacyEntry.config === "object"
      ? (legacyEntry.config as Record<string, unknown>)
      : {};

  const existingNewEntryConfig =
    existingNewEntry?.config && typeof existingNewEntry.config === "object"
      ? (existingNewEntry.config as Record<string, unknown>)
      : {};

  // Determine the final memoryDir. Operator-provided --memory-dir always wins.
  // On reinstall (no --memory-dir flag), preserve the currently configured value
  // so running `remnic openclaw install` as a repair doesn't silently relocate
  // the memory namespace. Fall back to the default only when no prior value exists.
  const existingMemoryDir =
    (existingNewEntryConfig.memoryDir as string | undefined) ||
    (migrateLegacy ? (legacyConfigToMerge.memoryDir as string | undefined) : undefined);
  const memoryDir = opts.memoryDir
    ? path.resolve(expandTilde(opts.memoryDir))
    : existingMemoryDir
      ? path.resolve(expandTilde(existingMemoryDir))
      : fallbackMemoryDir;

  console.log(`Memory dir:      ${memoryDir}`);

  // Preserve all top-level entry fields (e.g. hooks, enabled) from the
  // existing openclaw-remnic entry so reinstalls don't silently drop runtime
  // policy. Only the config sub-object is updated.
  const newEntry: Record<string, unknown> = {
    ...(existingNewEntry ?? {}),
    config: {
      ...legacyConfigToMerge,
      ...existingNewEntryConfig,
      memoryDir,
    },
  };

  const updatedEntries: Record<string, unknown> = { ...entries };
  // Write the entry under the canonical plugin id. The slot below must match this id.
  updatedEntries[REMNIC_OPENCLAW_PLUGIN_ID] = newEntry;

  // Keep legacy entry if migrating so rollback is possible — operator can remove
  // the legacy entry after verifying that hooks fire under the new id.

  // Update the memory slot to the canonical plugin id, UNLESS the operator
  // declined migration AND the slot is already actively pointing at the legacy
  // entry — in that case leave it alone so their working hooks keep firing
  // while they evaluate the new entry.
  // All other cases (unset, mismatched, already pointing at the new id, no
  // legacy entry at all) should be updated so the install results in a
  // working configuration rather than an incomplete one.
  const slotIsActiveLegacy =
    hasLegacy && !migrateLegacy && currentSlot === REMNIC_OPENCLAW_LEGACY_PLUGIN_ID;
  const updatedSlots = slotIsActiveLegacy
    ? { ...slots }
    : { ...slots, memory: REMNIC_OPENCLAW_PLUGIN_ID };

  const updatedConfig: Record<string, unknown> = {
    ...existingConfig,
    plugins: {
      ...plugins,
      entries: updatedEntries,
      slots: updatedSlots,
    },
  };

  // What will change
  const changes: string[] = [];
  if (!hasNew) changes.push(`+ Added plugins.entries["${REMNIC_OPENCLAW_PLUGIN_ID}"]`);
  else changes.push(`~ Updated plugins.entries["${REMNIC_OPENCLAW_PLUGIN_ID}"].config.memoryDir`);
  if (!slotIsActiveLegacy && currentSlot !== REMNIC_OPENCLAW_PLUGIN_ID) {
    changes.push(`~ Set plugins.slots.memory = "${REMNIC_OPENCLAW_PLUGIN_ID}" (was: ${currentSlot ?? "(unset)"})`);
  } else if (slotIsActiveLegacy) {
    changes.push(`  Slot left as "${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}" — re-run with --yes to activate the new entry`);
  }
  if (!fs.existsSync(memoryDir)) changes.push(`+ Will create memory directory: ${memoryDir}`);
  if (hasLegacy && migrateLegacy) {
    changes.push(`~ Legacy '${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}' entry retained (safe to remove after verifying hooks fire)`);
  }

  if (opts.dryRun) {
    console.log("\n--- DRY RUN — no changes written ---");
    for (const c of changes) console.log("  " + c);
    console.log("\nResulting config diff:");
    console.log(JSON.stringify(updatedConfig.plugins, null, 2));
    return;
  }

  // Create memory dir
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
    console.log(`Created memory directory: ${memoryDir}`);
  }

  // Write config
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2) + "\n");

  console.log("\nDone! Summary of changes:");
  for (const c of changes) console.log("  " + c);

  if (hasLegacy && migrateLegacy) {
    console.log(
      `\nNote: The legacy '${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}' entry has been kept alongside '${REMNIC_OPENCLAW_PLUGIN_ID}'.`,
    );
    console.log(
      "Once you verify that [remnic] gateway_start fired appears in your gateway log,",
    );
    console.log(`you can safely remove the '${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID}' entry from openclaw.json.`);
  }

  console.log("\nNext steps:");
  console.log("  1. Restart the OpenClaw gateway:");
  console.log("       launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway");
  console.log("  2. Start a conversation — check your gateway log for:");
  console.log("       [remnic] gateway_start fired — Remnic memory plugin is active");
  console.log("  3. Run `remnic doctor` to verify the full configuration.");
}

// ── CLI entry ────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== "migrate") {
    await migrateFromEngram();
  }

  switch (command as CommandName) {
    case "init":
      cmdInit();
      break;

    case "migrate": {
      const json = rest.includes("--json");
      const rollback = rest.includes("--rollback");
      await cmdMigrate(json, rollback);
      break;
    }

    case "status": {
      const json = rest.includes("--json");
      await cmdStatus(json);
      break;
    }

    case "query": {
      const json = rest.includes("--json");
      const explain = rest.includes("--explain");
      const queryText = rest.filter((a) => !a.startsWith("--")).join(" ");
      await cmdQuery(queryText, json, explain);
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
        case "install":
          daemonInstall();
          break;
        case "uninstall":
          daemonUninstall();
          break;
        case "status":
          daemonStatus();
          break;
        default:
          console.log("Usage: remnic daemon <start|stop|restart|install|uninstall|status>");
          process.exit(1);
      }
      break;
    }

    case "token": {
      const action = rest[0] as TokenAction;
      const json = rest.includes("--json");
      switch (action) {
        case "generate":
          cmdTokenGenerate(rest[1]);
          break;
        case "list":
          cmdTokenList(json);
          break;
        case "revoke":
          cmdTokenRevoke(rest[1]);
          break;
        default:
          console.log("Usage: remnic token <generate|list|revoke> [connector-id] [--json]");
          process.exit(1);
      }
      break;
    }

    case "tree": {
      const subAction = rest[0];
      const json = rest.includes("--json");
      const outputDir = resolveFlag(rest, "--output") ?? path.join(process.cwd(), ".remnic", "context-tree");
      const categoriesFlag = resolveFlag(rest, "--categories");
      const categories = categoriesFlag ? categoriesFlag.split(",") : undefined;
      const maxPerCategoryRaw = resolveFlag(rest, "--max-per-category");
      let maxPerCategory: number | undefined;
      if (maxPerCategoryRaw !== undefined) {
        maxPerCategory = parseInt(maxPerCategoryRaw, 10);
        if (!Number.isFinite(maxPerCategory) || maxPerCategory < 1) {
          console.error(`Invalid --max-per-category: ${maxPerCategoryRaw}`);
          process.exit(1);
        }
      }

      if (subAction === "generate") {
        const result = await generateContextTree({
          memoryDir: resolveMemoryDir(),
          outputDir,
          categories,
          maxPerCategory,
          includeEntities: !rest.includes("--no-entities"),
          includeQuestions: !rest.includes("--no-questions"),
        });
        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Context tree generated at ${result.outputDir}`);
          console.log(`  Nodes: ${result.nodesGenerated} generated, ${result.nodesSkipped} skipped`);
          for (const [cat, count] of Object.entries(result.categories)) {
            console.log(`  ${cat}: ${count}`);
          }
          console.log(`  Duration: ${result.durationMs}ms`);
        }
      } else if (subAction === "watch") {
        const memoryDir = resolveMemoryDir();
        console.log(`Watching ${memoryDir} for changes…`);
        console.log(`Output: ${outputDir}`);
        console.log("Press Ctrl+C to stop.\n");

        // Initial generation
        const initial = await generateContextTree({
          memoryDir,
          outputDir,
          categories,
          maxPerCategory,
          includeEntities: !rest.includes("--no-entities"),
          includeQuestions: !rest.includes("--no-questions"),
        });
        console.log(`Initial: ${initial.nodesGenerated} nodes (${initial.durationMs}ms)`);

        // Debounced watcher
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        const rebuild = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            const t0 = Date.now();
            try {
              const result = await generateContextTree({
                memoryDir,
                outputDir,
                categories,
                maxPerCategory,
                includeEntities: !rest.includes("--no-entities"),
                includeQuestions: !rest.includes("--no-questions"),
              });
              console.log(`[${new Date().toISOString()}] Rebuilt: ${result.nodesGenerated} nodes (${Date.now() - t0}ms)`);
            } catch (err) {
              console.error(`[${new Date().toISOString()}] Rebuild failed:`, err instanceof Error ? err.message : err);
            }
          }, 500);
        };

        fs.watch(memoryDir, { recursive: true }, (_event, filename) => {
          if (filename && filename.startsWith(".")) return;
          rebuild();
        });

        // Keep process alive
        await new Promise(() => {});
      } else if (subAction === "validate") {
        const treeDir = outputDir;
        if (!fs.existsSync(treeDir)) {
          console.error(`Context tree not found at ${treeDir}. Run 'remnic tree generate' first.`);
          process.exit(1);
        }
        const indexPath = path.join(treeDir, "INDEX.md");
        if (!fs.existsSync(indexPath)) {
          console.error(`INDEX.md missing in ${treeDir}. Tree may be corrupt — regenerate.`);
          process.exit(1);
        }
        console.log(`Context tree at ${treeDir} is valid.`);
      } else {
        console.log(`Usage: remnic tree <generate|watch|validate>
  generate                Generate context tree from memory
  watch                   Watch memory dir and regenerate on changes
  validate                Check that context tree exists and is valid

Options:
  --output <dir>          Output directory (default: .remnic/context-tree)
  --categories <list>     Comma-separated categories to include
  --max-per-category <n>  Max nodes per category
  --no-entities           Exclude entity nodes
  --no-questions          Exclude question nodes
  --json                  JSON output (generate only)`);
      }
      break;
    }

    case "onboard": {
      const dir = rest[0] ?? ".";
      const json = rest.includes("--json");
      cmdOnboard(dir, json);
      break;
    }

    case "curate": {
      const targetPath = rest[0];
      const json = rest.includes("--json");
      if (!targetPath) {
        console.error("Usage: remnic curate <path>");
        process.exit(1);
      }
      await cmdCurate(targetPath, json);
      break;
    }

    case "review": {
      const action = rest[0] ?? "list";
      cmdReview(action, rest.slice(1));
      break;
    }

    case "sync": {
      const action = rest[0] ?? "run";
      const json = rest.includes("--json");
      cmdSync(action, rest.slice(1), json);
      break;
    }

    case "dedup": {
      const json = rest.includes("--json");
      cmdDedup(json);
      break;
    }

    case "connectors": {
      const action = rest[0] ?? "list";
      const json = rest.includes("--json");
      await cmdConnectors(action, rest.slice(1), json);
      break;
    }

    case "space": {
      const action = rest[0] ?? "list";
      const json = rest.includes("--json");
      await cmdSpace(action, rest.slice(1), json);
      break;
    }

    case "benchmark": {
      const action = rest[0] ?? "run";
      const json = rest.includes("--json");
      await cmdBenchmark(action, rest.slice(1), json);
      break;
    }

    case "briefing": {
      await cmdBriefing(rest);
      break;
    }

    case "openclaw": {
      const subAction = rest[0] ?? "help";
      if (subAction === "install") {
        const yes = rest.includes("--yes") || rest.includes("-y") || rest.includes("--force");
        const dryRun = rest.includes("--dry-run");
        const memoryDir = resolveFlagStrict(rest, "--memory-dir");
        const configOverride = resolveFlagStrict(rest, "--config");
        await cmdOpenclawInstall({ yes, dryRun, memoryDir, configPath: configOverride });
      } else {
        console.log(`Usage: remnic openclaw <install>

  install    Configure OpenClaw to use Remnic as the memory plugin.

             Sets plugins.entries["${REMNIC_OPENCLAW_PLUGIN_ID}"] and plugins.slots.memory
             in ~/.openclaw/openclaw.json (or $OPENCLAW_CONFIG_PATH).

Options:
  --yes / -y / --force    Skip interactive prompts, assume Y
  --dry-run               Print resulting config diff without writing
  --memory-dir <path>     Override default memory dir (~/.openclaw/workspace/memory/local)
  --config <path>         Override OpenClaw config path`);
      }
      break;
    }

    default:
      console.log(`
remnic — Remnic memory CLI

Usage:
  remnic init                  Create config file
  remnic migrate [--rollback] [--json]  Run or undo first-run Engram migration
  remnic status [--json]       Show server status
  remnic query <text> [--json] [--explain] Query memories (use --explain for tier breakdown)

  remnic doctor                Run diagnostics
  remnic config                Show current config
  remnic openclaw install      Configure OpenClaw to use Remnic memory (sets slot + entry)
    --yes / -y / --force       Skip prompts
    --dry-run                  Preview changes without writing
    --memory-dir <path>        Custom memory directory
    --config <path>            Custom OpenClaw config path
  remnic daemon <start|stop|restart|install|uninstall|status>  Manage background server
  remnic token <generate|list|revoke> [connector-id]  Manage auth tokens
  remnic tree <generate|watch|validate>  Generate context tree
  remnic onboard [dir] [--json]     Onboard project directory
  remnic curate <path> [--json]  Curate files into memory
  remnic review <list|approve|dismiss|flag> [id]  Review inbox
  remnic sync <run|watch> [--source <dir>] Diff-aware sync
  remnic dedup [--json]             Find duplicate memories
  remnic connectors <list|install|remove|doctor> [id]  Manage connectors
  remnic space <list|switch|create|delete|push|pull|share|promote|audit>  Manage spaces
    create accepts --parent <id> to set parent-child relationship
  remnic benchmark <run|check|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]
  remnic briefing [--since <window>] [--focus <filter>] [--save] [--format markdown|json]
    Daily context briefing. Windows: yesterday, today, NNh, NNd, NNw.
    Focus: person:<name>, project:<name>, topic:<name>.

Options:
  --json    Output in JSON format
  --help    Show this help
`);
      break;
  }
}

// Auto-run when executed directly (covers: remnic and legacy engram entrypoints,
// or invoked via wrappers that set REMNIC_CLI_BIN / ENGRAM_CLI_BIN)
const argv1 = process.argv[1] ?? "";
const argv1Base = argv1.replace(/\\/g, "/");
if (
  argv1Base.endsWith("remnic.ts") ||
  argv1Base.endsWith("remnic.js") ||
  argv1Base.endsWith("engram.ts") ||
  argv1Base.endsWith("engram.js") ||
  argv1Base.endsWith("/remnic") ||
  argv1Base.endsWith("/engram") ||
  argv1Base.includes("packages/remnic-cli/src/index.") ||
  process.env.REMNIC_CLI_BIN === "1" ||
  process.env.ENGRAM_CLI_BIN === "1"
) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
