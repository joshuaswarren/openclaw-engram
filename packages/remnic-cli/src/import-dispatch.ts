// ---------------------------------------------------------------------------
// `remnic import` command dispatcher (issue #568, slice 1)
// ---------------------------------------------------------------------------
//
// This module is the top-level CLI entry for the four memory importers
// (ChatGPT, Claude, Gemini, Mem0). Slice 1 wires ONLY the infrastructure —
// actual source adapters land in slices 2-5 and are discovered via the
// computed-specifier loader in `optional-importer.ts`. Running
// `remnic import --adapter chatgpt ...` today will therefore surface a clean
// "optional package not installed" hint rather than a bare MODULE_NOT_FOUND.
//
// Flag contract (CLAUDE.md rule 14 — every value flag must reject
//   `--flag` without a following value; rule 51 — reject invalid input with
//   a list of valid options instead of silently defaulting):
//
//   --adapter <name>       Required. One of chatgpt|claude|gemini|mem0.
//   --file <path>          Required unless the adapter accepts an API-only
//                          input (mem0). Expanded via ~.
//   --dry-run              Parse + transform only; no writes, no API calls.
//   --batch-size <n>       Memories per orchestrator batch. Rejects non-
//                          integers and values outside [1, 500].
//   --rate-limit <rps>     API-backed importers only. Rejects <= 0.
//   --include-conversations Adapter hint forwarded into transform().
//   --help, -h             Print usage.

import fs from "node:fs";

import {
  runImporter,
  validateImportBatchSize,
  validateImportRateLimit,
  type ImporterAdapter,
  type ImporterWriteTarget,
  type RunImporterResult,
  type RunImportOptions,
  type ImporterParseOptions,
  type ImporterTransformOptions,
} from "@remnic/core";

import {
  isSupportedImporterName,
  loadImporterModule,
  SUPPORTED_IMPORTERS,
  type SupportedImporterName,
} from "./optional-importer.js";

export interface ImportDispatchArgs {
  adapter: SupportedImporterName;
  file?: string;
  dryRun: boolean;
  batchSize?: number;
  rateLimit?: number;
  includeConversations: boolean;
}

export interface ImportDispatchIO {
  readFile: (path: string) => Promise<string>;
  loadAdapter: (name: SupportedImporterName) => Promise<ImporterAdapter<unknown>>;
  runImporter: typeof runImporter;
  target: ImporterWriteTarget;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export const IMPORT_USAGE = `remnic import — Bring memory from ChatGPT, Claude, Gemini, or Mem0 (issue #568)

Usage:
  remnic import --adapter <name> --file <path> [options]

Required:
  --adapter <name>            One of: ${SUPPORTED_IMPORTERS.join(" | ")}
  --file <path>               Path to the source export (JSON or ZIP). May be
                              omitted for API-only adapters (mem0).

Options:
  --dry-run                   Parse and transform only; do not write memories.
  --batch-size <n>            Memories per orchestrator batch (default 25).
  --rate-limit <rps>          Requests per second for API importers.
  --include-conversations     Adapter hint: opt into conversation imports
                              (e.g. ChatGPT bulk conversation summaries).
  --help, -h                  Show this help.

Slice 1 ships infrastructure only. The four adapter packages
(@remnic/import-chatgpt, @remnic/import-claude, @remnic/import-gemini,
@remnic/import-mem0) land in slices 2-5. Install whichever you need:

  npm install -g @remnic/import-chatgpt
  npm install -g @remnic/import-claude
  npm install -g @remnic/import-gemini
  npm install -g @remnic/import-mem0
`;

/**
 * Parse `remnic import ...` flags into a structured args object. Throws with
 * a user-facing message on missing values, unknown adapters, or invalid
 * numeric inputs — callers should catch and print `err.message`.
 *
 * Exported for testability so slice-1 tests can validate the flag contract
 * without booting the full CLI.
 */
export function parseImportArgs(rest: readonly string[]): ImportDispatchArgs {
  const args = [...rest];

  const adapter = takeValue(args, "--adapter");
  if (!adapter) {
    throw new Error(
      `--adapter <name> is required. Valid values: ${SUPPORTED_IMPORTERS.join(", ")}`,
    );
  }
  if (!isSupportedImporterName(adapter)) {
    throw new Error(
      `Unknown importer '${adapter}'. Valid values: ${SUPPORTED_IMPORTERS.join(", ")}`,
    );
  }

  const file = takeOptionalValue(args, "--file");
  const dryRun = consumeFlag(args, "--dry-run");
  const includeConversations = consumeFlag(args, "--include-conversations");

  const batchSizeRaw = takeOptionalValue(args, "--batch-size");
  let batchSize: number | undefined;
  if (batchSizeRaw !== undefined) {
    const parsed = Number(batchSizeRaw);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `--batch-size must be an integer. Received '${batchSizeRaw}'.`,
      );
    }
    batchSize = validateImportBatchSize(parsed);
  }

  const rateLimitRaw = takeOptionalValue(args, "--rate-limit");
  let rateLimit: number | undefined;
  if (rateLimitRaw !== undefined) {
    const parsed = Number(rateLimitRaw);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `--rate-limit must be a positive number (requests per second). Received '${rateLimitRaw}'.`,
      );
    }
    rateLimit = validateImportRateLimit(parsed);
  }

  // Any remaining unknown --flag tokens should be rejected rather than
  // silently ignored (CLAUDE.md rule 51). We allow positional leftovers to
  // pass through untouched because adapters may define their own hints in
  // future slices.
  const unknownFlags = args.filter((a) => a.startsWith("--"));
  if (unknownFlags.length > 0) {
    throw new Error(
      `Unknown flag(s) for 'remnic import': ${unknownFlags.join(", ")}. ` +
        `Run 'remnic import --help' for the full option list.`,
    );
  }

  return {
    adapter,
    file,
    dryRun,
    batchSize,
    rateLimit,
    includeConversations,
  };
}

