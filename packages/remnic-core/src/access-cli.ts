import fs from "node:fs";
import path from "node:path";
import { parseConfig } from "./config.js";
import type { PluginConfig } from "./types.js";
import { Orchestrator } from "./orchestrator.js";
import { EngramAccessService } from "./access-service.js";
import { readEnvVar, resolveHomeDir } from "./runtime/env.js";
import { PLUGIN_ID, LEGACY_PLUGIN_ID } from "./plugin-id.js";

type CommandName = "browse" | "store";

type ParsedArgs = {
  command: CommandName;
  options: Record<string, string[]>;
  flags: Set<string>;
};

type Runtime = {
  config: PluginConfig;
  service: EngramAccessService;
};

type UsageErrorKind =
  | "unsupported-command"
  | "unexpected-positional"
  | "missing-option"
  | "missing-content"
  | "invalid-integer"
  | "invalid-number";

class UsageError extends Error {
  constructor(
    readonly kind: UsageErrorKind,
    readonly optionName?: string,
  ) {
    super("invalid access-cli arguments");
  }
}

function formatUsageError(error: UsageError): string {
  switch (error.kind) {
    case "unsupported-command":
      return "unsupported command";
    case "unexpected-positional":
      return "unexpected positional argument";
    case "missing-option":
      return `missing required option: --${error.optionName ?? "unknown"}`;
    case "missing-content":
      return "missing required option: --content or --content-file";
    case "invalid-integer":
      return `invalid integer for --${error.optionName ?? "unknown"}`;
    case "invalid-number":
      return `invalid number for --${error.optionName ?? "unknown"}`;
  }
}

function writeCliOutput(text: string = ""): void {
  process.stdout.write(`${text}\n`);
}

function usage(): string {
  return [
    "Usage:",
    "  engram-access browse [options]",
    "  engram-access store [options]",
    "",
    "Browse options:",
    "  --namespace <name>",
    "  --query <text>",
    "  --category <name>",
    "  --status <name>",
    "  --sort <updated_desc|updated_asc|created_desc|created_asc>",
    "  --limit <n>",
    "  --offset <n>",
    "",
    "Store options:",
    "  --namespace <name>",
    "  --session-key <key>",
    "  --principal <principal>",
    "  --content <text> | --content-file <path>",
    "  --category <name>",
    "  --confidence <0-1>",
    "  --tag <tag> (repeatable)",
    "  --entity-ref <ref>",
    "  --ttl <duration>",
    "  --source-reason <text>",
    "  --idempotency-key <key>",
    "  --dry-run",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const [commandRaw, ...rest] = argv;
  if (commandRaw !== "browse" && commandRaw !== "store") {
    throw new UsageError("unsupported-command");
  }

  const options: Record<string, string[]> = {};
  const flags = new Set<string>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new UsageError("unexpected-positional");
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }
    if (!options[key]) {
      options[key] = [];
    }
    options[key].push(next);
    i += 1;
  }

  return {
    command: commandRaw,
    options,
    flags,
  };
}

function getLastOption(args: ParsedArgs, name: string): string | undefined {
  const values = args.options[name];
  if (!values || values.length === 0) return undefined;
  return values[values.length - 1];
}

function getAllOptions(args: ParsedArgs, name: string): string[] {
  return args.options[name] ?? [];
}

function requireOption(args: ParsedArgs, name: string): string {
  const value = getLastOption(args, name);
  if (!value || value.trim().length === 0) {
    throw new UsageError("missing-option", name);
  }
  return value;
}

function parseIntegerOption(args: ParsedArgs, name: string): number | undefined {
  const raw = getLastOption(args, name);
  if (!raw) return undefined;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new UsageError("invalid-integer", name);
  }
  return value;
}

function parseFloatOption(args: ParsedArgs, name: string): number | undefined {
  const raw = getLastOption(args, name);
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new UsageError("invalid-number", name);
  }
  return value;
}

function loadPluginConfig(): Record<string, unknown> {
  const configPath =
    readEnvVar("OPENCLAW_ENGRAM_CONFIG_PATH") ||
    readEnvVar("OPENCLAW_CONFIG_PATH") ||
    path.join(resolveHomeDir(), ".openclaw", "openclaw.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  // Resolve via the active memory slot first so that migration configs with
  // both entries honour whichever id the operator configured (#403).
  const activeSlot: string | undefined = raw?.plugins?.slots?.memory;
  const entry =
    (activeSlot && raw?.plugins?.entries?.[activeSlot] !== undefined
      ? raw.plugins.entries[activeSlot]
      : undefined) ??
    raw?.plugins?.entries?.[PLUGIN_ID] ??
    raw?.plugins?.entries?.[LEGACY_PLUGIN_ID];
  return entry?.config ?? {};
}

function buildRuntime(): Runtime {
  const config = parseConfig(loadPluginConfig());
  return {
    config,
    service: new EngramAccessService(new Orchestrator(config)),
  };
}

async function runBrowse(args: ParsedArgs): Promise<void> {
  const { service } = buildRuntime();
  const result = await service.memoryBrowse({
    namespace: getLastOption(args, "namespace"),
    query: getLastOption(args, "query"),
    category: getLastOption(args, "category"),
    status: getLastOption(args, "status"),
    sort: getLastOption(args, "sort") as "updated_desc" | "updated_asc" | "created_desc" | "created_asc" | undefined,
    limit: parseIntegerOption(args, "limit"),
    offset: parseIntegerOption(args, "offset"),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function runStore(args: ParsedArgs): Promise<void> {
  const { config, service } = buildRuntime();
  const contentFile = getLastOption(args, "content-file");
  const inlineContent = getLastOption(args, "content");
  const content = contentFile ? fs.readFileSync(contentFile, "utf8") : inlineContent;
  if (!content || content.trim().length === 0) {
    throw new UsageError("missing-content");
  }

  const result = await service.memoryStore({
    namespace: getLastOption(args, "namespace"),
    sessionKey: getLastOption(args, "session-key"),
    authenticatedPrincipal: getLastOption(args, "principal") ?? config.agentAccessHttp.principal,
    content,
    category: requireOption(args, "category"),
    confidence: parseFloatOption(args, "confidence"),
    tags: getAllOptions(args, "tag"),
    entityRef: getLastOption(args, "entity-ref"),
    ttl: getLastOption(args, "ttl"),
    sourceReason: getLastOption(args, "source-reason"),
    idempotencyKey: getLastOption(args, "idempotency-key"),
    dryRun: args.flags.has("dry-run"),
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "browse") {
    await runBrowse(args);
    return;
  }
  await runStore(args);
}

export function printUsage(): void {
  writeCliOutput(usage());
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await main(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      writeCliOutput(formatUsageError(error));
      writeCliOutput();
      printUsage();
      process.exit(1);
    }

    console.error("access-cli failed");
    process.exit(1);
  }
}
