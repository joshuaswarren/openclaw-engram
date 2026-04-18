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
 *   bench list        List published benchmark packs
 *   bench run         Run published benchmark packs
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
import { fileURLToPath, pathToFileURL } from "node:url";
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
  listVersions,
  getVersion,
  revertToVersion,
  diffVersions,
  readManifest,
  writeManifest,
  createBackend,
  runBinaryLifecyclePipeline,
  DEFAULT_SCAN_PATTERNS,
  DEFAULT_MAX_BINARY_SIZE_BYTES,
  DEFAULT_GRACE_PERIOD_DAYS,
  publisherForConnector,
  hostIdForConnector,
  registerPublisher,
  PUBLISHERS,
  CodexMemoryExtensionPublisher,
  ClaudeCodeMemoryExtensionPublisher,
  HermesMemoryExtensionPublisher,
  DEFAULT_TAXONOMY,
  resolveCategory,
  generateResolverDocument,
  loadTaxonomy,
  saveTaxonomy,
  validateSlug,
  validateTaxonomy,
  getTaxonomyFilePath,
  generateMarketplaceManifest,
  checkMarketplaceManifest,
  writeMarketplaceManifest,
  installFromMarketplace,
  type MarketplaceInstallType,
  EnrichmentProviderRegistry,
  WebSearchProvider,
  runEnrichmentPipeline,
  appendAuditEntry,
  readAuditLog,
  defaultEnrichmentPipelineConfig,
  discoverMemoryExtensions,
  resolveExtensionsRoot,
  coerceInstallExtension,
} from "@remnic/core";
import type {
  BinaryLifecycleConfig,
} from "@remnic/core";
import type { MemoryCategory, Taxonomy, TaxonomyCategory } from "@remnic/core";
import {
  runBenchSuite,
  runExplain,
  loadBaseline,
  saveBaseline,
  checkRegression,
  type BenchConfig,
} from "@remnic/bench";
import { firstSuccessfulCandidate, firstSuccessfulResult } from "./service-candidates.js";
export { hasFlag, resolveFlag, stripResolveFlags, TAXONOMY_RESOLVE_BOOLEAN_FLAGS } from "./cli-args.js";
import { hasFlag, resolveFlag, stripResolveFlags, TAXONOMY_RESOLVE_BOOLEAN_FLAGS } from "./cli-args.js";
import { parseConnectorConfig, stripConfigArgv } from "./parse-connector-config.js";

export { parseConnectorConfig, stripConfigArgv };

// ── Host-specific publisher registrations ───────────────────────────────────
// Publisher classes live in @remnic/core, but wiring them into the registry
// belongs in the host adapter layer (CLAUDE.md gotcha #31).
registerPublisher("codex", () => new CodexMemoryExtensionPublisher());
registerPublisher("claude-code", () => new ClaudeCodeMemoryExtensionPublisher());
registerPublisher("hermes", () => new HermesMemoryExtensionPublisher());

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
  | "bench"
  | "benchmark"
  | "briefing"
  | "versions"
  | "binary"
  | "taxonomy"
  | "enrich"
  | "openclaw"
  | "extensions";

type DaemonAction = "start" | "stop" | "restart" | "install" | "uninstall" | "status";
type TokenAction = "generate" | "list" | "revoke";
type ReviewAction = "approve" | "dismiss" | "flag";
export type BenchAction = "help" | "list" | "run" | "check" | "report";

export interface BenchCatalogEntry {
  id: string;
  title: string;
  category: "agentic" | "retrieval" | "conversational";
  summary: string;
}

export interface ParsedBenchArgs {
  action: BenchAction;
  benchmarks: string[];
  quick: boolean;
  all: boolean;
  json: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

function readCompatEnv(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~";
}

/** Expand a leading `~`, `~/`, `$HOME/`, or `${HOME}/` to the real home directory. */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return resolveHomeDir() + p.slice(1);
  }
  const home = resolveHomeDir();
  // Handle literal $HOME or ${HOME} prefixes common in launchd/systemd env files
  // where shell variable expansion does not occur.
  if (p === "$HOME" || p.startsWith("$HOME/") || p.startsWith("$HOME\\")) {
    return home + p.slice(5);
  }
  if (p === "${HOME}" || p.startsWith("${HOME}/") || p.startsWith("${HOME}\\")) {
    return home + p.slice(7);
  }
  return p;
}

const PID_DIR = path.join(resolveHomeDir(), ".remnic");
const LEGACY_PID_DIR = path.join(resolveHomeDir(), ".engram");
const PID_FILE = path.join(PID_DIR, "server.pid");
const LEGACY_PID_FILE = path.join(LEGACY_PID_DIR, "server.pid");
const LOG_FILE = path.join(PID_DIR, "server.log");
const LEGACY_LOG_FILE = path.join(LEGACY_PID_DIR, "server.log");
const CLI_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_REPO_ROOT = path.resolve(CLI_MODULE_DIR, "../../..");
const EVAL_RUNNER_PATH = path.join(CLI_REPO_ROOT, "evals", "run.ts");

export const BENCHMARK_CATALOG: BenchCatalogEntry[] = [
  {
    id: "ama-bench",
    title: "AMA-Bench",
    category: "agentic",
    summary: "Agent Memory Abilities benchmark for long-horizon agent workflows.",
  },
  {
    id: "memory-arena",
    title: "Memory Arena",
    category: "agentic",
    summary: "Interdependent multi-session tasks that stress operational recall.",
  },
  {
    id: "amemgym",
    title: "AMemGym",
    category: "agentic",
    summary: "Interactive personalization benchmark for agent memory adaptation.",
  },
  {
    id: "longmemeval",
    title: "LongMemEval",
    category: "retrieval",
    summary: "Long-term memory retrieval benchmark across core memory abilities.",
  },
  {
    id: "locomo",
    title: "LoCoMo",
    category: "conversational",
    summary: "Long-conversation memory benchmark for persistent dialogue context.",
  },
];

const BENCHMARK_IDS = new Set(BENCHMARK_CATALOG.map((entry) => entry.id));

export function getBenchUsageText(): string {
  return `Usage: remnic bench <list|run> [options] [benchmark...]
       remnic benchmark <list|run|check|report> [options] [benchmark...]

Commands:
  list                     List published benchmark packs
  run [benchmark...]       Run one or more benchmark packs
  check                    Legacy latency regression gate (compatibility)
  report                   Legacy latency report generator (compatibility)

Options:
  --quick                  Run a lightweight quick pass (maps to --lightweight --limit 1)
  --all                    Run every published benchmark
  --json                   Output JSON for \`list\`

Examples:
  remnic bench list
  remnic bench run --quick longmemeval
  remnic benchmark run --quick longmemeval`;
}

export function parseBenchArgs(argv: string[]): ParsedBenchArgs {
  const [first, ...rest] = argv;
  const action: BenchAction =
    first === "list" || first === "run" || first === "check" || first === "report"
      ? first
      : first === undefined || first === "--help" || first === "-h"
        ? "help"
        : "run";
  const args = action === "run" && action !== first ? argv : rest;
  const benchmarks = args.filter((arg) => !arg.startsWith("-"));

  return {
    action,
    benchmarks,
    quick: args.includes("--quick"),
    all: args.includes("--all"),
    json: args.includes("--json"),
  };
}

export function buildBenchRunnerArgs(
  parsed: ParsedBenchArgs,
  benchmarkId: string,
): string[] {
  const args = [EVAL_RUNNER_PATH, "--benchmark", benchmarkId];
  if (parsed.quick) {
    args.push("--lightweight", "--limit", "1");
  }
  return args;
}

