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

import { readdir, readFile } from "node:fs/promises";
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
    } catch {
      return; // directory does not exist or is unreadable
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".md")) {
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

  // Collect from facts/ and corrections/ subdirectories (mirrors storage.ts)
  const factsDir = path.join(memoryDir, "facts");
  const correctionsDir = path.join(memoryDir, "corrections");

  const dirs = [factsDir, correctionsDir];
  if (options.includeEntities) {
    dirs.push(path.join(memoryDir, "entities"));
  }

  const allFiles: string[] = [];
  for (const dir of dirs) {
    const files = await collectMarkdownFiles(dir);
    allFiles.push(...files);
  }

  const records: TrainingExportRecord[] = [];

  for (const filePath of allFiles) {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      continue; // skip unreadable files
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed) continue; // skip malformed files
    if (!parsed.content) continue; // skip empty content

    parsed.filePath = filePath;

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
      // Exclude memories with missing/unparseable dates when date filters are active
      if (!created || created.getTime() < options.since.getTime()) {
        continue;
      }
    }

    // until filter (exclusive upper bound per CLAUDE.md #35: created < until)
    if (options.until) {
      const created = parseIsoDate(parsed.created);
      // Exclude memories with missing/unparseable dates when date filters are active
      if (!created || created.getTime() >= options.until.getTime()) {
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
