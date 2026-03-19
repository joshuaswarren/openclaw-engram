import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { EngramAccessService } from "../src/access-service.ts";

type CommandName = "browse" | "store";

type ParsedArgs = {
  command: CommandName;
  options: Record<string, string[]>;
  flags: Set<string>;
};

function usage(): string {
  return [
    "Usage:",
    "  tsx scripts/access-cli.ts browse [options]",
    "  tsx scripts/access-cli.ts store [options]",
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
    throw new Error(`unsupported command: ${commandRaw ?? "(missing)"}`);
  }

  const options: Record<string, string[]> = {};
  const flags = new Set<string>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${token}`);
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
    throw new Error(`missing required option: --${name}`);
  }
  return value;
}

function parseIntegerOption(args: ParsedArgs, name: string): number | undefined {
  const raw = getLastOption(args, name);
  if (!raw) return undefined;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid integer for --${name}: ${raw}`);
  }
  return value;
}

function parseFloatOption(args: ParsedArgs, name: string): number | undefined {
  const raw = getLastOption(args, name);
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid number for --${name}: ${raw}`);
  }
  return value;
}

function loadPluginConfig(): Record<string, unknown> {
  const configPath =
    process.env.OPENCLAW_ENGRAM_CONFIG_PATH ||
    process.env.OPENCLAW_CONFIG_PATH ||
    path.join(process.env.HOME ?? os.homedir(), ".openclaw", "openclaw.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return raw?.plugins?.entries?.["openclaw-engram"]?.config ?? {};
}

function buildService(): EngramAccessService {
  const cfg = parseConfig(loadPluginConfig());
  return new EngramAccessService(new Orchestrator(cfg));
}

async function runBrowse(args: ParsedArgs): Promise<void> {
  const service = buildService();
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
  const service = buildService();
  const contentFile = getLastOption(args, "content-file");
  const inlineContent = getLastOption(args, "content");
  const content = contentFile ? fs.readFileSync(contentFile, "utf8") : inlineContent;
  if (!content || content.trim().length === 0) {
    throw new Error("missing required option: --content or --content-file");
  }

  const result = await service.memoryStore({
    namespace: getLastOption(args, "namespace"),
    sessionKey: getLastOption(args, "session-key"),
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "browse") {
    await runBrowse(args);
    return;
  }
  await runStore(args);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error("");
  console.error(usage());
  process.exit(1);
});