function coerceBenchCategory(
  benchmarkId: string,
  category: string | undefined,
): BenchCatalogEntry["category"] {
  if (
    category === "agentic" ||
    category === "retrieval" ||
    category === "conversational"
  ) {
    return category;
  }

  return (
    BENCHMARK_CATALOG.find((entry) => entry.id === benchmarkId)?.category ??
    "retrieval"
  );
}

async function listBenchmarksFromPackage(): Promise<BenchCatalogEntry[] | undefined> {
  try {
    const benchModule = await import("@remnic/bench") as {
      listBenchmarks?: () => Promise<Array<{
        id: string;
        title?: string;
        tier?: string;
        meta?: { description?: string; category?: string };
      }>> | Array<{
        id: string;
        title?: string;
        tier?: string;
        meta?: { description?: string; category?: string };
      }>;
    };
    if (!benchModule.listBenchmarks) return undefined;
    const result = await benchModule.listBenchmarks();
    if (!Array.isArray(result)) {
      return undefined;
    }
    return result.map((entry) => ({
      id: entry.id,
      title: entry.title ?? entry.id,
      category: coerceBenchCategory(entry.id, entry.meta?.category),
      summary: entry.meta?.description ?? "",
    }));
  } catch {
    return undefined;
  }
}

async function runBenchViaFallback(
  parsed: ParsedBenchArgs,
  benchmarkId: string,
): Promise<void> {
  if (!fs.existsSync(EVAL_RUNNER_PATH)) {
    console.error(
      "Benchmark runner not found. Expected eval runner at evals/run.ts or a phase-1 @remnic/bench runtime export.",
    );
    process.exit(1);
  }

  const tsxCandidates = [
    path.join(CLI_REPO_ROOT, "node_modules", ".bin", "tsx"),
    path.join(CLI_REPO_ROOT, "packages", "remnic-cli", "node_modules", ".bin", "tsx"),
  ];
  const tsxCmd = tsxCandidates.find((candidate) => fs.existsSync(candidate)) ?? "tsx";
  childProcess.execFileSync(tsxCmd, buildBenchRunnerArgs(parsed, benchmarkId), {
    stdio: "inherit",
    env: process.env,
  });
}

function resolveBenchOutputDir(): string {
  return path.join(resolveHomeDir(), ".remnic", "bench", "results");
}

function resolveBenchDatasetDir(
  benchmarkId: string,
  quick: boolean,
): string | undefined {
  if (quick) {
    return undefined;
  }

  return path.join(CLI_REPO_ROOT, "evals", "datasets", benchmarkId);
}

function printBenchPackageSummary(
  result: {
    meta: { benchmark: string; mode: string };
    results: { tasks: Array<unknown>; aggregates: Record<string, { mean: number }> };
    cost: { meanQueryLatencyMs: number };
  },
  outputPath: string,
): void {
  console.log(`Benchmark: ${result.meta.benchmark}`);
  console.log(`Mode: ${result.meta.mode}`);
  console.log(`Tasks: ${result.results.tasks.length}`);
  console.log(`Mean query latency: ${result.cost.meanQueryLatencyMs.toFixed(1)}ms`);
  for (const [metric, aggregate] of Object.entries(result.results.aggregates).sort()) {
    console.log(`  ${metric.padEnd(20)} ${aggregate.mean.toFixed(4)}`);
  }
  console.log(`Results saved: ${outputPath}`);
}

async function runBenchViaPackage(
  parsed: ParsedBenchArgs,
  benchmarkId: string,
): Promise<boolean> {
  const benchModule = await import("@remnic/bench") as unknown as {
    getBenchmark?: (id: string) => {
      runnerAvailable?: boolean;
    } | undefined;
    runBenchmark?: (id: string, options: {
      mode?: "full" | "quick";
      datasetDir?: string;
      outputDir?: string;
      limit?: number;
      adapterMode?: string;
      system: {
        destroy(): Promise<void>;
      };
    }) => Promise<{
      meta: { benchmark: string; mode: string };
      results: { tasks: Array<unknown>; aggregates: Record<string, { mean: number }> };
      cost: { meanQueryLatencyMs: number };
    }>;
    writeBenchmarkResult?: (result: unknown, outputDir: string) => Promise<string>;
    createLightweightAdapter?: () => Promise<{ destroy(): Promise<void> }>;
    createRemnicAdapter?: () => Promise<{ destroy(): Promise<void> }>;
  };

  const definition = benchModule.getBenchmark?.(benchmarkId);
  if (!definition?.runnerAvailable || !benchModule.runBenchmark || !benchModule.writeBenchmarkResult) {
    return false;
  }

  const createAdapter = parsed.quick
    ? benchModule.createLightweightAdapter
    : benchModule.createRemnicAdapter;

  if (!createAdapter) {
    return false;
  }

  const system = await createAdapter();

  try {
    const outputDir = resolveBenchOutputDir();
    const datasetDir = resolveBenchDatasetDir(benchmarkId, parsed.quick);
    const result = await benchModule.runBenchmark(benchmarkId, {
      mode: parsed.quick ? "quick" : "full",
      datasetDir,
      outputDir,
      limit: parsed.quick ? 1 : undefined,
      adapterMode: parsed.quick ? "lightweight" : "direct",
      system,
    });
    const writtenPath = await benchModule.writeBenchmarkResult(result, outputDir);
    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printBenchPackageSummary(result, writtenPath);
    }
    return true;
  } finally {
    await system.destroy();
  }
}

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
  if (cliPath) return path.resolve(expandTilde(cliPath));

  // Env-var paths are always honoured regardless of whether the file exists yet
  // (a first-time install needs to create the file at the configured location).
  // Only fall through to existence-probing when no env var is set.
  // Apply expandTilde so values like ~/openclaw.json work correctly.
  const envPath =
    process.env.OPENCLAW_CONFIG_PATH || process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  if (envPath) return path.resolve(expandTilde(envPath));

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

// ── Page-level versioning (issue #371) ─────────────────────────────────────

