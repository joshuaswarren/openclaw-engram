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
  /** Map from canonical tag string → node metadata */
  tags: Record<string, TagNode | string[]>;
  /** Map from alias string → canonical tags */
  aliases?: Record<string, string[]>;
}

export interface TagNode {
  paths: string[];
  aliases?: string[];
  parents?: string[];
}

const INDEX_VERSION = 1;
const TEMPORAL_INDEX_FILE = "index_time.json";
const TAG_INDEX_FILE = "index_tags.json";
const TAG_INDEX_VERSION = 2;

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
    // Malformed frontmatter — fall back to today so the memory is still indexed.
    // Log a warning to surface data-quality issues without aborting the write.
    console.warn(`[engram] temporal-index: malformed timestamp "${isoString}", falling back to today`);
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

function normalizeTagSegment(segment: string): string {
  return segment
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeCanonicalTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/\s*[>:|.]+\s*/g, "/")
    .replace(/\s*\/\s*/g, "/")
    .split("/")
    .map(normalizeTagSegment)
    .filter(Boolean)
    .join("/");
}

function normalizeAliasKey(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[\/_.:-]+/g, " ")
    .replace(/[-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularizeAlias(alias: string): string | null {
  if (!alias.endsWith("s") || alias.length <= 3) return null;
  return alias.slice(0, -1);
}

function deriveParentTags(canonical: string): string[] {
  const parts = canonical.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let i = parts.length - 1; i > 0; i -= 1) {
    parents.push(parts.slice(0, i).join("/"));
  }
  return parents;
}

function deriveTagAliases(rawTag: string, canonical: string): string[] {
  const aliases = new Set<string>();
  const canonicalAlias = normalizeAliasKey(canonical);
  const rawAlias = normalizeAliasKey(rawTag);
  const leaf = canonical.split("/").at(-1) ?? canonical;
  const leafAlias = normalizeAliasKey(leaf);

  for (const candidate of [canonicalAlias, rawAlias, leafAlias]) {
    if (!candidate) continue;
    aliases.add(candidate);
    const singular = singularizeAlias(candidate);
    if (singular) aliases.add(singular);
  }

  return Array.from(aliases);
}

function normalizeTagIndex(raw: TagIndex | null | undefined): TagIndex {
  const normalized: TagIndex = {
    version: TAG_INDEX_VERSION,
    tags: {},
    aliases: {},
  };

  if (!raw || typeof raw !== "object") {
    return normalized;
  }

  const sourceTags = raw.tags ?? {};
  for (const [rawCanonical, nodeOrPaths] of Object.entries(sourceTags)) {
    const canonical = normalizeCanonicalTag(rawCanonical);
    if (!canonical) continue;
    const node: TagNode = Array.isArray(nodeOrPaths)
      ? { paths: [...new Set(nodeOrPaths)] }
      : {
          paths: Array.isArray(nodeOrPaths?.paths) ? [...new Set(nodeOrPaths.paths)] : [],
          aliases: Array.isArray(nodeOrPaths?.aliases) ? [...new Set(nodeOrPaths.aliases)] : [],
          parents: Array.isArray(nodeOrPaths?.parents) ? [...new Set(nodeOrPaths.parents)] : [],
        };
    const existingNode = normalized.tags[canonical];
    if (existingNode && !Array.isArray(existingNode)) {
      existingNode.paths = [...new Set([...existingNode.paths, ...node.paths])];
      existingNode.aliases = [...new Set([...(existingNode.aliases ?? []), ...(node.aliases ?? [])])];
      existingNode.parents = [...new Set([...(existingNode.parents ?? []), ...(node.parents ?? [])])];
    } else if (Array.isArray(existingNode)) {
      normalized.tags[canonical] = {
        paths: [...new Set([...existingNode, ...node.paths])],
        aliases: [...new Set(node.aliases ?? [])],
        parents: [...new Set(node.parents ?? deriveParentTags(canonical))],
      };
    } else {
      normalized.tags[canonical] = node;
    }
    for (const alias of deriveTagAliases(canonical, canonical)) {
      const list = normalized.aliases![alias] ?? [];
      if (!list.includes(canonical)) list.push(canonical);
      normalized.aliases![alias] = list;
    }
    for (const alias of node.aliases ?? []) {
      const aliasKey = normalizeAliasKey(alias);
      if (!aliasKey) continue;
      const list = normalized.aliases![aliasKey] ?? [];
      if (!list.includes(canonical)) list.push(canonical);
      normalized.aliases![aliasKey] = list;
    }
    const mergedNode = normalized.tags[canonical];
    if (mergedNode && !Array.isArray(mergedNode)) {
      mergedNode.parents = [...new Set(mergedNode.parents ?? deriveParentTags(canonical))];
    }
  }

  for (const [alias, canonicals] of Object.entries(raw.aliases ?? {})) {
    const aliasKey = normalizeAliasKey(alias);
    if (!aliasKey) continue;
    const list = normalized.aliases![aliasKey] ?? [];
    for (const canonical of canonicals ?? []) {
      const normalizedCanonical = normalizeCanonicalTag(canonical);
      if (normalizedCanonical && !list.includes(normalizedCanonical)) {
        list.push(normalizedCanonical);
      }
    }
    normalized.aliases![aliasKey] = list;
  }

  return normalized;
}

function ensureTagNode(index: TagIndex, canonical: string): TagNode {
  const existing = index.tags[canonical];
  if (existing && !Array.isArray(existing)) {
    return existing;
  }
  const created: TagNode = {
    paths: Array.isArray(existing) ? [...new Set(existing)] : [],
    aliases: [],
    parents: deriveParentTags(canonical),
  };
  index.tags[canonical] = created;
  return created;
}

function addTagGraphEntry(index: TagIndex, rawTag: string, memoryPath: string): void {
  const canonical = normalizeCanonicalTag(rawTag);
  if (!canonical) return;
  const node = ensureTagNode(index, canonical);
  if (!node.paths.includes(memoryPath)) {
    node.paths.push(memoryPath);
  }

  for (const alias of deriveTagAliases(rawTag, canonical)) {
    const aliasKey = normalizeAliasKey(alias);
    if (!aliasKey) continue;
    if (!node.aliases?.includes(aliasKey)) {
      node.aliases = [...new Set([...(node.aliases ?? []), aliasKey])];
    }
    const list = index.aliases?.[aliasKey] ?? [];
    if (!list.includes(canonical)) {
      index.aliases![aliasKey] = [...list, canonical];
    }
  }
}

function removeTagGraphEntry(index: TagIndex, rawTag: string, memoryPath: string): void {
  const canonical = normalizeCanonicalTag(rawTag);
  if (!canonical) return;
  const node = index.tags[canonical];
  if (!node || Array.isArray(node)) return;
  node.paths = node.paths.filter((value) => value !== memoryPath);
  if (node.paths.length === 0) {
    delete index.tags[canonical];
  }
}

function expandCanonicalTags(index: TagIndex, rawTags: string[]): string[] {
  const canonicals = new Set<string>();
  for (const rawTag of rawTags) {
    const canonical = normalizeCanonicalTag(rawTag);
    if (canonical && index.tags[canonical]) {
      canonicals.add(canonical);
    }
    const aliasKey = normalizeAliasKey(rawTag);
    for (const resolved of index.aliases?.[aliasKey] ?? []) {
      canonicals.add(resolved);
    }
  }

  const expanded = new Set<string>();
  for (const canonical of canonicals) {
    expanded.add(canonical);
    const node = index.tags[canonical];
    if (node && !Array.isArray(node)) {
      for (const parent of node.parents ?? []) {
        expanded.add(parent);
      }
    }
  }
  return Array.from(expanded);
}

function aliasPhrase(alias: string): string {
  return alias.replace(/\//g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function promptContainsAlias(prompt: string, alias: string): boolean {
  const phrase = aliasPhrase(alias);
  if (!phrase) return false;
  const normalizedPrompt = ` ${normalizeAliasKey(prompt)} `;
  return normalizedPrompt.includes(` ${phrase} `);
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
    const gIndex = normalizeTagIndex(readJsonSafe<TagIndex>(gPath, { version: TAG_INDEX_VERSION, tags: {}, aliases: {} }));
    for (const tag of tags) {
      if (tag && typeof tag === "string") {
        addTagGraphEntry(gIndex, tag, memoryPath);
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
    const gIndex = normalizeTagIndex(readJsonSafe<TagIndex>(gPath, { version: TAG_INDEX_VERSION, tags: {}, aliases: {} }));
    for (const tag of tags) {
      if (tag && typeof tag === "string") {
        removeTagGraphEntry(gIndex, tag, memoryPath);
      }
    }
    writeJsonAtomic(gPath, gIndex);
  } catch {
    // Fail silently
  }
}

/**
 * Reset both index files to empty state.
 * Called before a full-corpus rebuild so stale paths in any surviving index
 * file do not persist after the rebuild completes.
 */
export function clearIndexes(memoryDir: string): void {
  try {
    ensureStateDir(memoryDir);
    writeJsonAtomic(temporalIndexPath(memoryDir), { version: INDEX_VERSION, dates: {} });
    writeJsonAtomic(tagIndexPath(memoryDir), { version: TAG_INDEX_VERSION, tags: {}, aliases: {} });
  } catch {
    // Fail silently — indexes are advisory only
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
    const gIndex = normalizeTagIndex(readJsonSafe<TagIndex>(gPath, { version: TAG_INDEX_VERSION, tags: {}, aliases: {} }));

    for (const entry of entries) {
      const dateKey = isoDateFromTimestamp(entry.createdAt);
      addPathToSet(tIndex.dates, dateKey, entry.path);
      for (const tag of entry.tags) {
        if (tag && typeof tag === "string") {
          addTagGraphEntry(gIndex, tag, entry.path);
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
 * Async version of queryByDateRange — uses non-blocking fs.promises.readFile
 * to avoid blocking the Node.js event loop when index files are large.
 */
export async function queryByDateRangeAsync(
  memoryDir: string,
  fromDate: string,
  toDate?: string,
): Promise<Set<string> | null> {
  try {
    const tPath = temporalIndexPath(memoryDir);
    let raw: string;
    try {
      raw = await fs.promises.readFile(tPath, "utf8");
    } catch {
      return null; // File missing or unreadable
    }
    let tIndex: TemporalIndex;
    try {
      tIndex = JSON.parse(raw) as TemporalIndex;
    } catch {
      tIndex = { version: INDEX_VERSION, dates: {} };
    }
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
 * Async version of queryByTags — uses non-blocking fs.promises.readFile
 * to avoid blocking the Node.js event loop.
 */
export async function queryByTagsAsync(
  memoryDir: string,
  tags: string[],
): Promise<Set<string> | null> {
  if (tags.length === 0) return null;
  try {
    const gPath = tagIndexPath(memoryDir);
    let raw: string;
    try {
      raw = await fs.promises.readFile(gPath, "utf8");
    } catch {
      return null; // File missing or unreadable
    }
    let gIndex: TagIndex;
    try {
      gIndex = normalizeTagIndex(JSON.parse(raw) as TagIndex);
    } catch {
      gIndex = { version: TAG_INDEX_VERSION, tags: {}, aliases: {} };
    }

    return queryByTagsFromIndex(gIndex, tags);
  } catch {
    return null;
  }
}

function queryByTagsFromIndex(index: TagIndex, tags: string[]): Set<string> | null {
  const expandedTags = expandCanonicalTags(index, tags);
  const results = new Set<string>();
  for (const canonical of expandedTags) {
    const nodeOrPaths = index.tags[canonical];
    const paths = Array.isArray(nodeOrPaths) ? nodeOrPaths : (nodeOrPaths?.paths ?? []);
    for (const pathValue of paths) {
      results.add(pathValue);
    }
  }
  return results.size > 0 ? results : null;
}

/**
 * Extract tags from a prompt for tag-based prefiltering.
 * Looks for hashtag-style tokens (#foo).
 * Returns lowercase, deduplicated list.
 */
export function extractTagsFromPrompt(prompt: string): string[] {
  const found = new Set<string>();

  // Match #tag style tokens
  const hashMatches = prompt.matchAll(/#([a-zA-Z][\w-]{1,30})/g);
  for (const m of hashMatches) {
    const canonical = normalizeCanonicalTag(m[1]);
    if (canonical) found.add(canonical);
  }

  return Array.from(found);
}

export async function resolvePromptTagPrefilterAsync(
  memoryDir: string,
  prompt: string,
): Promise<{
  matchedTags: string[];
  expandedTags: string[];
  paths: Set<string> | null;
}> {
  const explicitTags = extractTagsFromPrompt(prompt);
  try {
    const raw = await fs.promises.readFile(tagIndexPath(memoryDir), "utf8");
    const tagIndex = normalizeTagIndex(JSON.parse(raw) as TagIndex);
    const matched = new Set<string>(explicitTags);

    for (const canonical of Object.keys(tagIndex.tags)) {
      if (promptContainsAlias(prompt, canonical)) {
        matched.add(canonical);
      }
    }
    for (const [alias, canonicals] of Object.entries(tagIndex.aliases ?? {})) {
      if (!promptContainsAlias(prompt, alias)) continue;
      for (const canonical of canonicals) {
        matched.add(canonical);
      }
    }

    const expandedTags = expandCanonicalTags(tagIndex, Array.from(matched));
    const paths = queryByTagsFromIndex(tagIndex, expandedTags);
    return {
      matchedTags: Array.from(matched),
      expandedTags,
      paths,
    };
  } catch {
    return { matchedTags: explicitTags, expandedTags: explicitTags, paths: null };
  }
}

/**
 * Detect if a prompt is time-sensitive (mentions specific time references).
 * Used to decide whether to activate the temporal prefilter.
 */
export function isTemporalQuery(prompt: string): boolean {
  return /\b(today|yesterday|this week|last week|this month|last month|recent(?:ly)?|lately|just now|earlier today|this morning|last night|last year|this year|\d+ days? ago|\d+ hours? ago|\d+ weeks? ago|\d+ months? ago|(?:in |on |during |since |before |after )?(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{1,4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:spring|summer|fall|autumn|winter)\s+\d{4}|on the \d{1,2}(?:st|nd|rd|th)?|last (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(
    prompt,
  );
}

/**
 * Compute a "from date" string (YYYY-MM-DD) for a recency-based temporal query.
 * For "recent" / "lately" returns 7 days ago; for today/yesterday the obvious window.
 */
export function recencyWindowFromPrompt(prompt: string, nowMs: number = Date.now()): string {
  const p = prompt.toLowerCase();
  const now = new Date(nowMs);
  let daysBack = 7; // default

  if (/\btoday\b/.test(p) || /\bthis morning\b/.test(p) || /\bjust now\b/.test(p) || /\bearlier today\b/.test(p)) {
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
  } else if (/\bthis year\b/.test(p)) {
    // From Jan 1 of current year
    const jan1 = new Date(now.getFullYear(), 0, 1);
    return jan1.toISOString().slice(0, 10);
  } else if (/\blast year\b/.test(p)) {
    const jan1LastYear = new Date(now.getFullYear() - 1, 0, 1);
    return jan1LastYear.toISOString().slice(0, 10);
  } else {
    // Try specific month references: "in March", "during January", "since February"
    const monthNames = ["january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december"];
    const monthMatch = p.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/);
    if (monthMatch) {
      const monthIdx = monthNames.indexOf(monthMatch[1]);
      const year = monthMatch[2] ? parseInt(monthMatch[2], 10) : now.getFullYear();
      const monthStart = new Date(year, monthIdx, 1);
      return monthStart.toISOString().slice(0, 10);
    }

    // Try "N weeks ago"
    const weekMatch = p.match(/(\d{1,5})\s*weeks?\s*ago/);
    if (weekMatch) {
      daysBack = Math.min(365, parseInt(weekMatch[1], 10) * 7);
    } else {
      // Try "N months ago"
      const monthsAgoMatch = p.match(/(\d{1,5})\s*months?\s*ago/);
      if (monthsAgoMatch) {
        daysBack = Math.min(730, parseInt(monthsAgoMatch[1], 10) * 31);
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
    }

    // Try explicit date patterns: YYYY-MM-DD or MM/DD/YYYY
    const isoMatch = p.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }
    const usMatch = p.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (usMatch) {
      const year = usMatch[3].length === 2 ? 2000 + parseInt(usMatch[3], 10) : parseInt(usMatch[3], 10);
      return `${year}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
    }

    // Try "last Monday/Tuesday/etc"
    const dayOfWeekMatch = p.match(/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if (dayOfWeekMatch) {
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const targetDay = dayNames.indexOf(dayOfWeekMatch[1]);
      const currentDay = now.getDay();
      daysBack = ((currentDay - targetDay + 7) % 7) || 7; // at least 7 days back
    }
  }

  const from = new Date(nowMs - daysBack * 24 * 60 * 60 * 1000);
  return from.toISOString().slice(0, 10);
}

/**
 * Returns both the start and end of the temporal window implied by the prompt.
 *
 * Mirrors the pattern-matching in `recencyWindowFromPrompt` so both window edges
 * are always computed by the same logic, preventing divergence between `fromDate`
 * and `toDate`.
 *
 * - `fromDate`: first day of the implied window (same as `recencyWindowFromPrompt`)
 * - `toDate`: last day of the implied window; defaults to today for open-ended prompts
 */
export function recencyWindowBoundsFromPrompt(
  prompt: string,
  nowMs: number = Date.now(),
): { fromDate: string; toDate: string } {
  const fromDate = recencyWindowFromPrompt(prompt, nowMs);
  const p = prompt.toLowerCase();
  const now = new Date(nowMs);
  const today = now.toISOString().slice(0, 10);

  let toDate: string;

  if (/\btoday\b|\bthis morning\b|\bjust now\b|\bearlier today\b/.test(p)) {
    toDate = today;
  } else if (/\byesterday\b|\blast night\b/.test(p)) {
    toDate = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
  } else if (/\bthis week\b|\bthis month\b|\bthis year\b/.test(p)) {
    toDate = today;
  } else if (/\blast week\b/.test(p)) {
    toDate = new Date(nowMs - 7 * 86_400_000).toISOString().slice(0, 10);
  } else if (/\blast month\b/.test(p)) {
    toDate = new Date(nowMs - 31 * 86_400_000).toISOString().slice(0, 10);
  } else if (/\blast year\b/.test(p)) {
    toDate = `${now.getFullYear() - 1}-12-31`;
  } else {
    const monthNames = ["january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december"];
    const monthMatch = p.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/);
    if (monthMatch) {
      const monthIdx = monthNames.indexOf(monthMatch[1]);
      const year = monthMatch[2] ? parseInt(monthMatch[2], 10) : now.getFullYear();
      // Day 0 of next month = last day of matched month
      toDate = new Date(year, monthIdx + 1, 0).toISOString().slice(0, 10);
    } else {
      const weekMatch = p.match(/(\d{1,5})\s*weeks?\s*ago/);
      if (weekMatch) {
        const n = Math.min(52, parseInt(weekMatch[1], 10));
        toDate = new Date(nowMs - Math.max(0, n - 1) * 7 * 86_400_000).toISOString().slice(0, 10);
      } else {
        const monthsAgoMatch = p.match(/(\d{1,5})\s*months?\s*ago/);
        if (monthsAgoMatch) {
          const n = Math.min(24, parseInt(monthsAgoMatch[1], 10));
          toDate = new Date(nowMs - Math.max(0, n - 1) * 31 * 86_400_000).toISOString().slice(0, 10);
        } else {
          const numMatch = p.match(/(\d{1,5})\s*days?\s*ago/);
          if (numMatch) {
            const n = Math.min(365, parseInt(numMatch[1], 10));
            toDate = new Date(nowMs - n * 86_400_000).toISOString().slice(0, 10);
          } else if (/(\d{1,5})\s*hours?\s*ago/.test(p)) {
            toDate = today; // sub-day precision not tracked
          } else {
            // Try explicit date patterns (same as recencyWindowFromPrompt)
            const isoMatch = p.match(/(\d{4})-(\d{2})-(\d{2})/);
            if (isoMatch) {
              toDate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
            } else {
              const usMatch = p.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
              if (usMatch) {
                const year = usMatch[3].length === 2 ? 2000 + parseInt(usMatch[3], 10) : parseInt(usMatch[3], 10);
                toDate = `${year}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
              } else {
                const dayOfWeekMatch = p.match(/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
                if (dayOfWeekMatch) {
                  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
                  const targetDay = dayNames.indexOf(dayOfWeekMatch[1]);
                  const currentDay = now.getDay();
                  const daysBack = ((currentDay - targetDay + 7) % 7) || 7;
                  toDate = new Date(nowMs - daysBack * 86_400_000).toISOString().slice(0, 10);
                } else {
                  toDate = today; // open-ended default
                }
              }
            }
          }
        }
      }
    }
  }

  // Guard: if toDate would precede fromDate (inverted window from conflicting keywords),
  // fall back to today so we never produce an empty window.
  if (toDate < fromDate) toDate = today;

  return { fromDate, toDate };
}
