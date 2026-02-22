/**
 * Temporal and Tag Indexes (v8.1 — SwiftMem-inspired)
 *
 * Maintains two fast on-disk lookup structures in `state/`:
 *   index_time.json — maps YYYY-MM-DD date buckets to memory file paths
 *   index_tags.json — maps tag strings to memory file paths
 *
 * Used as an optional prefilter in the retrieval pipeline:
 * given a time range or a set of tags, narrow the candidate set
 * before the QMD hybrid search so we can pass a smaller pool to scoring.
 *
 * Design constraints:
 * - Must be fail-open (any error returns empty / unfiltered)
 * - Reads/writes are batched per extraction run
 * - Both indexes are plain JSON; no external dependencies
 */

import * as fs from "fs";
import * as path from "path";

export interface TemporalIndexEntry {
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Absolute paths to memory files created on that date */
  paths: string[];
}

export interface TemporalIndex {
  /** version bumped when schema changes */
  version: number;
  /** Last full rebuild timestamp (ISO string) */
  lastRebuildAt?: string;
  /** Map from YYYY-MM-DD → array of memory paths */
  dates: Record<string, string[]>;
}

export interface TagIndex {
  version: number;
  lastRebuildAt?: string;
  /** Map from tag string → array of memory paths */
  tags: Record<string, string[]>;
}

const INDEX_VERSION = 1;
const TEMPORAL_INDEX_FILE = "index_time.json";
const TAG_INDEX_FILE = "index_tags.json";

function stateDir(memoryDir: string): string {
  return path.join(memoryDir, "state");
}

function temporalIndexPath(memoryDir: string): string {
  return path.join(stateDir(memoryDir), TEMPORAL_INDEX_FILE);
}

function tagIndexPath(memoryDir: string): string {
  return path.join(stateDir(memoryDir), TAG_INDEX_FILE);
}

function ensureStateDir(memoryDir: string): void {
  const dir = stateDir(memoryDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath: string, data: unknown): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Fail silently — indexes are advisory only
  }
}

/**
 * Atomic write: write to a `.tmp` sibling then rename so readers never
 * observe a partially-written file.  Falls back to direct write on error.
 */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  } catch {
    // Attempt direct write as fallback; indexes are advisory only
    writeJsonSafe(filePath, data);
    try { fs.unlinkSync(tmp); } catch { /* ignore stale tmp */ }
  }
}

function isoDateFromTimestamp(isoString: string): string {
  if (typeof isoString !== "string" || isoString.length < 10) {
    // Malformed frontmatter — fall back to today so the memory is still indexed
    return new Date().toISOString().slice(0, 10);
  }
  return isoString.slice(0, 10); // YYYY-MM-DD
}

function addPathToSet(record: Record<string, string[]>, key: string, p: string): void {
  if (!record[key]) {
    record[key] = [];
  }
  if (!record[key].includes(p)) {
    record[key].push(p);
  }
}

