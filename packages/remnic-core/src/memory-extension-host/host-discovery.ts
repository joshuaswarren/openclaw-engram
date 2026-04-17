/**
 * memory-extension-host/host-discovery.ts — Discover third-party memory extensions.
 *
 * Scans a root directory (typically ~/.remnic/memory_extensions/) for valid
 * extension subdirectories. Each extension must contain an instructions.md.
 * The discovery process is read-only and NEVER reads or executes files under
 * any extension's scripts/ directory.
 */

import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import type { LoggerBackend } from "../logger.js";
import type { DiscoveredExtension, ExtensionSchema } from "./types.js";

/** Total token budget for all discovered extension instructions combined. */
export const REMNIC_EXTENSIONS_TOTAL_TOKEN_LIMIT = 5_000;

/** Maximum number of example files collected per extension. */
const MAX_EXAMPLES_PER_EXTENSION = 10;

/** Slug validation: lowercase letters, digits, hyphens, 1-64 chars. */
const VALID_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const VALID_MEMORY_TYPES = new Set(["fact", "preference", "procedure", "reference"]);

/**
 * Discover all valid memory extensions under the given root directory.
 *
 * Returns extensions sorted by name. Skips entries with warnings when:
 * - The slug is invalid (not lowercase alphanumeric + hyphens, or > 64 chars)
 * - instructions.md is missing
 * - schema.json is malformed (extension still returned but schema is undefined)
 *
 * NEVER reads files under any extension's scripts/ directory.
 */
export async function discoverMemoryExtensions(
  root: string,
  log: Pick<LoggerBackend, "warn" | "debug">,
): Promise<DiscoveredExtension[]> {
  // If root doesn't exist, return empty silently (not even a warning).
  // Use lstat() for root — a symlinked extensions root could redirect the
  // entire discovery to an attacker-controlled directory (#428 P2).
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    return [];
  }
  if (rootStat.isSymbolicLink()) {
    log.warn?.(
      `[memory-extensions] extensions root "${root}" is a symlink, refusing to traverse for security`,
    );
    return [];
  }
  if (!rootStat.isDirectory()) {
    return [];
  }

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const extensions: DiscoveredExtension[] = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry);

    // Must be a real directory (not a symlink) — lstat() blocks symlink
    // traversal that could escape the extensions root (#382 P2).
    let entryStat;
    try {
      entryStat = await lstat(entryPath);
    } catch {
      continue;
    }
    if (entryStat.isSymbolicLink()) {
      log.warn?.(
        `[memory-extensions] skipping "${entry}": symlinks are not followed for security`,
      );
      continue;
    }
    if (!entryStat.isDirectory()) continue;

    // Validate slug
    if (!VALID_SLUG_RE.test(entry)) {
      log.warn?.(
        `[memory-extensions] skipping "${entry}": invalid slug (must be lowercase alphanumeric + hyphens, 1-64 chars)`,
      );
      continue;
    }

    // Require instructions.md — reject symlinks to prevent path-traversal leaks (#428 P1).
    const instructionsPath = path.join(entryPath, "instructions.md");
    try {
      const instrStat = await lstat(instructionsPath);
      if (instrStat.isSymbolicLink()) {
        log.warn?.(
          `[memory-extensions] skipping "${entry}": instructions.md is a symlink, refusing to read for security`,
        );
        continue;
      }
    } catch {
      log.warn?.(
        `[memory-extensions] skipping "${entry}": missing instructions.md`,
      );
      continue;
    }
    let instructions: string;
    try {
      instructions = await readFile(instructionsPath, "utf-8");
    } catch {
      log.warn?.(
        `[memory-extensions] skipping "${entry}": could not read instructions.md`,
      );
      continue;
    }

    // Read optional schema.json — reject symlinks (#428 P1).
    let schema: ExtensionSchema | undefined;
    const schemaPath = path.join(entryPath, "schema.json");
    try {
      const schemaStat = await lstat(schemaPath);
      if (schemaStat.isSymbolicLink()) {
        log.warn?.(
          `[memory-extensions] "${entry}": schema.json is a symlink, ignoring schema for security`,
        );
        // schema remains undefined — we skip reading but don't skip the extension
      } else {
        const schemaRaw = await readFile(schemaPath, "utf-8");
        const parsed = JSON.parse(schemaRaw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          schema = validateSchema(parsed);
        } else {
          log.warn?.(
            `[memory-extensions] "${entry}": schema.json is not a valid object, ignoring schema`,
          );
        }
      }
    } catch (err) {
      // File doesn't exist → fine, no warning needed
      if (isFileNotFoundError(err)) {
        // schema remains undefined
      } else {
        log.warn?.(
          `[memory-extensions] "${entry}": malformed schema.json, ignoring schema`,
        );
      }
    }

    // Collect examples/*.md (cap at MAX_EXAMPLES_PER_EXTENSION)
    // NEVER read from scripts/ directory
    const examplesPaths: string[] = [];
    const examplesDir = path.join(entryPath, "examples");
    try {
      const exampleEntries = await readdir(examplesDir);
      const mdFiles = exampleEntries
        .filter((f) => f.endsWith(".md"))
        .sort()
        .slice(0, MAX_EXAMPLES_PER_EXTENSION);
      for (const f of mdFiles) {
        examplesPaths.push(path.join(examplesDir, f));
      }
    } catch {
      // No examples dir — fine
    }

    extensions.push({
      name: entry,
      root: entryPath,
      instructionsPath,
      instructions,
      schema,
      examplesPaths,
    });
  }

  // Sort by name for deterministic ordering
  extensions.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });

  return extensions;
}

function validateSchema(raw: Record<string, unknown>): ExtensionSchema {
  const memoryTypes: ExtensionSchema["memoryTypes"] = (() => {
    if (!Array.isArray(raw.memoryTypes)) return undefined;
    const valid = raw.memoryTypes.filter(
      (t): t is "fact" | "preference" | "procedure" | "reference" =>
        typeof t === "string" && VALID_MEMORY_TYPES.has(t),
    );
    return valid.length > 0 ? valid : undefined;
  })();

  const groupingHints: ExtensionSchema["groupingHints"] = (() => {
    if (!Array.isArray(raw.groupingHints)) return undefined;
    const valid = raw.groupingHints.filter(
      (h): h is string => typeof h === "string" && h.length > 0,
    );
    return valid.length > 0 ? valid : undefined;
  })();

  const version: ExtensionSchema["version"] =
    typeof raw.version === "string" && raw.version.length > 0
      ? raw.version
      : undefined;

  return {
    ...(memoryTypes ? { memoryTypes } : {}),
    ...(groupingHints ? { groupingHints } : {}),
    ...(version ? { version } : {}),
  };
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}
