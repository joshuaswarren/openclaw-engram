/**
 * Training-data converter.
 *
 * Reads memory markdown files from a memoryDir, parses YAML
 * frontmatter, applies filters, and returns TrainingExportRecord[].
 *
 * Instruction is derived from the memory's category/tags.
 * Output is the memory content body.
 * The `input` field is empty string (synthesis is left to adapters).
 */

import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";

import type { TrainingExportOptions, TrainingExportRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Frontmatter parsing (mirrors storage.ts but kept standalone)
// ---------------------------------------------------------------------------

interface ParsedMemory {
  id: string;
  category: string;
  confidence: number;
  created: string;
  updated: string;
  tags: string[];
  content: string;
  filePath: string;
}

function parseFrontmatter(raw: string): ParsedMemory | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const fmBlock = match[1];
  const content = (match[2] ?? "").trim();
  const fm: Record<string, string> = {};

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }

  let tags: string[] = [];
  const tagsStr = fm.tags ?? "";
  const tagMatch = tagsStr.match(/\[(.*)]/);
  if (tagMatch) {
    tags = tagMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  const confidence = parseFloat(fm.confidence ?? "0.8");

  return {
    id: fm.id ?? "",
    category: fm.category ?? "fact",
    confidence: Number.isFinite(confidence) ? confidence : 0.8,
    created: fm.created ?? "",
    updated: fm.updated ?? "",
    tags,
    content,
    filePath: "",
  };
}

// ---------------------------------------------------------------------------
// Recursive directory scan
// ---------------------------------------------------------------------------

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (d: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (err: unknown) {
      // ENOENT means directory doesn't exist — that's fine (e.g. no facts/ yet)
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      // Other errors (EACCES, EIO, etc.) indicate real problems — propagate
      throw err;
    }
    // Sort entries by name for deterministic output order
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      // Reject symlinks to prevent data exfiltration (a symlink could
      // point outside memoryDir, e.g. facts/private.md -> ~/.ssh/id_rsa)
      let linkStat: import("node:fs").Stats;
      try {
        linkStat = await lstat(full);
      } catch (err: unknown) {
        // ENOENT: entry disappeared between readdir and lstat — skip
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw err;
      }
      if (linkStat.isSymbolicLink()) {
        continue;
      }
      // Gate traversal on lstat() type rather than Dirent flags: some
      // filesystems (certain network/FUSE mounts) return DT_UNKNOWN from
      // readdir, making entry.isDirectory()/isFile() report false for real
      // directories and regular files. lstat() gives a definitive answer.
      if (linkStat.isDirectory()) {
        await walk(full);
      } else if (linkStat.isFile() && entry.name.endsWith(".md")) {
        // Only accept regular files — FIFOs, sockets, device nodes, etc.
        // could hang or error on readFile
        files.push(full);
      }
    }
  };

  await walk(dir);
  return files;
}

// ---------------------------------------------------------------------------
// Build instruction from category + tags
// ---------------------------------------------------------------------------

