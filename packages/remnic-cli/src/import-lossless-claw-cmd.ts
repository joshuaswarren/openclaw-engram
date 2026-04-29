// ---------------------------------------------------------------------------
// `remnic import-lossless-claw` runner. Wraps the pure parser
// (./import-lossless-claw-args.ts) with I/O: opening the source DB, opening
// the destination LCM DB, and printing the summary.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

import {
  applyLcmSchema,
  ensureLcmStateDir,
  openLcmDatabase,
} from "@remnic/core";

import {
  IMPORT_LOSSLESS_CLAW_USAGE,
  parseImportLosslessClawArgs,
  type ImportLosslessClawCmdArgs,
} from "./import-lossless-claw-args.js";
import { loadImportLosslessClawModule } from "./optional-import-lossless-claw.js";

export { IMPORT_LOSSLESS_CLAW_USAGE };
export { parseImportLosslessClawArgs };
export type { ImportLosslessClawCmdArgs };

/**
 * Reject file paths used as directory args (CLAUDE.md gotcha #24), but
 * permit non-existent directories — `ensureLcmStateDir` creates them with
 * `recursive: true` during a real run, and `--dry-run` does not need the
 * directory to exist at all.
 */
function assertDirectoryOrAbsent(p: string, label: string): void {
  if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
    throw new Error(`${label} is not a directory: ${p}`);
  }
}

function assertFile(p: string, label: string): void {
  if (!fs.existsSync(p)) {
    throw new Error(`${label} does not exist: ${p}`);
  }
  if (!fs.statSync(p).isFile()) {
    throw new Error(`${label} is not a file: ${p}`);
  }
}

export interface CmdImportLosslessClawIO {
  resolveMemoryDir: () => string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export async function cmdImportLosslessClaw(
  argv: readonly string[],
  io: CmdImportLosslessClawIO,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    io.stdout(IMPORT_LOSSLESS_CLAW_USAGE);
    return 0;
  }

  let parsed: ImportLosslessClawCmdArgs;
  try {
    parsed = parseImportLosslessClawArgs(argv);
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    assertFile(parsed.src, "--src");
    const memoryDir = parsed.memoryDir ?? io.resolveMemoryDir();
    assertDirectoryOrAbsent(memoryDir, "--memory-dir");

    const mod = await loadImportLosslessClawModule();

    // Dry-run must not mutate destination storage (Codex P2). The dest
    // resolution rules are:
    //   * existing on-disk lcm.sqlite       → open read-only so dedup
    //                                          counts reflect reality
    //                                          (Codex P2 follow-up: an
    //                                          in-memory fallback would
    //                                          always report "would
    //                                          insert").
    //   * no on-disk lcm.sqlite yet         → in-memory + applyLcmSchema,
    //                                          so counts reflect a
    //                                          fresh-import scenario
    //                                          without touching the
    //                                          filesystem.
    // Real runs always go through ensureLcmStateDir + openLcmDatabase
    // (which creates the dir + file + schema as needed).
    let destDb: ReturnType<typeof openLcmDatabase>;
    if (parsed.dryRun) {
      const lcmPath = path.join(memoryDir, "state", "lcm.sqlite");
      if (fs.existsSync(lcmPath)) {
        destDb = mod.openExistingLcmDatabaseReadOnly(lcmPath);
      } else {
        destDb = mod.openInMemoryDestinationDatabase();
        applyLcmSchema(destDb);
      }
    } else {
      await ensureLcmStateDir(memoryDir);
      destDb = openLcmDatabase(memoryDir);
    }

    // Open the source DB inside its own try so a failed open (corrupt
    // SQLite header, permission error, etc.) doesn't leak destDb (Cursor
    // Bugbot review on PR #797 — `assertFile` catches existence but not
    // every I/O failure mode).
    let sourceDb: ReturnType<typeof mod.openSourceDatabase>;
    try {
      sourceDb = mod.openSourceDatabase(parsed.src);
    } catch (err) {
      destDb.close();
      throw err;
    }

    try {
      const result = mod.importLosslessClaw({
        sourceDb,
        destDb,
        dryRun: parsed.dryRun,
        sessionFilter:
          parsed.sessionFilter.length > 0
            ? new Set(parsed.sessionFilter)
            : undefined,
        onLog: (line: string) => io.stdout(line),
      });

      const summary = [
        result.dryRun ? "DRY RUN — no rows written." : "Import complete.",
        `Conversations scanned: ${result.conversationsScanned}`,
        `Sessions touched:      ${result.sessionsTouched.length}`,
        `Messages inserted:     ${result.messagesInserted}`,
        `Messages skipped:      ${result.messagesSkipped} (already present)`,
        `Summaries inserted:    ${result.summariesInserted}`,
        `Summaries skipped:     ${result.summariesSkipped} (already present)`,
        `  multi-parent collapsed: ${result.summariesMultiParentCollapsed}`,
        `  skipped (no messages):  ${result.summariesSkippedNoMessages}`,
        `  skipped (multi-session): ${result.summariesSkippedMultiSession}`,
        `Compaction events written: ${result.compactionEventsInserted}`,
      ].join("\n");
      io.stdout(summary);
      return 0;
    } finally {
      sourceDb.close();
      destDb.close();
    }
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