async function cmdVersions(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);

  if (!config.versioningEnabled) {
    console.error("Page versioning is disabled (versioningEnabled = false).");
    process.exit(1);
  }

  const versioningConfig = {
    enabled: config.versioningEnabled,
    maxVersionsPerPage: config.versioningMaxPerPage,
    sidecarDir: config.versioningSidecarDir,
  };

  const memDir = resolveMemoryDir();

  const action = rest[0] ?? "help";
  const json = rest.includes("--json");

  switch (action) {
    case "list": {
      const pagePath = rest[1];
      if (!pagePath) {
        console.error("Usage: remnic versions list <page-path>");
        process.exit(1);
      }
      const absPath = path.resolve(pagePath);
      const history = await listVersions(absPath, versioningConfig, memDir);
      if (json) {
        console.log(JSON.stringify(history, null, 2));
      } else {
        if (history.versions.length === 0) {
          console.log(`No versions found for ${pagePath}`);
        } else {
          console.log(`Versions for ${pagePath} (current: v${history.currentVersion}):\n`);
          for (const v of history.versions) {
            const note = v.note ? ` — ${v.note}` : "";
            console.log(`  v${v.versionId}  ${v.timestamp}  ${v.trigger}  ${v.sizeBytes} bytes${note}`);
          }
        }
      }
      break;
    }

    case "show": {
      const pagePath = rest[1];
      const versionId = rest[2];
      if (!pagePath || !versionId) {
        console.error("Usage: remnic versions show <page-path> <version-id>");
        process.exit(1);
      }
      const absPath = path.resolve(pagePath);
      try {
        const content = await getVersion(absPath, versionId, versioningConfig, memDir);
        console.log(content);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    case "diff": {
      const pagePath = rest[1];
      const v1 = rest[2];
      const v2 = rest[3];
      if (!pagePath || !v1 || !v2) {
        console.error("Usage: remnic versions diff <page-path> <v1> <v2>");
        process.exit(1);
      }
      const absPath = path.resolve(pagePath);
      try {
        const diffOutput = await diffVersions(absPath, v1, v2, versioningConfig, memDir);
        console.log(diffOutput);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    case "revert": {
      const pagePath = rest[1];
      const versionId = rest[2];
      if (!pagePath || !versionId) {
        console.error("Usage: remnic versions revert <page-path> <version-id>");
        process.exit(1);
      }
      const absPath = path.resolve(pagePath);
      try {
        const version = await revertToVersion(absPath, versionId, versioningConfig, undefined, memDir);
        if (json) {
          console.log(JSON.stringify(version, null, 2));
        } else {
          console.log(`Reverted ${pagePath} to version ${versionId}.`);
          console.log(`Created snapshot v${version.versionId} of previous content.`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }

    default:
      console.log(`
remnic versions — Page-level versioning

Usage:
  remnic versions list <page-path>              List all versions of a page
  remnic versions show <page-path> <id>         Print content of a specific version
  remnic versions diff <page-path> <v1> <v2>    Show diff between two versions
  remnic versions revert <page-path> <id>       Revert page to a specific version

Options:
  --json    Output in JSON format
`);
      break;
  }
}

// ---------------------------------------------------------------------------
// enrich command (issue #365)
// ---------------------------------------------------------------------------

async function cmdEnrich(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);

  const subcommand = rest[0];

  // Sub-commands that don't need an entity name
  if (subcommand === "audit") {
    const memoryDir = expandTilde(config.memoryDir);
    const auditDir = path.join(memoryDir, "enrichment");
    const sinceFlag = resolveFlag(rest.slice(1), "--since");
    const entries = await readAuditLog(auditDir, sinceFlag ?? undefined);
    if (entries.length === 0) {
      console.log("No enrichment audit entries found.");
      return;
    }
    for (const entry of entries) {
      const status = entry.accepted ? "ACCEPTED" : "REJECTED";
      const url = entry.sourceUrl ? ` (${entry.sourceUrl})` : "";
      console.log(
        `[${entry.timestamp}] ${status} ${entry.entityName} via ${entry.provider}: ${entry.candidateText}${url}`,
      );
    }
    return;
  }

  if (subcommand === "providers") {
    const pipelineConfig = defaultEnrichmentPipelineConfig();
    pipelineConfig.enabled = config.enrichmentEnabled;
    pipelineConfig.maxCandidatesPerEntity = config.enrichmentMaxCandidatesPerEntity;
    pipelineConfig.autoEnrichOnCreate = config.enrichmentAutoOnCreate;
    // Populate the provider config list so listEnabled() can match registered providers
    pipelineConfig.providers = [
      { id: "web-search", enabled: true, costTier: "cheap" },
    ];

    // Wire the real search backend so isAvailable() reflects actual state
    const orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const searchBackend = orchestrator.qmd;
    const searchFn = searchBackend.isAvailable()
      ? async (query: string): Promise<string[]> => {
          const results = await searchBackend.search(query, undefined, 10);
          return results.map((r) => r.snippet);
        }
      : undefined;

    const registry = new EnrichmentProviderRegistry();
    registry.register(new WebSearchProvider({ searchFn }));

    const allEnabled = registry.listEnabled(pipelineConfig);
    console.log(`Pipeline enabled: ${pipelineConfig.enabled}`);
    console.log(`Auto-enrich on create: ${pipelineConfig.autoEnrichOnCreate}`);
    console.log(`Max candidates per entity: ${pipelineConfig.maxCandidatesPerEntity}`);
    console.log(`\nRegistered providers:`);

    const webSearch = registry.get("web-search");
    if (webSearch) {
      const available = await webSearch.isAvailable();
      console.log(`  - web-search (${webSearch.costTier}) — ${available ? "available" : "unavailable (no searchFn configured)"}`);
    }
    if (allEnabled.length === 0) {
      console.log("\n  No providers are currently enabled in config.");
    }
    return;
  }

  if (!config.enrichmentEnabled) {
    console.error("Enrichment pipeline is disabled (enrichmentEnabled = false).");
    process.exit(1);
  }

  const dryRun = rest.includes("--dry-run");
  const all = rest.includes("--all");

  if (!all && (!subcommand || subcommand.startsWith("--"))) {
    console.error("Usage: remnic enrich <entity-name> | --all | --dry-run | audit | providers");
    process.exit(1);
  }

  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();
  const storage = await orchestrator.getStorage(config.defaultNamespace);

  // Gather entities to enrich
  const entityFiles = await storage.readAllEntityFiles();
  let targets = entityFiles;
  if (!all && subcommand && !subcommand.startsWith("--")) {
    const match = entityFiles.find(
      (e) => e.name.toLowerCase() === subcommand.toLowerCase(),
    );
    if (!match) {
      console.error(`Entity not found: ${subcommand}`);
      process.exit(1);
    }
    targets = [match];
  }

  if (targets.length === 0) {
    console.log("No entities to enrich.");
    return;
  }

  // Build pipeline config and registry
  const pipelineConfig = defaultEnrichmentPipelineConfig();
  pipelineConfig.enabled = true;
  pipelineConfig.maxCandidatesPerEntity = config.enrichmentMaxCandidatesPerEntity;
  pipelineConfig.providers = [
    { id: "web-search", enabled: true, costTier: "cheap" },
  ];
  pipelineConfig.importanceThresholds = {
    critical: ["web-search"],
    high: ["web-search"],
    normal: ["web-search"],
    low: [],
  };

  // Wire the real search backend into the web-search provider (issue #425 P1)
  const searchBackend = orchestrator.qmd;
  const searchFn = searchBackend.isAvailable()
    ? async (query: string): Promise<string[]> => {
        const results = await searchBackend.search(query, undefined, 10);
        return results.map((r) => r.snippet);
      }
    : undefined;

  const registry = new EnrichmentProviderRegistry();
  registry.register(new WebSearchProvider({ searchFn }));

  // Map entity files to enrichment inputs
  const inputs = targets.map((ef) => ({
    name: ef.name,
    type: ef.type,
    knownFacts: ef.facts,
    importanceLevel: "normal" as const,
  }));

  if (dryRun) {
    console.log(`Dry run: would enrich ${inputs.length} entity(ies):`);
    for (const input of inputs) {
      const providers = registry.getForImportance(input.importanceLevel, pipelineConfig);
      console.log(`  - ${input.name} (${input.type}) — ${providers.length} provider(s)`);
    }
    return;
  }

  console.log(`Enriching ${inputs.length} entity(ies)...`);
  const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
  const results = await runEnrichmentPipeline(inputs, registry, pipelineConfig, noopLog);

  if (results.length === 0) {
    console.log("No enrichment results (no providers matched).");
    return;
  }

  // Persist accepted candidates to storage (issue #425 P1).
  // Gotcha #43: direct-write paths must trigger reindex.
  const memoryDir = expandTilde(config.memoryDir);
  const auditDir = path.join(memoryDir, "enrichment");
  let totalPersisted = 0;
  for (const result of results) {
    for (const candidate of result.acceptedCandidates) {
      // Split persistence and audit into separate try-catch blocks so an
      // audit-write failure after a successful memory write is logged as a
      // warning instead of masking the successful persist (PR #425 review).
      let persisted = false;
      try {
        await storage.writeMemory(candidate.category, candidate.text, {
          confidence: candidate.confidence,
          tags: [...(candidate.tags ?? []), "enrichment", candidate.source],
          entityRef: result.entityName,
          source: `enrichment:${candidate.source}`,
        });
        persisted = true;
        totalPersisted++;
      } catch (err) {
        console.error(
          `  Failed to persist candidate for ${result.entityName}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Audit rejected-due-to-error candidate
        try {
          await appendAuditEntry(auditDir, {
            timestamp: new Date().toISOString(),
            entityName: result.entityName,
            provider: result.provider,
            candidateText: candidate.text,
            sourceUrl: candidate.sourceUrl,
            accepted: false,
            reason: `persist failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        } catch {
          // Audit write failure is non-fatal
        }
      }

      // Write audit entry for accepted candidate — separate from persist
      // so audit failures don't mask a successful memory write.
      if (persisted) {
        try {
          await appendAuditEntry(auditDir, {
            timestamp: new Date().toISOString(),
            entityName: result.entityName,
            provider: result.provider,
            candidateText: candidate.text,
            sourceUrl: candidate.sourceUrl,
            accepted: true,
          });
        } catch (auditErr) {
          console.warn(
            `  Warning: audit write failed for ${result.entityName} (memory was persisted): ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
          );
        }
      }
    }
  }

  // Trigger reindex after direct writes (gotcha #43)
  if (totalPersisted > 0 && searchBackend.isAvailable()) {
    try {
      await searchBackend.update();
    } catch {
      // Reindex failure is non-fatal for CLI
    }
  }

  for (const result of results) {
    console.log(
      `  ${result.entityName} via ${result.provider}: ${result.candidatesAccepted} accepted, ${result.candidatesRejected} rejected (${result.elapsed}ms)`,
    );
  }
  if (totalPersisted > 0) {
    console.log(`\n  ${totalPersisted} candidate(s) persisted to memory store.`);
  }
}

async function cmdExtensions(action: string, rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);

  const root = resolveExtensionsRoot(config);
  const noopLog = { warn: () => {}, debug: () => {} };
  const warnLog = {
    warn: (msg: string) => console.warn(msg),
    debug: () => {},
  };

  switch (action) {
    case "list": {
      const extensions = await discoverMemoryExtensions(root, noopLog);
      if (extensions.length === 0) {
        console.log("No memory extensions found.");
        console.log(`  Scanned: ${root}`);
        return;
      }
      console.log(`Memory extensions (${extensions.length}):`);
      for (const ext of extensions) {
        const schemaInfo = ext.schema?.version ? ` v${ext.schema.version}` : "";
        const types = ext.schema?.memoryTypes?.join(", ") ?? "any";
        console.log(`  ${ext.name}${schemaInfo}  (types: ${types})`);
      }
      console.log(`\nRoot: ${root}`);
      break;
    }

    case "show": {
      const name = rest[0];
      if (!name) {
        console.error("Usage: remnic extensions show <name>");
        process.exitCode = 1;
        return;
      }
      const extensions = await discoverMemoryExtensions(root, noopLog);
      const ext = extensions.find((e) => e.name === name);
      if (!ext) {
        console.error(`Extension "${name}" not found in ${root}`);
        process.exitCode = 1;
        return;
      }
      console.log(ext.instructions);
      break;
    }

    case "validate": {
      const extensions = await discoverMemoryExtensions(root, warnLog);
      // Re-scan to detect skipped entries
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(root);
      } catch {
        console.log(`Extensions root does not exist: ${root}`);
        process.exitCode = 0;
        return;
      }
      const validNames = new Set(extensions.map((e) => e.name));
      let errors = 0;
      for (const entry of entries) {
        const entryPath = path.join(root, entry);
        try {
          if (!fs.statSync(entryPath).isDirectory()) continue;
        } catch {
          continue;
        }
        if (!validNames.has(entry)) {
          errors++;
        }
      }
      console.log(`Validated: ${extensions.length} valid, ${errors} skipped`);
      if (errors > 0) {
        process.exitCode = 1;
      }
      break;
    }

    case "reload": {
      // No-op stub reserved for future caching
      console.log("Extension cache reloaded (no-op: caching not yet implemented).");
      break;
    }

    default:
      console.log(`Usage: remnic extensions <list|show|validate|reload>

  list                 List discovered extensions
  show <name>          Print instructions.md content
  validate             Validate all extensions, exit non-zero on errors
  reload               Reserved for future caching (no-op)
`);
      break;
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
    const rawPlugins = openclawConfig.plugins;
    const pluginsIsObject =
      rawPlugins && typeof rawPlugins === "object" && !Array.isArray(rawPlugins);
    if (!pluginsIsObject && rawPlugins !== undefined) {
      checks.push({
        name: "OpenClaw plugins",
        ok: false,
        detail: `plugins is ${typeof rawPlugins}, expected object`,
        remediation: "Run `remnic openclaw install` to recreate the plugins section.",
      });
    }
    const plugins = pluginsIsObject
      ? rawPlugins as Record<string, unknown>
      : {} as Record<string, unknown>;
    const entries =
      plugins.entries &&
      typeof plugins.entries === "object" &&
      !Array.isArray(plugins.entries)
        ? plugins.entries as Record<string, unknown>
        : null;
    const slots =
      plugins.slots &&
      typeof plugins.slots === "object" &&
      !Array.isArray(plugins.slots)
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
      const isValidEntry = (v: unknown): boolean =>
        typeof v === "object" && v !== null && !Array.isArray(v);
      const hasNew = REMNIC_OPENCLAW_PLUGIN_ID in entries && isValidEntry(entries[REMNIC_OPENCLAW_PLUGIN_ID]);
      const hasLegacy = REMNIC_OPENCLAW_LEGACY_PLUGIN_ID in entries && isValidEntry(entries[REMNIC_OPENCLAW_LEGACY_PLUGIN_ID]);
      const keyExistsButMalformed =
        (REMNIC_OPENCLAW_PLUGIN_ID in entries && !hasNew) ||
        (REMNIC_OPENCLAW_LEGACY_PLUGIN_ID in entries && !hasLegacy);
      checks.push({
        name: "OpenClaw plugin entry",
        ok: hasNew,
        warn: (!hasNew && hasLegacy) || keyExistsButMalformed,
        detail: hasNew
          ? `${REMNIC_OPENCLAW_PLUGIN_ID} entry found`
          : hasLegacy
          ? `only legacy ${REMNIC_OPENCLAW_LEGACY_PLUGIN_ID} entry found (upgrade recommended)`
          : keyExistsButMalformed
          ? "entry key exists but value is not a valid object"
          : "no Remnic entry found",
        remediation: keyExistsButMalformed
          ? "Run `remnic openclaw install` to recreate the Remnic plugin entry with correct structure."
          : !hasNew && hasLegacy
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
        ok: slotMatchesEntry,
        warn: slotMatchesEntry && !slotIsPreferred,
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

      // Check memoryDir for the slot-selected (active) entry — the slot determines
      // which plugin OpenClaw loads, so checking the wrong entry misdiagnoses the
      // configuration. Fall back to the canonical id when the slot is unset or
      // points to a non-OpenClaw entry.
      const activeSlotEntry = slotValue ? entries[slotValue] : undefined;
      const entryToCheck = (
        activeSlotEntry ??
        entries[REMNIC_OPENCLAW_PLUGIN_ID] ??
        entries[REMNIC_OPENCLAW_LEGACY_PLUGIN_ID]
      ) as Record<string, unknown> | undefined;
      const entryConfig = entryToCheck?.config && typeof entryToCheck.config === "object"
        ? entryToCheck.config as Record<string, unknown>
        : null;
      const rawMemoryDir = entryConfig?.memoryDir;
      const configuredMemoryDir = typeof rawMemoryDir === "string" ? rawMemoryDir : undefined;
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
    const icon = check.ok
      ? check.warn ? "⚠" : "✓"
      : check.warn ? "⚠" : "✗";
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
    if ((!check.ok || check.warn) && check.remediation) {
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
    const connectorConfig = parseConnectorConfig(rest);
    const result = installConnector({
      connectorId,
      config: connectorConfig,
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

    // Publish memory extension if the connector has a publisher and the
    // install was successful (not error/already_installed/config_required).
    if (result.status === "installed") {
      const pub = publisherForConnector(connectorId);
      if (pub) {
        try {
          const available = await pub.isHostAvailable();
          if (available) {
            const memoryDir = resolveMemoryDir();
            // Finding 2 (PR #423): pass the connector's namespace into
            // the publish context so publishers use the actual namespace
            // instead of falling back to "default".
            const connectorNamespace =
              typeof connectorConfig?.namespace === "string" && connectorConfig.namespace.length > 0
                ? connectorConfig.namespace
                : undefined;
            const pubResult = await pub.publish({
              config: { memoryDir, namespace: connectorNamespace },
              skillsRoot: path.join(memoryDir, "skills"),
              log: { info: console.log, warn: console.warn, error: console.error },
            });
            if (pubResult.filesWritten.length > 0) {
              console.log(`  Published memory extension to ${pubResult.extensionRoot}`);
            }
          }
        } catch (err) {
          // Per CLAUDE.md #13: external service calls must not crash the
          // primary install flow. Surface a user-facing note instead.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`  Warning: memory extension publish failed: ${msg}`);
        }
      }
    }
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

    // Append memory extension publisher health only for the requested
    // connector's host, not all registered publishers. This prevents
    // unrelated hosts from polluting the health status.
    const publisherChecks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const targetHostId = hostIdForConnector(connectorId);
    const factory = PUBLISHERS[targetHostId];

    // Finding 1 (PR #423): skip the extension directory existence check when
    // the user explicitly opted out via installExtension=false.
    const connectorInstance = listConnectors().installed.find(
      (c) => c.connectorId === connectorId,
    );
    const savedInstallExt = connectorInstance
      ? coerceInstallExtension(connectorInstance.config.installExtension)
      : undefined;
    const extensionOptedOut = savedInstallExt === false;

    if (factory) {
      if (extensionOptedOut) {
        publisherChecks.push({
          name: `Publisher: ${targetHostId}`,
          ok: true,
          detail: "skipped (installExtension=false)",
        });
      } else {
        try {
          const pub = factory();
          const available = await pub.isHostAvailable();
          const extRoot = available ? await pub.resolveExtensionRoot() : "(host not installed)";
          const extensionExists = available && extRoot
            ? fs.existsSync(extRoot)
            : false;
          publisherChecks.push({
            name: `Publisher: ${targetHostId}`,
            ok: !available || extensionExists,
            detail: !available
              ? "host not installed (skip)"
              : extensionExists
              ? `extension at ${extRoot}`
              : `extension missing at ${extRoot} — run \`remnic connectors install ${connectorId}\``,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          publisherChecks.push({
            name: `Publisher: ${targetHostId}`,
            ok: false,
            detail: `error: ${msg}`,
          });
        }
      }
    }

    const allChecks = [...result.checks, ...publisherChecks];
    const healthy = allChecks.every((c) => c.ok);

    if (json) {
      console.log(JSON.stringify({ ...result, checks: allChecks, healthy }, null, 2));
    } else {
      for (const check of allChecks) {
        const icon = check.ok ? "✓" : "✗";
        console.log(`  ${icon} ${check.name}: ${check.detail}`);
      }
      console.log(healthy ? "\nConnector healthy" : "\nConnector has issues");
    }
  } else if (action === "marketplace") {
    const subAction = nonFlagArgs[0];
    // Use the original `rest` (not strippedRest) because marketplace uses
    // `--config <path>` for a file path, not `--config key=value` pairs.
    // `stripConfigArgv` would silently remove that flag, breaking config
    // overrides for marketplace subcommands.
    // Strip only the subAction token so downstream positional parsing picks
    // up the real argument (e.g. the install source or validate path).
    let subActionRemoved = false;
    const marketplaceRest = rest.filter((a) => {
      if (!subActionRemoved && a === subAction) {
        subActionRemoved = true;
        return false;
      }
      return true;
    });
    await cmdConnectorsMarketplace(subAction, marketplaceRest, json);
  } else {
    console.log("Usage: remnic connectors <list|install|remove|doctor|marketplace> [id]");
    process.exit(1);
  }
}

// ── Marketplace subcommand (connectors marketplace) ────────��────────────────

async function cmdConnectorsMarketplace(
  subAction: string | undefined,
  rest: string[],
  json: boolean,
): Promise<void> {
  const configPath = resolveConfigPath(resolveFlagStrict(rest, "--config"));
  const rawConfig = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  // Unwrap the plugin-scoped config block (remnic or engram wrapper) so
  // parseConfig receives the correct inner object — same pattern used by
  // other CLI entrypoints (resolveMemoryDir, cmdBriefing, etc.).
  const pluginConfig = rawConfig.remnic ?? rawConfig.engram ?? rawConfig;
  const config = parseConfig(pluginConfig);

  if (subAction === "generate") {
    const outputDir = resolveFlagStrict(rest, "--output") ?? process.cwd();
    const manifest = generateMarketplaceManifest();
    await writeMarketplaceManifest(outputDir, manifest);
    const outPath = path.join(outputDir, "marketplace.json");
    if (json) {
      console.log(JSON.stringify({ status: "generated", path: outPath }, null, 2));
    } else {
      console.log(`Generated marketplace.json at ${outPath}`);
    }
  } else if (subAction === "validate") {
    const targetPath = rest.filter((a) => !a.startsWith("--"))[0]
      ?? path.join(process.cwd(), "marketplace.json");
    const resolved = path.resolve(targetPath);

    if (!fs.existsSync(resolved)) {
      console.error(`File not found: ${resolved}`);
      process.exit(1);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    } catch {
      console.error(`Invalid JSON in ${resolved}`);
      process.exit(1);
    }

    const validation = checkMarketplaceManifest(parsed);
    if (json) {
      console.log(JSON.stringify(validation, null, 2));
    }
    if (validation.valid) {
      if (!json) console.log(`Valid marketplace manifest: ${resolved}`);
      // exit 0
    } else {
      if (!json) {
        console.error(`Invalid marketplace manifest: ${resolved}`);
        for (const err of validation.errors) {
          console.error(`  - ${err}`);
        }
      }
      process.exit(1);
    }
  } else if (subAction === "install") {
    const source = rest.filter((a) => !a.startsWith("--"))[0];
    if (!source) {
      console.error("Usage: remnic connectors marketplace install <source> [--type github|git|local|url]");
      process.exit(1);
    }

    // CLAUDE.md gotcha #14 & #51: reject --type without a value instead of
    // silently defaulting to "github".
    const validTypes = new Set(["github", "git", "local", "url"]);
    const hasTypeFlag = rest.includes("--type");
    const typeFlag = resolveFlagStrict(rest, "--type") ?? (hasTypeFlag ? undefined : "github");
    if (typeFlag === undefined) {
      console.error(`--type requires a value. Must be one of: ${[...validTypes].join(", ")}`);
      process.exit(1);
    }
    if (!validTypes.has(typeFlag)) {
      console.error(`Invalid --type: "${typeFlag}". Must be one of: ${[...validTypes].join(", ")}`);
      process.exit(1);
    }

    const result = await installFromMarketplace(
      source,
      typeFlag as MarketplaceInstallType,
      config,
    );

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
      if (result.pluginsFound.length > 0) {
        console.log(`  Plugins: ${result.pluginsFound.join(", ")}`);
      }
    }

    if (!result.ok) process.exit(1);
  } else {
    console.log(`Usage: remnic connectors marketplace <generate|validate|install> [args]

  generate [--output <dir>]            Generate marketplace.json
  validate [path]                      Validate a marketplace.json file
  install <source> [--type <type>]     Install from marketplace source
                                       Types: github, git, local, url (default: github)`);
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

// ── Benchmark commands ─────────────────────────────────────────────────────────

async function cmdLegacyBenchmark(action: string, rest: string[], json: boolean): Promise<void> {
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

async function cmdBench(rest: string[]): Promise<void> {
  const parsed = parseBenchArgs(rest);

  if (parsed.action === "help") {
    console.log(getBenchUsageText());
    return;
  }

  if (parsed.action === "check" || parsed.action === "report") {
    await cmdLegacyBenchmark(parsed.action, rest.slice(1), parsed.json);
    return;
  }

  if (parsed.action === "list") {
    const catalog = await listBenchmarksFromPackage() ?? BENCHMARK_CATALOG;
    if (parsed.json) {
      console.log(JSON.stringify(catalog, null, 2));
      return;
    }

    console.log("Published benchmarks:");
    for (const entry of catalog) {
      console.log(`  ${entry.id.padEnd(14)} ${entry.category.padEnd(14)} ${entry.summary}`);
    }
    return;
  }

  const selectedBenchmarks = parsed.all ? BENCHMARK_CATALOG.map((entry) => entry.id) : parsed.benchmarks;
  if (selectedBenchmarks.length === 0) {
    console.error("ERROR: specify benchmark name(s) or --all. Use 'remnic bench list' to see available.");
    process.exit(1);
  }

  const unknown = selectedBenchmarks.filter((benchmarkId) => !BENCHMARK_IDS.has(benchmarkId));
  if (unknown.length > 0) {
    console.error(`ERROR: unknown benchmark(s): ${unknown.join(", ")}. Use 'remnic bench list' to see available.`);
    process.exit(1);
  }

  for (const benchmarkId of selectedBenchmarks) {
    const handledByPackage = await runBenchViaPackage(parsed, benchmarkId);
    if (!handledByPackage) {
      await runBenchViaFallback(parsed, benchmarkId);
    }
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

async function daemonStatus(): Promise<void> {
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

  // Memory extensions status (#382)
  try {
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    const remnicCfg = raw.remnic ?? raw.engram ?? raw;
    const config = parseConfig(remnicCfg);
    const extRoot = resolveExtensionsRoot(config);
    const noopLog = { warn: () => {}, debug: () => {} };
    const exts = await discoverMemoryExtensions(extRoot, noopLog);
    if (exts.length > 0) {
      const names = exts.map((e) => e.name).join(", ");
      console.log(`  Memory extensions: ${exts.length} active (${names})`);
    } else {
      console.log(`  Memory extensions: none`);
    }
  } catch {
    console.log(`  Memory extensions: unknown (config error)`);
  }
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
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("close", onEnd);
      process.stdin.pause();
    };
    const onEnd = () => {
      cleanup();
      resolve(defaultYes);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        cleanup();
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
    process.stdin.on("end", onEnd);
    process.stdin.on("close", onEnd);
  });
}

// ── Binary lifecycle CLI ─────────────────────────────────────────────────────

async function cmdBinary(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);
  const memoryDir = resolveMemoryDir();

  // Build the BinaryLifecycleConfig from PluginConfig values.
  const blConfig: BinaryLifecycleConfig = {
    enabled: config.binaryLifecycleEnabled,
    gracePeriodDays: config.binaryLifecycleGracePeriodDays,
    maxBinarySizeBytes: DEFAULT_MAX_BINARY_SIZE_BYTES,
    scanPatterns: DEFAULT_SCAN_PATTERNS,
    backend: {
      type: config.binaryLifecycleBackendType,
      basePath: config.binaryLifecycleBackendPath
        ? expandTilde(config.binaryLifecycleBackendPath)
        : undefined,
    },
  };

  const action = rest[0] ?? "help";

  switch (action) {
    case "scan": {
      const manifest = await readManifest(memoryDir);
      // Inline import to avoid pulling scanner into every CLI load
      const { scanForBinaries } = await import("@remnic/core");
      const found = await scanForBinaries(memoryDir, blConfig, manifest);
      if (found.length === 0) {
        console.log("No untracked binary files found.");
      } else {
        console.log(`Found ${found.length} untracked binary file(s):`);
        for (const p of found) {
          console.log(`  ${p}`);
        }
      }
      break;
    }

    case "status": {
      const manifest = await readManifest(memoryDir);
      const counts = {
        total: manifest.assets.length,
        pending: manifest.assets.filter((a) => a.status === "pending").length,
        mirrored: manifest.assets.filter((a) => a.status === "mirrored").length,
        redirected: manifest.assets.filter((a) => a.status === "redirected").length,
        cleaned: manifest.assets.filter((a) => a.status === "cleaned").length,
        error: manifest.assets.filter((a) => a.status === "error").length,
      };
      const totalBytes = manifest.assets.reduce((sum, a) => sum + a.sizeBytes, 0);
      console.log(`Binary lifecycle manifest (${memoryDir}):`);
      console.log(`  Total assets:  ${counts.total}`);
      console.log(`  Pending:       ${counts.pending}`);
      console.log(`  Mirrored:      ${counts.mirrored}`);
      console.log(`  Redirected:    ${counts.redirected}`);
      console.log(`  Cleaned:       ${counts.cleaned}`);
      console.log(`  Errors:        ${counts.error}`);
      console.log(`  Total size:    ${(totalBytes / 1024).toFixed(1)} KB`);
      if (manifest.lastScanAt) {
        console.log(`  Last scan:     ${manifest.lastScanAt}`);
      }
      break;
    }

    case "run": {
      const dryRun = rest.includes("--dry-run");
      const backend = createBackend(blConfig.backend);
      const log = {
        info: (msg: string) => console.log(msg),
        warn: (msg: string) => console.warn(msg),
        error: (msg: string) => console.error(msg),
      };
      const result = await runBinaryLifecyclePipeline(
        memoryDir,
        blConfig,
        backend,
        log,
        { dryRun },
      );
      console.log(
        `\nPipeline complete${dryRun ? " (dry-run)" : ""}:` +
          ` scanned=${result.scanned}, mirrored=${result.mirrored},` +
          ` redirected=${result.redirected}, cleaned=${result.cleaned}`,
      );
      if (result.errors.length > 0) {
        console.error(`Errors (${result.errors.length}):`);
        for (const e of result.errors) console.error(`  ${e}`);
      }
      break;
    }

    case "clean": {
      const force = rest.includes("--force");
      if (!force) {
        console.error("Use --force to confirm cleanup of local binary copies.");
        process.exit(1);
      }
      const backend = createBackend(blConfig.backend);
      const log = {
        info: (msg: string) => console.log(msg),
        warn: (msg: string) => console.warn(msg),
        error: (msg: string) => console.error(msg),
      };
      const result = await runBinaryLifecyclePipeline(
        memoryDir,
        blConfig,
        backend,
        log,
        { forceClean: true },
      );
      console.log(
        `\nClean complete: cleaned=${result.cleaned}`,
      );
      if (result.errors.length > 0) {
        console.error(`Errors (${result.errors.length}):`);
        for (const e of result.errors) console.error(`  ${e}`);
      }
      break;
    }

    default:
      console.log(`Usage: remnic binary <scan|status|run|clean>

  scan               Scan for untracked binary files
  status             Show binary lifecycle manifest summary
  run [--dry-run]    Run full binary lifecycle pipeline
  clean --force      Force-clean local copies past grace period`);
      break;
  }
}

async function cmdOpenclawInstall(opts: OpenclawInstallOptions): Promise<void> {
  const configPath = resolveOpenclawConfigPath(opts.configPath);
  const fallbackMemoryDir = path.join(resolveHomeDir(), ".openclaw", "workspace", "memory", "local");

  console.log(`OpenClaw config: ${configPath}`);

  const existingConfig = readOpenclawConfig(configPath);

  // Validate that plugins (if present) is a plain object, not a string, array,
  // or other non-object. This prevents the install from silently corrupting a
  // config where plugins has been set to a scalar or array value.
  const rawPlugins = existingConfig.plugins;
  if (rawPlugins !== undefined && (typeof rawPlugins !== "object" || rawPlugins === null || Array.isArray(rawPlugins))) {
    throw new Error(
      `OpenClaw config at ${configPath} has an invalid plugins field (expected an object, got ${Array.isArray(rawPlugins) ? "array" : typeof rawPlugins}). ` +
      `Fix the file manually and re-run.`,
    );
  }
  const plugins = (rawPlugins ?? {}) as Record<string, unknown>;

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

  // Validate plugins.slots shape for the same reason as entries.
  const rawSlots = plugins.slots;
  if (rawSlots !== undefined && (typeof rawSlots !== "object" || rawSlots === null || Array.isArray(rawSlots))) {
    throw new Error(
      `OpenClaw config at ${configPath} has an invalid plugins.slots field (expected an object, got ${Array.isArray(rawSlots) ? "array" : typeof rawSlots}). ` +
      `Fix the file manually and re-run.`,
    );
  }
  const slots = (rawSlots ?? {}) as Record<string, unknown>;

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
  const existingMemoryDir: string | undefined =
    (typeof existingNewEntryConfig.memoryDir === "string" ? existingNewEntryConfig.memoryDir : undefined) ||
    (migrateLegacy && typeof legacyConfigToMerge.memoryDir === "string" ? legacyConfigToMerge.memoryDir : undefined);
  const memoryDir = opts.memoryDir
    ? path.resolve(expandTilde(opts.memoryDir))
    : existingMemoryDir
      ? path.resolve(expandTilde(existingMemoryDir))
      : fallbackMemoryDir;

  console.log(`Memory dir:      ${memoryDir}`);

  // Preserve top-level entry fields (e.g. hooks, enabled) during both
  // reinstalls and migration:
  // - Spread legacy entry first so any legacy policy fields are carried over
  //   when migrating (migrateLegacy=true), but exclude legacy's config since
  //   that is merged separately with the explicit memoryDir taking precedence.
  // - Spread the existing new entry on top so its policy takes precedence.
  // - Finally, overwrite config with the merged result.
  const legacyNonConfigFields: Record<string, unknown> = {};
  if (migrateLegacy && legacyEntry && typeof legacyEntry === "object" && !Array.isArray(legacyEntry)) {
    for (const [k, v] of Object.entries(legacyEntry)) {
      if (k !== "config") legacyNonConfigFields[k] = v;
    }
  }
  // Guard: only spread existingNewEntry if it's a plain object — a scalar/array
  // value would cause character-index keys to be silently merged in.
  const existingNewEntryFields =
    existingNewEntry && typeof existingNewEntry === "object" && !Array.isArray(existingNewEntry)
      ? existingNewEntry
      : {};
  const newEntry: Record<string, unknown> = {
    ...legacyNonConfigFields,
    ...existingNewEntryFields,
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
    // Print a structural summary without dumping full config values —
    // config objects can contain API keys and other credentials.
    const dryRunPlugins = updatedConfig.plugins as Record<string, unknown>;
    const dryRunEntries = dryRunPlugins.entries as Record<string, unknown> | undefined;
    const entrySummary = dryRunEntries
      ? Object.keys(dryRunEntries).map((k) => {
          const cfg = (dryRunEntries[k] as Record<string, unknown>)?.config as Record<string, unknown> | undefined;
          return `  ${k}: { config: { memoryDir: ${cfg?.memoryDir ?? "(unset)"}, ... } }`;
        }).join("\n")
      : "  (none)";
    console.log("\nResulting plugins.entries:");
    console.log(entrySummary);
    console.log(`\nResulting plugins.slots.memory: ${(dryRunPlugins.slots as Record<string, unknown>)?.memory ?? "(unset)"}`);
    return;
  }

  // Create memory dir — fail fast if the path exists but is a file
  if (fs.existsSync(memoryDir)) {
    const st = fs.statSync(memoryDir);
    if (!st.isDirectory()) {
      throw new Error(
        `Cannot use ${memoryDir} as the memory directory — a file already exists at that path.\n` +
        `Remove it first and re-run, or choose a different path with --memory-dir.`,
      );
    }
    // Directory already exists, nothing to do.
  } else {
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

// ── Taxonomy commands (#366) ─────────────────────────────────────────────────

async function cmdTaxonomy(rest: string[]): Promise<void> {
  initLogger();
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const remnicCfg = raw.remnic ?? raw.engram ?? raw;
  const config = parseConfig(remnicCfg);

  if (!config.taxonomyEnabled) {
    console.error(
      "Taxonomy is disabled in config (taxonomyEnabled = false). Enable it to use taxonomy commands.",
    );
    process.exit(1);
  }

  const subCommand = rest[0];

  switch (subCommand) {
    case "show": {
      const taxonomy = await loadTaxonomy(config.memoryDir);
      const json = rest.includes("--json");
      if (json) {
        console.log(JSON.stringify(taxonomy, null, 2));
      } else {
        console.log(`Taxonomy v${taxonomy.version} — ${taxonomy.categories.length} categories\n`);
        const idWidth = Math.max(4, ...taxonomy.categories.map((c) => c.id.length));
        const nameWidth = Math.max(6, ...taxonomy.categories.map((c) => c.name.length));
        const header = `${"ID".padEnd(idWidth)}  ${"Name".padEnd(nameWidth)}  ${"Pri".padStart(3)}  Memory Categories`;
        console.log(header);
        console.log("-".repeat(header.length + 10));
        const sorted = [...taxonomy.categories].sort((a, b) => a.priority - b.priority);
        for (const cat of sorted) {
          const line = `${cat.id.padEnd(idWidth)}  ${cat.name.padEnd(nameWidth)}  ${String(cat.priority).padStart(3)}  ${cat.memoryCategories.join(", ")}`;
          console.log(line);
        }
      }
      break;
    }

    case "resolver": {
      const taxonomy = await loadTaxonomy(config.memoryDir);
      const doc = generateResolverDocument(taxonomy);
      console.log(doc);

      if (config.taxonomyAutoGenResolver) {
        const resolverPath = path.join(config.memoryDir, ".taxonomy", "RESOLVER.md");
        fs.mkdirSync(path.dirname(resolverPath), { recursive: true });
        fs.writeFileSync(resolverPath, doc);
        console.error(`Written: ${resolverPath}`);
      }
      break;
    }

    case "add": {
      const id = rest[1];
      const name = rest[2];
      if (!id || !name) {
        console.error("Usage: remnic taxonomy add <id> <name>");
        process.exit(1);
      }
      try {
        validateSlug(id);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const taxonomy = await loadTaxonomy(config.memoryDir);
      if (taxonomy.categories.some((c) => c.id === id)) {
        console.error(`Category "${id}" already exists.`);
        process.exit(1);
      }

      const descriptionFlag = resolveFlag(rest, "--description");
      const priorityFlag = resolveFlag(rest, "--priority");
      const memoryCategoriesFlag = resolveFlag(rest, "--memory-categories");

      const newCat: TaxonomyCategory = {
        id,
        name,
        description: descriptionFlag ?? `Custom category: ${name}`,
        filingRules: [`Content belonging to ${name}`],
        priority: priorityFlag ? Number(priorityFlag) : 100,
        memoryCategories: memoryCategoriesFlag ? memoryCategoriesFlag.split(",").map((s) => s.trim()) : [],
      };

      taxonomy.categories.push(newCat);
      try {
        validateTaxonomy(taxonomy);
      } catch (err) {
        console.error(`Invalid taxonomy: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      await saveTaxonomy(config.memoryDir, taxonomy);
      console.log(`Added category "${id}" (${name}).`);

      if (config.taxonomyAutoGenResolver) {
        const doc = generateResolverDocument(taxonomy);
        const resolverPath = path.join(config.memoryDir, ".taxonomy", "RESOLVER.md");
        fs.writeFileSync(resolverPath, doc);
        console.error(`Regenerated: ${resolverPath}`);
      }
      break;
    }

    case "remove": {
      const id = rest[1];
      if (!id) {
        console.error("Usage: remnic taxonomy remove <id>");
        process.exit(1);
      }

      const taxonomy = await loadTaxonomy(config.memoryDir);
      const idx = taxonomy.categories.findIndex((c) => c.id === id);
      if (idx === -1) {
        console.error(`Category "${id}" not found.`);
        process.exit(1);
      }

      // Prevent removing a default category that has memoryCategories mapped
      const target = taxonomy.categories[idx]!;
      const isDefault = DEFAULT_TAXONOMY.categories.some((c) => c.id === id);
      if (isDefault && target.memoryCategories.length > 0) {
        console.error(
          `Cannot remove default category "${id}" that maps MemoryCategory values: ${target.memoryCategories.join(", ")}. ` +
          `Reassign them first.`,
        );
        process.exit(1);
      }

      taxonomy.categories.splice(idx, 1);
      await saveTaxonomy(config.memoryDir, taxonomy);
      console.log(`Removed category "${id}".`);

      if (config.taxonomyAutoGenResolver) {
        const doc = generateResolverDocument(taxonomy);
        const resolverPath = path.join(config.memoryDir, ".taxonomy", "RESOLVER.md");
        fs.writeFileSync(resolverPath, doc);
        console.error(`Regenerated: ${resolverPath}`);
      }
      break;
    }

    case "resolve": {
      // Strip --flag and its following value token together so flag values
      // (e.g. "preference" in `--category preference`) don't leak into text.
      // Boolean flags (like --json) don't consume a following value token.
      const resolveArgs = rest.slice(1);
      const textParts = stripResolveFlags(resolveArgs, TAXONOMY_RESOLVE_BOOLEAN_FLAGS);
      const text = textParts.join(" ");
      if (!text) {
        console.error("Usage: remnic taxonomy resolve <text>");
        process.exit(1);
      }

      const categoryFlag = resolveFlag(rest, "--category") as MemoryCategory | undefined;
      const memoryCategory: MemoryCategory = categoryFlag ?? "fact";
      const taxonomy = await loadTaxonomy(config.memoryDir);
      const decision = resolveCategory(text, memoryCategory, taxonomy);
      const json = rest.includes("--json");

      if (json) {
        console.log(JSON.stringify(decision, null, 2));
      } else {
        console.log(`Category:   ${decision.categoryId}`);
        console.log(`Confidence: ${decision.confidence.toFixed(2)}`);
        console.log(`Reason:     ${decision.reason}`);
        if (decision.alternatives.length > 0) {
          console.log(`\nAlternatives:`);
          for (const alt of decision.alternatives.slice(0, 3)) {
            console.log(`  - ${alt.categoryId}: ${alt.reason}`);
          }
        }
      }
      break;
    }

    default:
      console.log(`
remnic taxonomy — MECE knowledge directory

Usage:
  remnic taxonomy show [--json]                     Show current taxonomy
  remnic taxonomy resolver                          Print/regenerate RESOLVER.md
  remnic taxonomy add <id> <name> [options]         Add a custom category
    --description <text>                              Category description
    --priority <number>                               Priority (lower wins, default 100)
    --memory-categories <list>                        Comma-separated MemoryCategory values
  remnic taxonomy remove <id>                       Remove a custom category
  remnic taxonomy resolve <text> [--category <cat>] Test: resolve text to a category
    --json                                            JSON output
`);
      break;
  }
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
          await daemonStatus();
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

    case "bench": {
      await cmdBench(rest);
      break;
    }

    case "benchmark": {
      await cmdBench(rest);
      break;
    }

    case "briefing": {
      await cmdBriefing(rest);
      break;
    }

    case "versions": {
      await cmdVersions(rest);
      break;
    }

    case "binary": {
      await cmdBinary(rest);
      break;
    }

    case "taxonomy": {
      await cmdTaxonomy(rest);
      break;
    }

    case "enrich": {
      await cmdEnrich(rest);
      break;
    }

    case "extensions": {
      const action = rest[0] ?? "help";
      await cmdExtensions(action, rest.slice(1));
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
  remnic connectors <list|install|remove|doctor|marketplace> [id]  Manage connectors
    marketplace generate    Generate marketplace.json for Codex
    marketplace validate    Validate a marketplace.json file
    marketplace install     Install from a marketplace source
  remnic extensions <list|show|validate|reload>  Manage memory extensions
  remnic space <list|switch|create|delete|push|pull|share|promote|audit>  Manage spaces
    create accepts --parent <id> to set parent-child relationship
  remnic bench <list|run> [benchmark...] [--quick] [--all] [--json]
    benchmark is kept as a compatibility alias. check/report remain under that alias.
  remnic benchmark <list|run|check|report> [queries...] [--explain] [--baseline=<path>] [--report=<path>]
  remnic briefing [--since <window>] [--focus <filter>] [--save] [--format markdown|json]
    Daily context briefing. Windows: yesterday, today, NNh, NNd, NNw.
    Focus: person:<name>, project:<name>, topic:<name>.
  remnic versions <list|show|diff|revert> <page-path> [id] [--json]
    Page-level versioning: list, show, diff, or revert page snapshots.
  remnic binary scan               Scan for untracked binary files
  remnic binary status             Show binary lifecycle manifest summary
  remnic binary run [--dry-run]    Run full binary lifecycle pipeline
  remnic binary clean --force      Force-clean binaries past grace period
  remnic taxonomy <show|resolver|add|remove|resolve>  MECE knowledge directory
    show [--json]                     Show current taxonomy
    resolver                          Print/regenerate RESOLVER.md
    add <id> <name> [--priority N]    Add custom category
    remove <id>                       Remove custom category
    resolve <text> [--category <cat>] Test resolver on sample text
  remnic enrich <entity-name>    Manually enrich a specific entity
  remnic enrich --all            Enrich all entities
  remnic enrich --dry-run        Preview what would be enriched
  remnic enrich audit            Show recent enrichment audit log
  remnic enrich providers        List registered providers and their status

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