function buildInstruction(category: string, tags: string[]): string {
  const tagSuffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
  switch (category) {
    case "fact":
      return `Recall a factual memory${tagSuffix}`;
    case "preference":
      return `Recall a user preference${tagSuffix}`;
    case "correction":
      return `Recall a correction${tagSuffix}`;
    case "entity":
      return `Recall entity information${tagSuffix}`;
    case "decision":
      return `Recall a decision${tagSuffix}`;
    case "relationship":
      return `Recall a relationship${tagSuffix}`;
    case "principle":
      return `Recall a principle${tagSuffix}`;
    case "commitment":
      return `Recall a commitment${tagSuffix}`;
    case "moment":
      return `Recall a moment${tagSuffix}`;
    case "skill":
      return `Recall a skill${tagSuffix}`;
    case "rule":
      return `Recall a rule${tagSuffix}`;
    default:
      return `Recall a memory${tagSuffix}`;
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseIsoDate(isoStr: string): Date | null {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read memories from `memoryDir`, apply option filters, and return
 * an array of TrainingExportRecord for downstream adapters.
 */
export async function convertMemoriesToRecords(
  options: TrainingExportOptions,
): Promise<TrainingExportRecord[]> {
  const { memoryDir } = options;

  // Gate unimplemented options (CLAUDE.md #51, #55)
  if (options.includeTopics) {
    throw new Error(
      "includeTopics is not yet implemented — this option will be available in a future release",
    );
  }

  // Validate since/until Date objects are valid (CLAUDE.md #51)
  // NaN comparisons always return false, which silently disables filters
  if (options.since && !Number.isFinite(options.since.getTime())) {
    throw new Error("since is an Invalid Date — provide a valid Date object");
  }
  if (options.until && !Number.isFinite(options.until.getTime())) {
    throw new Error("until is an Invalid Date — provide a valid Date object");
  }

  // Validate minConfidence is a finite number in [0, 1] (CLAUDE.md #51)
  // NaN comparisons always return false, which would silently disable the filter
  if (
    options.minConfidence !== undefined &&
    (!Number.isFinite(options.minConfidence) ||
      options.minConfidence < 0 ||
      options.minConfidence > 1)
  ) {
    throw new Error(
      `minConfidence must be a finite number between 0 and 1, got: ${options.minConfidence}`,
    );
  }

  // Normalize memoryDir: strip trailing separators so that lstat sees the
  // entry itself rather than the directory it points to. Node's lstat on
  // "link/" resolves through the symlink and reports a directory, not a
  // symlink — the trailing slash strips the symlink-root guard entirely.
  const normalizedMemoryDir = memoryDir.replace(/[/\\]+$/, "");

  // Reject symlinked memoryDir root — a symlink could redirect the entire
  // memory tree to an attacker-controlled location, bypassing per-file checks.
  // Using the normalized path ensures a trailing slash cannot bypass this check.
  let rootLinkStat: import("node:fs").Stats;
  try {
    rootLinkStat = await lstat(normalizedMemoryDir);
  } catch {
    throw new Error(
      `memoryDir does not exist: ${memoryDir}`,
    );
  }
  if (rootLinkStat.isSymbolicLink()) {
    throw new Error(
      `memoryDir must not be a symlink: ${memoryDir}`,
    );
  }
  // lstat on a non-symlink is identical to stat, so isDirectory() is already
  // authoritative here — no second stat() call needed (CLAUDE.md #24).
  if (!rootLinkStat.isDirectory()) {
    throw new Error(
      `memoryDir is not a directory: ${memoryDir}`,
    );
  }

  // Collect from facts/ and corrections/ subdirectories (mirrors storage.ts)
  const factsDir = path.join(normalizedMemoryDir, "facts");
  const correctionsDir = path.join(normalizedMemoryDir, "corrections");

  const dirs = [factsDir, correctionsDir];
  if (options.includeEntities) {
    dirs.push(path.join(normalizedMemoryDir, "entities"));
  }

  const allFiles: string[] = [];
  for (const dir of dirs) {
    // Reject symlinked source directories — a symlinked facts/ could point
    // outside memoryDir, enabling data exfiltration
    try {
      const dirLinkStat = await lstat(dir);
      if (dirLinkStat.isSymbolicLink()) {
        continue; // skip symlinked source directory entirely
      }
    } catch (err: unknown) {
      // ENOENT means directory doesn't exist — that's fine
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }
    const files = await collectMarkdownFiles(dir);
    allFiles.push(...files);
  }

  const records: TrainingExportRecord[] = [];

  for (const filePath of allFiles) {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err: unknown) {
      // ENOENT means the file was removed between listing and reading — skip
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      // Other errors (EACCES, EIO, etc.) indicate real problems — propagate
      throw err;
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed) continue; // skip malformed files
    if (!parsed.content) continue; // skip empty content

    parsed.filePath = filePath;

    // Entity files from entities/ directory: override default category and
    // derive sourceId from filename when frontmatter ID is missing
    const entitiesPrefix = path.join(memoryDir, "entities") + path.sep;
    if (filePath.startsWith(entitiesPrefix)) {
      // Default category from parseFrontmatter is "fact" — override to "entity"
      // if the frontmatter didn't explicitly set a different category
      if (parsed.category === "fact") {
        parsed.category = "entity";
      }
      // Derive ID from filename when frontmatter ID is empty
      if (!parsed.id) {
        parsed.id = path.basename(filePath, ".md");
      }
    }

    // --- Apply filters ---

    // minConfidence (CLAUDE.md #35: half-open intervals where applicable,
    // but confidence is an inclusive lower bound)
    if (
      options.minConfidence !== undefined &&
      parsed.confidence < options.minConfidence
    ) {
      continue;
    }

    // categories filter
    if (
      options.categories !== undefined &&
      options.categories.length > 0 &&
      !options.categories.includes(parsed.category)
    ) {
      continue;
    }

    // since filter (half-open: created >= since)
    if (options.since) {
      const created = parseIsoDate(parsed.created);
      // Exclude memories with missing/unparseable dates when date filtering
      // is active — including them contradicts the user's date-range intent
      if (!created) continue;
      if (created.getTime() < options.since.getTime()) {
        continue;
      }
    }

    // until filter (exclusive upper bound per CLAUDE.md #35: created < until)
    if (options.until) {
      const created = parseIsoDate(parsed.created);
      if (!created) continue;
      if (created.getTime() >= options.until.getTime()) {
        continue;
      }
    }

    records.push({
      instruction: buildInstruction(parsed.category, parsed.tags),
      input: "",
      output: parsed.content,
      category: parsed.category,
      confidence: parsed.confidence,
      sourceIds: parsed.id ? [parsed.id] : undefined,
    });
  }

  return records;
}