/**
 * Execute `remnic import` given already-parsed args. The IO parameter is
 * injected so tests can assert on the CLI's behaviour without touching the
 * filesystem or loading real importer packages.
 */
export async function runImportCommand(
  args: ImportDispatchArgs,
  io: ImportDispatchIO,
): Promise<RunImporterResult> {
  const adapter = await io.loadAdapter(args.adapter);

  // Shape inputs the adapter understands. Adapters that accept raw file
  // bytes (e.g. a ZIP buffer) are free to re-read the path themselves via
  // `parseOptions.filePath`; this slice-1 wiring passes the file contents as
  // a string for text/JSON exports and the path as a fallback so adapters
  // can choose.
  let input: unknown;
  if (args.file) {
    try {
      input = await io.readFile(args.file);
    } catch (err) {
      throw new Error(
        `Failed to read --file '${args.file}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    // No file → API-only adapter (mem0). Pass `undefined` through; adapters
    // that require a file will surface their own error.
    input = undefined;
  }

  const parseOptions: ImporterParseOptions = {
    filePath: args.file,
  };
  const transformOptions: ImporterTransformOptions = {
    includeConversations: args.includeConversations,
  };
  const runOptions: RunImportOptions & {
    parseOptions?: ImporterParseOptions;
    transformOptions?: ImporterTransformOptions;
  } = {
    dryRun: args.dryRun,
    ...(args.batchSize !== undefined ? { batchSize: args.batchSize } : {}),
    ...(args.rateLimit !== undefined ? { rateLimit: args.rateLimit } : {}),
    parseOptions,
    transformOptions,
    onProgress: (progress) => {
      if (progress.phase === "write") {
        io.stdout(
          `  progress: ${progress.processed}/${progress.total} memories written`,
        );
      }
    },
  };

  const result = await io.runImporter(adapter, input, io.target, runOptions);

  if (result.dryRun) {
    io.stdout(
      `Dry-run: would import ${result.memoriesPlanned} memories from '${result.sourceLabel}'.`,
    );
    io.stdout("(no memories were written; re-run without --dry-run to commit)");
  } else {
    io.stdout(
      `Imported ${result.memoriesWritten} memories from '${result.sourceLabel}' ` +
        `(${result.batchesProcessed} batch${result.batchesProcessed === 1 ? "" : "es"}).`,
    );
  }
  return result;
}

/**
 * Top-level CLI entry: `remnic import ...`. Reads `rest` from the CLI switch
 * statement. Uses `process.stdout` / `process.stderr` via the supplied io.
 */
export async function cmdImport(
  rest: string[],
  target: ImporterWriteTarget,
): Promise<RunImporterResult | undefined> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(IMPORT_USAGE);
    return undefined;
  }
  let parsed: ImportDispatchArgs;
  try {
    parsed = parseImportArgs(rest);
  } catch (err) {
    process.stderr.write(
      (err instanceof Error ? err.message : String(err)) + "\n",
    );
    process.exitCode = 1;
    return undefined;
  }

  const io: ImportDispatchIO = {
    readFile: async (p) => fs.promises.readFile(p, "utf-8"),
    loadAdapter: async (name) => (await loadImporterModule(name)).adapter,
    runImporter,
    target,
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
  };

  try {
    return await runImportCommand(parsed, io);
  } catch (err) {
    process.stderr.write(
      (err instanceof Error ? err.message : String(err)) + "\n",
    );
    process.exitCode = 1;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Argv helpers (local to this file — rule 14: reject bare flags)
// ---------------------------------------------------------------------------

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function takeValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  if (idx + 1 >= args.length) {
    throw new Error(
      `${flag} requires a value. Example: ${flag} <value>`,
    );
  }
  const value = args[idx + 1];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new Error(
      `${flag} requires a value. Example: ${flag} <value>`,
    );
  }
  args.splice(idx, 2);
  return value;
}

function takeOptionalValue(args: string[], flag: string): string | undefined {
  if (!args.includes(flag)) return undefined;
  return takeValue(args, flag);
}
