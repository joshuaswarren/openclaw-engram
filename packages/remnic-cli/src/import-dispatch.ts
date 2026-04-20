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
import { expandTilde } from "./path-utils.js";

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
  /**
   * Lazy factory for the write target. Called only when the run requires
   * writes (dryRun === false). Keeping it lazy means `--dry-run` and
   * `--help` invocations can complete without booting a full orchestrator
   * — critical for CLI responsiveness and for I/O minimisation.
   *
   * Disposal is the caller's responsibility (see `cmdImport`'s `dispose`
   * parameter). We deliberately do NOT expose `disposeWriteTarget` on the
   * IO interface because `runImportCommand` has no hook to call it — all
   * IO cleanup is owned by `cmdImport`, which tracks whether the target
   * was actually constructed before invoking dispose.
   */
  getWriteTarget: () => Promise<ImporterWriteTarget>;
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

  // CRITICAL: Extract value-bearing flags FIRST, before consuming boolean
  // flags. If we consumed boolean flags first via splice, then an argv like
  // `--batch-size --dry-run 10` would first collapse to `--batch-size 10`,
  // silently accepting `10` as the batch-size value — violating rule 14's
  // "bare value flag must be rejected" contract. By taking value flags
  // first, `takeValue` sees the adjacent `--dry-run` token and correctly
  // rejects it as a missing value. Cursor bugbot flagged this on PR #583.
  const fileRaw = takeOptionalValue(args, "--file");
  // Expand leading `~` so paths like `~/export.json` resolve. Node's fs
  // does not expand the tilde — CLAUDE.md rule 17.
  const file = fileRaw !== undefined ? expandTilde(fileRaw) : undefined;

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

  // Boolean flags last: after all value-bearing flags have claimed their
  // adjacent value tokens, any remaining standalone flags are genuine
  // booleans.
  const dryRun = consumeFlag(args, "--dry-run");
  const includeConversations = consumeFlag(args, "--include-conversations");

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

  // Dry-run must never boot the orchestrator — callers of
  // getWriteTarget() may construct an Orchestrator instance, which opens
  // cache / watcher handles that are wasted work when writes are skipped.
  // Cursor review on PR #583 flagged the non-lazy version.
  let target: ImporterWriteTarget;
  if (args.dryRun) {
    target = dryRunWriteTarget();
  } else {
    target = await io.getWriteTarget();
  }
  const result = await io.runImporter(adapter, input, target, runOptions);

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
 * Write target used during `--dry-run`. `runImporter` short-circuits before
 * invoking `writeTo`, but adapters may still pass this target around; every
 * method throws to make accidental writes from a dry-run path loud rather
 * than silent.
 */
function dryRunWriteTarget(): ImporterWriteTarget {
  return {
    async ingestBulkImportBatch() {
      throw new Error(
        "dry-run import: ingestBulkImportBatch was called despite dryRun being set. " +
          "Adapters MUST NOT write in dry-run mode.",
      );
    },
    bulkImportWriteNamespace() {
      return "dry-run";
    },
  };
}

/**
 * Top-level CLI entry: `remnic import ...`. Reads `rest` from the CLI switch
 * statement. Uses `process.stdout` / `process.stderr` via the supplied io.
 *
 * `targetFactory` is invoked lazily only for non-dry-run invocations — this
 * keeps `--dry-run` and missing-adapter install-hint paths from spinning up
 * the orchestrator (Cursor review on PR #583).
 */
export async function cmdImport(
  rest: string[],
  targetFactory: () => Promise<ImporterWriteTarget>,
  disposeTarget?: () => Promise<void>,
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

  // Track whether `getWriteTarget` was actually called so dispose only runs
  // when a target was materialized. An install-hint miss (loadAdapter throws)
  // must NOT trigger dispose — there's nothing to dispose and disposing may
  // itself throw, masking the original error.
  let targetMaterialized = false;
  const io: ImportDispatchIO = {
    readFile: async (p) => fs.promises.readFile(p, "utf-8"),
    loadAdapter: async (name) => (await loadImporterModule(name)).adapter,
    runImporter,
    getWriteTarget: async () => {
      targetMaterialized = true;
      return targetFactory();
    },
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
  } finally {
    // Only dispose when the write target was actually constructed. Checking
    // `parsed.dryRun` alone would incorrectly dispose after install-hint
    // misses or parse errors that happen BEFORE `getWriteTarget` is called.
    if (targetMaterialized && disposeTarget !== undefined) {
      try {
        await disposeTarget();
      } catch {
        // Best-effort; do not mask import errors.
      }
    }
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