function removePathFromSet(record: Record<string, string[]>, key: string, p: string): void {
  if (!record[key]) return;
  record[key] = record[key].filter((x) => x !== p);
  if (record[key].length === 0) {
    delete record[key];
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Add (or update) a memory file in both indexes.
 *
 * @param memoryDir Root memory directory
 * @param memoryPath Absolute path to the memory file
 * @param createdAt ISO timestamp of the memory's creation date
 * @param tags Array of tag strings from the memory's frontmatter
 */
export function indexMemory(
  memoryDir: string,
  memoryPath: string,
  createdAt: string,
  tags: string[],
): void {
  try {
    ensureStateDir(memoryDir);

    // Temporal index
    const tPath = temporalIndexPath(memoryDir);
    const tIndex = readJsonSafe<TemporalIndex>(tPath, { version: INDEX_VERSION, dates: {} });
    const dateKey = isoDateFromTimestamp(createdAt);
    addPathToSet(tIndex.dates, dateKey, memoryPath);
    writeJsonAtomic(tPath, tIndex);

    // Tag index
    const gPath = tagIndexPath(memoryDir);
    const gIndex = readJsonSafe<TagIndex>(gPath, { version: INDEX_VERSION, tags: {} });
    for (const tag of tags) {
      if (tag && typeof tag === "string") {
        addPathToSet(gIndex.tags, tag.toLowerCase(), memoryPath);
      }
    }
    writeJsonAtomic(gPath, gIndex);
  } catch {
    // Fail silently
  }
}

/**
 * Remove a memory file from both indexes (called on deletion/archival).
 */
export function deindexMemory(
  memoryDir: string,
  memoryPath: string,
  createdAt: string,
  tags: string[],
): void {
  try {
    ensureStateDir(memoryDir);

    const tPath = temporalIndexPath(memoryDir);
    const tIndex = readJsonSafe<TemporalIndex>(tPath, { version: INDEX_VERSION, dates: {} });
    const dateKey = isoDateFromTimestamp(createdAt);
    removePathFromSet(tIndex.dates, dateKey, memoryPath);
    writeJsonAtomic(tPath, tIndex);

    const gPath = tagIndexPath(memoryDir);
    const gIndex = readJsonSafe<TagIndex>(gPath, { version: INDEX_VERSION, tags: {} });
    for (const tag of tags) {
      if (tag && typeof tag === "string") {
        removePathFromSet(gIndex.tags, tag.toLowerCase(), memoryPath);
      }
    }
    writeJsonAtomic(gPath, gIndex);
  } catch {
    // Fail silently
  }
}

/**
 * Returns true when both index files exist on disk.
 * Used to detect first-time enablement so callers can trigger a full rebuild.
 */
export function indexesExist(memoryDir: string): boolean {
  try {
    return (
      fs.existsSync(temporalIndexPath(memoryDir)) &&
      fs.existsSync(tagIndexPath(memoryDir))
    );
  } catch {
    return false;
  }
}

/**
 * Batch-add multiple memories to both indexes in a single read-modify-write cycle.
 * More efficient than calling indexMemory() per file when adding many at once.
 */
export function indexMemoriesBatch(
  memoryDir: string,
  entries: Array<{ path: string; createdAt: string; tags: string[] }>,
): void {
  if (entries.length === 0) return;
  try {
    ensureStateDir(memoryDir);

    const tPath = temporalIndexPath(memoryDir);
    const tIndex = readJsonSafe<TemporalIndex>(tPath, { version: INDEX_VERSION, dates: {} });

    const gPath = tagIndexPath(memoryDir);
    const gIndex = readJsonSafe<TagIndex>(gPath, { version: INDEX_VERSION, tags: {} });

    for (const entry of entries) {
      const dateKey = isoDateFromTimestamp(entry.createdAt);
      addPathToSet(tIndex.dates, dateKey, entry.path);
      for (const tag of entry.tags) {
        if (tag && typeof tag === "string") {
          addPathToSet(gIndex.tags, tag.toLowerCase(), entry.path);
        }
      }
    }

    writeJsonAtomic(tPath, tIndex);
    writeJsonAtomic(gPath, gIndex);
  } catch {
    // Fail silently
  }
}

/**
 * Query the temporal index for memory paths within a date range (inclusive).
 *
 * @param memoryDir Root memory directory
 * @param fromDate YYYY-MM-DD start date (inclusive)
 * @param toDate YYYY-MM-DD end date (inclusive, defaults to today)
 * @returns Deduplicated set of memory paths, or null if index is unavailable
 */
export function queryByDateRange(
  memoryDir: string,
  fromDate: string,
  toDate?: string,
): Set<string> | null {
  try {
    const tPath = temporalIndexPath(memoryDir);
    if (!fs.existsSync(tPath)) return null;

    const tIndex = readJsonSafe<TemporalIndex>(tPath, { version: INDEX_VERSION, dates: {} });
    const end = toDate ?? new Date().toISOString().slice(0, 10);

    const results = new Set<string>();
    for (const [date, paths] of Object.entries(tIndex.dates)) {
      if (date >= fromDate && date <= end) {
        for (const p of paths) {
          results.add(p);
        }
      }
    }
    return results;
  } catch {
    return null;
  }
}

/**
 * Query the tag index for memory paths matching any of the given tags.
 *
 * @param memoryDir Root memory directory
 * @param tags Tag strings to look up (case-insensitive)
 * @returns Deduplicated set of memory paths, or null if index is unavailable
 */
export function queryByTags(memoryDir: string, tags: string[]): Set<string> | null {
  if (tags.length === 0) return null;
  try {
    const gPath = tagIndexPath(memoryDir);
    if (!fs.existsSync(gPath)) return null;

    const gIndex = readJsonSafe<TagIndex>(gPath, { version: INDEX_VERSION, tags: {} });

    const results = new Set<string>();
    for (const tag of tags) {
      const key = tag.toLowerCase();
      const paths = gIndex.tags[key] ?? [];
      for (const p of paths) {
        results.add(p);
      }
    }
    return results.size > 0 ? results : null;
  } catch {
    return null;
  }
}

/**
 * Extract tags from a prompt for tag-based prefiltering.
 * Looks for hashtag-style tokens (#foo) and parenthesized tag references.
 * Returns lowercase, deduplicated list.
 */
export function extractTagsFromPrompt(prompt: string): string[] {
  const found = new Set<string>();

  // Match #tag style tokens
  const hashMatches = prompt.matchAll(/#([a-zA-Z][\w-]{1,30})/g);
  for (const m of hashMatches) {
    found.add(m[1].toLowerCase());
  }

  return Array.from(found);
}

/**
 * Detect if a prompt is time-sensitive (mentions specific time references).
 * Used to decide whether to activate the temporal prefilter.
 */
export function isTemporalQuery(prompt: string): boolean {
  return /\b(today|yesterday|this week|last week|this month|last month|recent|lately|just now|earlier today|this morning|last night|\d+ days? ago|\d+ hours? ago)\b/i.test(
    prompt,
  );
}

/**
 * Compute a "from date" string (YYYY-MM-DD) for a recency-based temporal query.
 * For "recent" / "lately" returns 7 days ago; for today/yesterday the obvious window.
 */
export function recencyWindowFromPrompt(prompt: string, nowMs: number = Date.now()): string {
  const p = prompt.toLowerCase();
  let daysBack = 7; // default

  if (/\btoday\b/.test(p) || /\bthis morning\b/.test(p)) {
    daysBack = 0; // fromDate = today → window [today, today]
  } else if (/\byesterday\b/.test(p) || /\blast night\b/.test(p)) {
    daysBack = 1; // fromDate = yesterday → window [yesterday, today]
  } else if (/\bthis week\b/.test(p)) {
    daysBack = 7;
  } else if (/\blast week\b/.test(p)) {
    daysBack = 14;
  } else if (/\bthis month\b/.test(p)) {
    daysBack = 31;
  } else if (/\blast month\b/.test(p)) {
    daysBack = 62;
  } else {
    const numMatch = p.match(/(\d{1,5})\s*days?\s*ago/);
    if (numMatch) {
      daysBack = Math.min(365, parseInt(numMatch[1], 10)); // no off-by-one: "3 days ago" → 3
    } else {
      const hrMatch = p.match(/(\d{1,5})\s*hours?\s*ago/);
      if (hrMatch) {
        // Convert hours to days (ceiling); at least 1 day window
        daysBack = Math.max(1, Math.ceil(parseInt(hrMatch[1], 10) / 24));
      }
    }
  }

  const from = new Date(nowMs - daysBack * 24 * 60 * 60 * 1000);
  return from.toISOString().slice(0, 10);
}
