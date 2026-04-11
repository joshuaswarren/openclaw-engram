import { access, readdir, readFile, stat, writeFile, mkdir, unlink, rename, appendFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { log } from "./logger.js";
import { getCachedEntities, setCachedEntities } from "./memory-cache.js";
import { rotateMarkdownFileToArchive } from "./hygiene.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import type {
  AccessTrackingEntry,
  BufferState,
  ConfidenceTier,
  ContinuityIncidentCloseInput,
  ContinuityIncidentOpenInput,
  ContinuityIncidentRecord,
  ContinuityImprovementLoop,
  ContinuityLoopReviewInput,
  ContinuityLoopUpsertInput,
  EntityActivityEntry,
  EntityFile,
  EntityRelationship,
  ImportanceLevel,
  ImportanceScore,
  MemoryCategory,
  MemoryFile,
  MemoryFrontmatter,
  MemoryLink,
  LifecycleState,
  VerificationState,
  PolicyClass,
  MemoryStatus,
  MemoryActionEvent,
  MemoryLifecycleEvent,
  MemoryLifecycleEventType,
  MemoryLifecycleStateSummary,
  MemoryProjectionCurrentState,
  BehaviorSignalEvent,
  MemorySummary,
  MetaState,
  CompressionGuidelineOptimizerState,
  PluginConfig,
  ScoredEntity,
  TopicScore,
  FileHygieneConfig,
} from "./types.js";
import { confidenceTier, SPECULATIVE_TTL_DAYS } from "./types.js";
import {
  type ProjectedMemoryBrowseOptions,
  type ProjectedMemoryBrowsePage,
  readProjectedMemoryState,
  readProjectedMemoryBrowse,
  readProjectedGovernanceRecord,
  readProjectedMemoryTimeline,
} from "./memory-projection-store.js";
import {
  inferMemoryStatus,
  isArchivedMemoryPath,
  sortMemoryLifecycleEvents,
  toMemoryPathRel,
} from "./memory-lifecycle-ledger-utils.js";
import {
  normalizeProjectionPreview,
  normalizeProjectionTags,
} from "./memory-projection-format.js";
import {
  closeContinuityIncidentRecord,
  createContinuityIncidentRecord,
  parseContinuityIncident,
  parseContinuityImprovementLoops,
  reviewContinuityLoopInMarkdown,
  serializeContinuityIncident,
  upsertContinuityLoopInMarkdown,
} from "./identity-continuity.js";
// stripCitation import removed: legacy rebuild fallback was replaced by a
// skip-with-warning strategy (Finding 1 — Uhol).  See ensureFactHashIndexAuthoritative.

const ARTIFACT_SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

export interface ReextractJobRequest {
  memoryId: string;
  model: string;
  requestedAt: string;
  source: "cli-migrate";
}

export interface MemoryLifecycleEventWriteOptions {
  at?: Date;
  actor?: string;
  reasonCode?: string;
  ruleVersion?: string;
  relatedMemoryIds?: string[];
  correlationId?: string;
}

function tokenizeArtifactSearchText(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !ARTIFACT_SEARCH_STOPWORDS.has(t));
}

function serializeFrontmatter(fm: MemoryFrontmatter): string {
  const lines = [
    "---",
    `id: ${fm.id}`,
    `category: ${fm.category}`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    `source: ${fm.source}`,
    `confidence: ${fm.confidence}`,
    `confidenceTier: ${fm.confidenceTier}`,
    `tags: [${fm.tags.map((t) => `"${t}"`).join(", ")}]`,
  ];
  if (fm.entityRef) lines.push(`entityRef: ${fm.entityRef}`);
  if (fm.supersedes) lines.push(`supersedes: ${fm.supersedes}`);
  if (fm.expiresAt) lines.push(`expiresAt: ${fm.expiresAt}`);
  if (fm.lineage && fm.lineage.length > 0) {
    lines.push(`lineage: [${fm.lineage.map((l) => `"${l}"`).join(", ")}]`);
  }
  // Status management
  if (fm.status && fm.status !== "active") lines.push(`status: ${fm.status}`);
  if (fm.supersededBy) lines.push(`supersededBy: ${fm.supersededBy}`);
  if (fm.supersededAt) lines.push(`supersededAt: ${fm.supersededAt}`);
  if (fm.archivedAt) lines.push(`archivedAt: ${fm.archivedAt}`);
  // Lifecycle policy fields
  if (fm.lifecycleState) lines.push(`lifecycleState: ${fm.lifecycleState}`);
  if (fm.verificationState) lines.push(`verificationState: ${fm.verificationState}`);
  if (fm.policyClass) lines.push(`policyClass: ${fm.policyClass}`);
  if (fm.lastValidatedAt) lines.push(`lastValidatedAt: ${fm.lastValidatedAt}`);
  if (fm.decayScore !== undefined) lines.push(`decayScore: ${fm.decayScore}`);
  if (fm.heatScore !== undefined) lines.push(`heatScore: ${fm.heatScore}`);
  // Access tracking
  if (fm.accessCount !== undefined && fm.accessCount > 0) {
    lines.push(`accessCount: ${fm.accessCount}`);
  }
  if (fm.lastAccessed) lines.push(`lastAccessed: ${fm.lastAccessed}`);
  // Importance scoring
  if (fm.importance) {
    lines.push(`importanceScore: ${fm.importance.score}`);
    lines.push(`importanceLevel: ${fm.importance.level}`);
    if (fm.importance.reasons.length > 0) {
      lines.push(
        `importanceReasons: [${fm.importance.reasons
          .map((r) => `"${r.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
          .join(", ")}]`,
      );
    }
    if (fm.importance.keywords.length > 0) {
      lines.push(`importanceKeywords: [${fm.importance.keywords.map((k) => `"${k}"`).join(", ")}]`);
    }
  }
  // Chunking (Phase 2A)
  if (fm.parentId) lines.push(`parentId: ${fm.parentId}`);
  if (fm.chunkIndex !== undefined) lines.push(`chunkIndex: ${fm.chunkIndex}`);
  if (fm.chunkTotal !== undefined) lines.push(`chunkTotal: ${fm.chunkTotal}`);
  // Memory Linking (Phase 3A)
  if (fm.links && fm.links.length > 0) {
    lines.push("links:");
    for (const link of fm.links) {
      lines.push(`  - targetId: ${link.targetId}`);
      lines.push(`    linkType: ${link.linkType}`);
      lines.push(`    strength: ${link.strength}`);
      if (link.reason) lines.push(`    reason: ${JSON.stringify(link.reason)}`);
    }
  }
  if (fm.intentGoal) lines.push(`intentGoal: ${fm.intentGoal}`);
  if (fm.intentActionType) lines.push(`intentActionType: ${fm.intentActionType}`);
  if (fm.intentEntityTypes && fm.intentEntityTypes.length > 0) {
    lines.push(`intentEntityTypes: [${fm.intentEntityTypes.map((t) => `"${t}"`).join(", ")}]`);
  }
  if (fm.artifactType) lines.push(`artifactType: ${fm.artifactType}`);
  if (fm.sourceMemoryId) lines.push(`sourceMemoryId: ${fm.sourceMemoryId}`);
  if (fm.sourceTurnId) lines.push(`sourceTurnId: ${fm.sourceTurnId}`);
  // v8.0 Phase 2B: HiMem episode/note classification
  if (fm.memoryKind) lines.push(`memoryKind: ${fm.memoryKind}`);
  // Structured attributes (stored as JSON on a single line)
  if (fm.structuredAttributes && Object.keys(fm.structuredAttributes).length > 0) {
    lines.push(`structuredAttributes: ${JSON.stringify(fm.structuredAttributes)}`);
  }
  // Raw-content dedup hash — format-agnostic archive/consolidation cleanup
  if (fm.contentHash) lines.push(`contentHash: ${fm.contentHash}`);
  lines.push("---");
  return lines.join("\n");
}

function parseStructuredAttributes(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === "string" && typeof v === "string") {
          result[k] = v;
        }
      }
      return Object.keys(result).length > 0 ? result : undefined;
    }
  } catch {
    // Not valid JSON — ignore
  }
  return undefined;
}

function parseLinkReasonValue(rawValue: string): string {
  const legacyValue = rawValue.replace(/\\"/g, '"');
  const looksLikeLegacyPath =
    !rawValue.includes("\\\\") &&
    (/[A-Za-z]:\\[A-Za-z0-9._ -]+(?:\\[A-Za-z0-9._ -]+)*/.test(rawValue) ||
      /\\[A-Za-z0-9._ -]+\\[A-Za-z0-9._ -]+/.test(rawValue));

  if (looksLikeLegacyPath) {
    return legacyValue;
  }

  try {
    return JSON.parse(`"${rawValue}"`) as string;
  } catch {
    return legacyValue;
  }
}

function parseFrontmatter(
  raw: string,
): { frontmatter: MemoryFrontmatter; content: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;

  const fmBlock = match[1];
  const content = match[2].trim();
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

  let intentEntityTypes: string[] | undefined;
  const intentEntityTypesStr = fm.intentEntityTypes ?? "";
  const intentEntityTypesMatch = intentEntityTypesStr.match(/\[(.*)]/);
  if (intentEntityTypesMatch) {
    intentEntityTypes = intentEntityTypesMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  const conf = parseFloat(fm.confidence ?? "0.8");

  // Parse lineage array if present
  let lineage: string[] | undefined;
  const lineageStr = fm.lineage ?? "";
  const lineageMatch = lineageStr.match(/\[(.*)]/);
  if (lineageMatch) {
    lineage = lineageMatch[1]
      .split(",")
      .map((l) => l.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  // Parse accessCount
  const accessCount = fm.accessCount ? parseInt(fm.accessCount, 10) : undefined;
  const decayScore = fm.decayScore !== undefined ? parseFloat(fm.decayScore) : undefined;
  const heatScore = fm.heatScore !== undefined ? parseFloat(fm.heatScore) : undefined;

  // Parse importance
  let importance: ImportanceScore | undefined;
  if (fm.importanceScore) {
    const score = parseFloat(fm.importanceScore);
    const level = (fm.importanceLevel as ImportanceLevel) || "normal";

    // Parse importance reasons array
    let reasons: string[] = [];
    const reasonsStr = fm.importanceReasons ?? "";
    if (reasonsStr.trim().startsWith("[") && reasonsStr.trim().endsWith("]")) {
      const reasonMatches = reasonsStr.matchAll(/"((?:\\.|[^"\\])*)"/g);
      for (const match of reasonMatches) {
        const reason = parseLinkReasonValue(match[1]);
        if (reason.length > 0) {
          reasons.push(reason);
        }
      }
    }

    // Parse importance keywords array
    let keywords: string[] = [];
    const keywordsStr = fm.importanceKeywords ?? "";
    const keywordsMatch = keywordsStr.match(/\[(.*)]/);
    if (keywordsMatch) {
      keywords = keywordsMatch[1]
        .split(",")
        .map((k) => k.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
    }

    importance = { score, level, reasons, keywords };
  }

  const result: { frontmatter: MemoryFrontmatter; content: string } = {
    frontmatter: {
      id: fm.id ?? "",
      category: (fm.category ?? "fact") as MemoryCategory,
      created: fm.created ?? new Date().toISOString(),
      updated: fm.updated ?? new Date().toISOString(),
      source: fm.source ?? "unknown",
      confidence: conf,
      confidenceTier: (fm.confidenceTier as ConfidenceTier) || confidenceTier(conf),
      tags,
      entityRef: fm.entityRef || undefined,
      supersedes: fm.supersedes || undefined,
      expiresAt: fm.expiresAt || undefined,
      lineage: lineage && lineage.length > 0 ? lineage : undefined,
      // Status management
      status: (fm.status as MemoryStatus) || "active",
      supersededBy: fm.supersededBy || undefined,
      supersededAt: fm.supersededAt || undefined,
      archivedAt: fm.archivedAt || undefined,
      lifecycleState: (fm.lifecycleState as LifecycleState) || undefined,
      verificationState: (fm.verificationState as VerificationState) || undefined,
      policyClass: (fm.policyClass as PolicyClass) || undefined,
      lastValidatedAt: fm.lastValidatedAt || undefined,
      decayScore: Number.isFinite(decayScore) ? decayScore : undefined,
      heatScore: Number.isFinite(heatScore) ? heatScore : undefined,
      // Access tracking
      accessCount: accessCount && accessCount > 0 ? accessCount : undefined,
      lastAccessed: fm.lastAccessed || undefined,
      // Importance scoring
      importance,
      // Chunking
      parentId: fm.parentId || undefined,
      chunkIndex: fm.chunkIndex ? parseInt(fm.chunkIndex, 10) : undefined,
      chunkTotal: fm.chunkTotal ? parseInt(fm.chunkTotal, 10) : undefined,
      // Links are parsed separately below
      intentGoal: fm.intentGoal || undefined,
      intentActionType: fm.intentActionType || undefined,
      intentEntityTypes: intentEntityTypes && intentEntityTypes.length > 0 ? intentEntityTypes : undefined,
      artifactType: (fm.artifactType as MemoryFrontmatter["artifactType"]) || undefined,
      sourceMemoryId: fm.sourceMemoryId || undefined,
      sourceTurnId: fm.sourceTurnId || undefined,
      // v8.0 Phase 2B: HiMem episode/note classification
      memoryKind: (fm.memoryKind as MemoryFrontmatter["memoryKind"]) || undefined,
      // Structured attributes (JSON on a single line)
      structuredAttributes: parseStructuredAttributes(fm.structuredAttributes),
      // Raw-content dedup hash (format-agnostic archive/consolidation cleanup)
      contentHash: fm.contentHash || undefined,
    },
    content,
  };

  // Parse links (YAML array format)
  // Note: Simple parsing - for full YAML we'd need a library.
  if (fmBlock.includes("links:")) {
    const links: MemoryLink[] = [];
    const linkMatches = fmBlock.matchAll(
      /- targetId: (\S+)\s+linkType: (\S+)\s+strength: ([\d.]+)(?:\s+reason: "((?:\\.|[^"\\])*)")?/g,
    );
    for (const match of linkMatches) {
      links.push({
        targetId: match[1],
        linkType: match[2] as MemoryLink["linkType"],
        strength: parseFloat(match[3]),
        reason: match[4] ? parseLinkReasonValue(match[4]) : undefined,
      });
    }
    if (links.length > 0) {
      result.frontmatter.links = links;
    }
  }

  return result;
}

function normalizeFrontmatterForPath(frontmatter: MemoryFrontmatter, pathRel: string): MemoryFrontmatter {
  if (isArchivedMemoryPath(pathRel) && (!frontmatter.status || frontmatter.status === "active")) {
    return {
      ...frontmatter,
      status: "archived",
    };
  }

  return frontmatter;
}

function inferCurrentStateStatus(
  frontmatter: MemoryFrontmatter,
  pathRel: string,
  fallbackStatus: MemoryStatus,
): MemoryStatus {
  return inferMemoryStatus(frontmatter, pathRel, fallbackStatus);
}

/**
 * Entity alias table loaded from the user's local config.
 * Populated by StorageManager.loadAliases() at startup.
 * Falls back to built-in structural aliases (e.g. "open-claw" → "openclaw").
 */
let userAliases: Record<string, string> = {};

/** Built-in aliases for common structural normalizations (no personal data) */
const BUILTIN_ALIASES: Record<string, string> = {
  openclaw: "openclaw",
  "open-claw": "openclaw",
};

/**
 * Normalize an entity name to a canonical form.
 * Strips non-alphanumeric chars, collapses hyphens, removes type prefix duplication.
 * e.g. "My Project" → "my-project"
 *
 * Checks user-defined aliases (from config/aliases.json) first, then built-in aliases.
 */
export function normalizeEntityName(raw: string, type: string): string {
  // Strip type prefix if present (e.g. name="person-jane-doe", type="person")
  const rawStr = typeof raw === "string" ? raw : "";
  const typeStr = typeof type === "string" && type.trim().length > 0 ? type : "entity";

  let name = rawStr.toLowerCase().trim();
  const typePrefix = `${typeStr.toLowerCase()}-`;
  if (name.startsWith(typePrefix)) {
    name = name.slice(typePrefix.length);
  }

  // Replace non-alphanumeric with hyphens, collapse multiples, trim edges
  let normalized = name
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // Check user aliases first, then built-in
  if (userAliases[normalized]) {
    normalized = userAliases[normalized];
  } else if (BUILTIN_ALIASES[normalized]) {
    normalized = BUILTIN_ALIASES[normalized];
  }

  return `${typeStr.toLowerCase()}-${normalized}`;
}

/**
 * Simple Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Strip hyphens from a string for loose comparison */
function dehyphenate(s: string): string {
  return s.replace(/-/g, "");
}

/**
 * Content-hash dedup index for facts.
 * Normalizes content (lowercase, strip punctuation, collapse whitespace),
 * computes SHA-256, and stores hashes in a line-delimited file.
 * Prevents writing semantically identical facts.
 */
export class ContentHashIndex {
  private hashes: Set<string> = new Set();
  private dirty = false;
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "fact-hashes.txt");
  }

  /** Load existing hashes from disk. Safe to call multiple times. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          this.hashes.add(trimmed);
        }
      }
      log.debug(`content-hash index: loaded ${this.hashes.size} hashes`);
    } catch {
      log.debug("content-hash index: no existing index — starting fresh");
    }
  }

  /** Check if content already exists in the index. */
  has(content: string): boolean {
    return this.hashes.has(ContentHashIndex.computeHash(content));
  }

  /** Add content hash to the index. */
  add(content: string): void {
    const hash = ContentHashIndex.computeHash(content);
    if (!this.hashes.has(hash)) {
      this.hashes.add(hash);
      this.dirty = true;
    }
  }

  get size(): number {
    return this.hashes.size;
  }

  /** Persist index to disk if changed. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, [...this.hashes].join("\n") + "\n", "utf-8");
    this.dirty = false;
    log.debug(`content-hash index: saved ${this.hashes.size} hashes`);
  }

  /** Remove a hash from the index (used when archiving/deleting). */
  remove(content: string): void {
    const hash = ContentHashIndex.computeHash(content);
    if (this.hashes.delete(hash)) {
      this.dirty = true;
    }
  }

  /**
   * Remove a pre-computed SHA-256 hash directly from the index without
   * re-hashing.  Use this when the caller already holds the stored hash
   * (e.g. `memory.frontmatter.contentHash`) to avoid the double-hash bug
   * where `remove(hash)` would compute `hash(hash)` and never match the
   * entry.
   */
  removeByHash(hash: string): void {
    if (this.hashes.delete(hash)) {
      this.dirty = true;
    }
  }

  /**
   * Add a pre-computed SHA-256 hash directly to the index without re-hashing.
   * Use this when the caller already holds the stored hash
   * (e.g. `memory.frontmatter.contentHash`) so that the index records the raw
   * content hash rather than re-hashing the citation-annotated body.
   *
   * @internal Only called from `StorageManager.ensureFactHashIndexAuthoritative`.
   * Not part of the public API — prefer `add(content)` for external callers.
   */
  addByHash(hash: string): void {
    if (!this.hashes.has(hash)) {
      this.hashes.add(hash);
      this.dirty = true;
    }
  }

  /** Normalize content and compute SHA-256 hash. */
  static normalizeContent(content: string): string {
    return content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Normalize content and compute SHA-256 hash. */
  static computeHash(content: string): string {
    const normalized = ContentHashIndex.normalizeContent(content);
    return createHash("sha256").update(normalized).digest("hex");
  }
}

// ---------------------------------------------------------------------------
// Entity file parsing / serialization (Knowledge Graph v7.0)
// ---------------------------------------------------------------------------

/**
 * Parse an entity markdown file into a structured EntityFile.
 * Backward compatible: old files without new sections get empty arrays.
 */
export function parseEntityFile(content: string): EntityFile {
  const lines = content.split("\n");

  // Header
  let name = "";
  let type = "other";
  let updated = "";
  let summary: string | undefined;
  const facts: string[] = [];
  const relationships: EntityRelationship[] = [];
  const activity: EntityActivityEntry[] = [];
  const aliases: string[] = [];

  // Parse name from first heading
  const headingLine = lines.find((l) => l.startsWith("# "));
  if (headingLine) name = headingLine.slice(2).trim();

  // Parse type
  const typeLine = lines.find((l) => l.startsWith("**Type:**"));
  if (typeLine) type = typeLine.replace("**Type:**", "").trim();

  // Parse updated
  const updatedLine = lines.find((l) => l.startsWith("**Updated:**"));
  if (updatedLine) updated = updatedLine.replace("**Updated:**", "").trim();

  // Detect which section we're in
  let section = "";
  for (const line of lines) {
    if (line.startsWith("## ")) {
      section = line.slice(3).trim().toLowerCase();
      continue;
    }
    if (!line.startsWith("- ")) continue;

    const bullet = line.slice(2).trim();
    if (!bullet) continue;

    switch (section) {
      case "facts":
        facts.push(bullet);
        break;
      case "summary":
        // Summary is typically a single line after the heading, not a bullet
        break;
      case "connected to": {
        // Format: [[target-entity]] — relationship label
        const relMatch = bullet.match(/^\[\[([^\]]+)\]\]\s*[—–-]\s*(.+)$/);
        if (relMatch) {
          relationships.push({ target: relMatch[1].trim(), label: relMatch[2].trim() });
        }
        break;
      }
      case "activity": {
        // Format: YYYY-MM-DD: note
        const actMatch = bullet.match(/^(\d{4}-\d{2}-\d{2}):\s*(.+)$/);
        if (actMatch) {
          activity.push({ date: actMatch[1], note: actMatch[2].trim() });
        }
        break;
      }
      case "aliases":
        aliases.push(bullet);
        break;
    }
  }

  // Parse summary: text between ## Summary heading and next ## heading (not bulleted)
  const summaryIdx = lines.findIndex((l) => l.startsWith("## Summary"));
  if (summaryIdx !== -1) {
    const summaryLines: string[] = [];
    for (let i = summaryIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) break;
      const trimmed = lines[i].trim();
      if (trimmed) summaryLines.push(trimmed);
    }
    if (summaryLines.length > 0) summary = summaryLines.join(" ");
  }

  return { name, type, updated, facts, summary, relationships, activity, aliases };
}

/**
 * Serialize an EntityFile back to markdown.
 * Only emits sections that have content (except Facts which is always emitted).
 */
export function serializeEntityFile(entity: EntityFile): string {
  const lines: string[] = [
    `# ${entity.name}`,
    "",
    `**Type:** ${entity.type}`,
    `**Updated:** ${entity.updated || new Date().toISOString()}`,
    "",
  ];

  // Summary (optional)
  if (entity.summary) {
    lines.push("## Summary", "", entity.summary, "");
  }

  // Facts (always emitted)
  lines.push("## Facts", "");
  for (const f of entity.facts) {
    lines.push(`- ${f}`);
  }
  lines.push("");

  // Connected to (optional)
  if (entity.relationships.length > 0) {
    lines.push("## Connected to", "");
    for (const rel of entity.relationships) {
      lines.push(`- [[${rel.target}]] — ${rel.label}`);
    }
    lines.push("");
  }

  // Activity (optional)
  if (entity.activity.length > 0) {
    lines.push("## Activity", "");
    for (const act of entity.activity) {
      lines.push(`- ${act.date}: ${act.note}`);
    }
    lines.push("");
  }

  // Aliases (optional)
  if (entity.aliases.length > 0) {
    lines.push("## Aliases", "");
    for (const alias of entity.aliases) {
      lines.push(`- ${alias}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export class StorageManager {
  private knowledgeIndexCache: { result: string; builtAt: number } | null = null;
  private static readonly KNOWLEDGE_INDEX_CACHE_TTL_MS = 600_000; // 10 minutes (entity mutations invalidate)
  private artifactIndexCache: { memories: MemoryFile[]; loadedAtMs: number; writeVersion: number } | null = null;
  private static readonly ARTIFACT_INDEX_CACHE_TTL_MS = 60_000; // 1 minute
  private static readonly artifactWriteVersionByDir = new Map<string, number>();
  private static readonly memoryStatusVersionByDir = new Map<string, number>();

  // Module-level cache for readAllMemories() keyed by base directory.
  // Shared across all StorageManager instances to avoid duplicate I/O when
  // multiple concurrent callers (e.g. verifiedRecall + verifiedRules) read the
  // same directory simultaneously.  In-flight deduplication prevents multiple
  // concurrent reads of the same directory.
  //
  // Stale-while-revalidate: once the cache has a value, subsequent reads after
  // TTL expiry return the stale cached data immediately and kick off a background
  // refresh.  This eliminates the 13-60 s cold-scan penalty that would otherwise
  // block recall requests every 5 minutes on large memory collections (80k+ files).
  private static readonly allMemoriesInFlight = new Map<string, Promise<MemoryFile[]>>();

  // Cache for readQuestions() — avoids serially re-reading tens of thousands of
  // question files on every recall.  60-second TTL is intentionally short so that
  // newly written questions surface quickly.
  private static readonly QUESTIONS_CACHE_TTL_MS = 60_000; // 1 minute
  private static readonly questionsCache = new Map<
    string,
    {
      questions: Array<{
        id: string;
        question: string;
        context: string;
        priority: number;
        resolved: boolean;
        created: string;
        filePath: string;
      }>;
      loadedAt: number;
    }
  >();
  private factHashIndex: ContentHashIndex | null = null;
  private factHashIndexLoadPromise: Promise<ContentHashIndex> | null = null;
  private factHashIndexAuthoritative: boolean | null = null;
  private factHashIndexAuthoritativePromise: Promise<void> | null = null;

  constructor(private readonly baseDir: string) {}

  /** The root directory of this storage instance. */
  get dir(): string {
    return this.baseDir;
  }

  private identityFilePath(workspaceDir: string, namespace?: string): string {
    const rawNamespace = typeof namespace === "string" ? namespace.trim() : "";
    if (!rawNamespace) return path.join(workspaceDir, "IDENTITY.md");
    const safeNamespace = rawNamespace.replace(/[^a-zA-Z0-9._-]/g, "-");
    return path.join(workspaceDir, `IDENTITY.${safeNamespace}.md`);
  }

  private versionFilePath(kind: "memory-status" | "artifact-write"): string {
    const fileName =
      kind === "memory-status" ? ".memory-status-version.log" : ".artifact-write-version.log";
    return path.join(this.stateDir, fileName);
  }

  private bumpSharedVersion(
    kind: "memory-status" | "artifact-write",
    fallbackMap: Map<string, number>,
  ): number {
    const filePath = this.versionFilePath(kind);
    try {
      mkdirSync(this.stateDir, { recursive: true });
      appendFileSync(filePath, "x");
      const next = statSync(filePath).size;
      fallbackMap.set(this.baseDir, next);
      return next;
    } catch {
      const next = (fallbackMap.get(this.baseDir) ?? 0) + 1;
      fallbackMap.set(this.baseDir, next);
      return next;
    }
  }

  private readSharedVersion(
    kind: "memory-status" | "artifact-write",
    fallbackMap: Map<string, number>,
  ): number {
    const filePath = this.versionFilePath(kind);
    try {
      return statSync(filePath).size;
    } catch {
      return fallbackMap.get(this.baseDir) ?? 0;
    }
  }

  private bumpMemoryStatusVersion(): void {
    this.bumpSharedVersion("memory-status", StorageManager.memoryStatusVersionByDir);
  }

  getMemoryStatusVersion(): number {
    return this.readSharedVersion("memory-status", StorageManager.memoryStatusVersionByDir);
  }

  private bumpArtifactWriteVersion(): number {
    return this.bumpSharedVersion("artifact-write", StorageManager.artifactWriteVersionByDir);
  }

  private getArtifactWriteVersion(): number {
    return this.readSharedVersion("artifact-write", StorageManager.artifactWriteVersionByDir);
  }

  private get factsDir(): string {
    return path.join(this.baseDir, "facts");
  }
  private get correctionsDir(): string {
    return path.join(this.baseDir, "corrections");
  }
  private get entitiesDir(): string {
    return path.join(this.baseDir, "entities");
  }
  private get stateDir(): string {
    return path.join(this.baseDir, "state");
  }
  private get factHashIndexReadyPath(): string {
    return path.join(this.stateDir, "fact-hashes.ready");
  }

  private async getFactHashIndex(): Promise<ContentHashIndex> {
    if (this.factHashIndex) {
      return this.factHashIndex;
    }
    if (!this.factHashIndexLoadPromise) {
      const index = new ContentHashIndex(this.stateDir);
      this.factHashIndexLoadPromise = index
        .load()
        .then(() => {
          this.factHashIndex = index;
          return index;
        })
        .catch((err) => {
          this.factHashIndexLoadPromise = null;
          throw err;
        });
    }
    return this.factHashIndexLoadPromise;
  }

  private async ensureFactHashIndexAuthoritative(): Promise<void> {
    if (this.factHashIndexAuthoritative === true) {
      return;
    }
    if (this.factHashIndexAuthoritativePromise) {
      await this.factHashIndexAuthoritativePromise;
      return;
    }

    this.factHashIndexAuthoritativePromise = (async () => {
      try {
        await access(this.factHashIndexReadyPath);
        this.factHashIndexAuthoritative = true;
        return;
      } catch {
        // Fall through and backfill from the live fact corpus once.
      }

      const factHashIndex = await this.getFactHashIndex();
      const existing = await this.readAllMemories();
      for (const memory of existing) {
        if (memory.frontmatter.category !== "fact") continue;
        if (inferMemoryStatus(memory.frontmatter, memory.path) !== "active") continue;
        // Prefer the pre-computed raw-content hash stored in frontmatter
        // (written since round 8 of issue #369). This hash was derived from
        // the content BEFORE citation annotation, so it matches what
        // hasFactContentHash(rawFact) would compute.
        //
        // SKIP legacy memories that have no contentHash frontmatter (written
        // before this field was introduced) instead of guessing via
        // stripCitation().  stripCitation() only removes the default
        // `[Source: ...]` pattern; if a custom citation template was in use at
        // write time it will produce the wrong hash — worse than a miss
        // (Finding 1 — Uhol).  Callers that rely on authoritative dedup for
        // truly ancient memories should re-extract those facts.
        if (memory.frontmatter.contentHash) {
          factHashIndex.addByHash(memory.frontmatter.contentHash);
        } else {
          log.warn(
            `ensureFactHashIndexAuthoritative: skipping legacy fact ${memory.frontmatter.id ?? "(unknown)"} — no contentHash in frontmatter; re-extract to rebuild dedup index`,
          );
        }
      }
      await factHashIndex.save();
      await mkdir(path.dirname(this.factHashIndexReadyPath), { recursive: true });
      await writeFile(this.factHashIndexReadyPath, "v1\n", "utf-8");
      this.factHashIndexAuthoritative = true;
    })().finally(() => {
      this.factHashIndexAuthoritativePromise = null;
    });
    await this.factHashIndexAuthoritativePromise;
  }
  private get questionsDir(): string {
    return path.join(this.baseDir, "questions");
  }
  private get artifactsDir(): string {
    return path.join(this.baseDir, "artifacts");
  }
  private get identityDir(): string {
    return path.join(this.baseDir, "identity");
  }
  private get identityAnchorPath(): string {
    return path.join(this.identityDir, "identity-anchor.md");
  }
  private get identityIncidentsDir(): string {
    return path.join(this.identityDir, "incidents");
  }
  private get identityAuditsWeeklyDir(): string {
    return path.join(this.identityDir, "audits", "weekly");
  }
  private get identityAuditsMonthlyDir(): string {
    return path.join(this.identityDir, "audits", "monthly");
  }
  private get identityImprovementLoopsPath(): string {
    return path.join(this.identityDir, "improvement-loops.md");
  }
  private get identityReflectionsPath(): string {
    return path.join(this.identityDir, "reflections.md");
  }
  private get profilePath(): string {
    return path.join(this.baseDir, "profile.md");
  }
  private get memoryActionsPath(): string {
    return path.join(this.stateDir, "memory-actions.jsonl");
  }
  private get memoryLifecycleLedgerPath(): string {
    return path.join(this.stateDir, "memory-lifecycle-ledger.jsonl");
  }
  private get compressionGuidelinesPath(): string {
    return path.join(this.stateDir, "compression-guidelines.md");
  }
  private get compressionGuidelineDraftPath(): string {
    return path.join(this.stateDir, "compression-guidelines.draft.md");
  }
  private get compressionGuidelineStatePath(): string {
    return path.join(this.stateDir, "compression-guideline-state.json");
  }
  private get compressionGuidelineDraftStatePath(): string {
    return path.join(this.stateDir, "compression-guideline-draft-state.json");
  }
  private get behaviorSignalsPath(): string {
    return path.join(this.stateDir, "behavior-signals.jsonl");
  }

  /**
   * Load user-defined entity aliases from config/aliases.json in the memory store.
   * File format: { "variant": "canonical", "variant2": "canonical", ... }
   * Call this once at startup (e.g. from orchestrator.initialize()).
   */
  async loadAliases(): Promise<void> {
    const aliasPath = path.join(this.baseDir, "config", "aliases.json");
    try {
      const raw = await readFile(aliasPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        userAliases = parsed as Record<string, string>;
        log.debug(`loaded ${Object.keys(userAliases).length} entity aliases from ${aliasPath}`);
      }
    } catch {
      // No aliases file — that's fine, use built-in only
      log.debug("no config/aliases.json found — using built-in aliases only");
    }
  }

  async ensureDirectories(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await mkdir(path.join(this.factsDir, today), { recursive: true });
    await mkdir(this.correctionsDir, { recursive: true });
    await mkdir(this.entitiesDir, { recursive: true });
    await mkdir(this.stateDir, { recursive: true });
    await mkdir(this.questionsDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
    await mkdir(this.identityDir, { recursive: true });
    await mkdir(this.identityIncidentsDir, { recursive: true });
    await mkdir(this.identityAuditsWeeklyDir, { recursive: true });
    await mkdir(this.identityAuditsMonthlyDir, { recursive: true });
    await mkdir(path.join(this.baseDir, "config"), { recursive: true });
  }

  async writeMemory(
    category: MemoryCategory,
    content: string,
    options: {
      actor?: string;
      confidence?: number;
      tags?: string[];
      entityRef?: string;
      source?: string;
      supersedes?: string;
      lineage?: string[];
      importance?: ImportanceScore;
      links?: MemoryLink[];
      intentGoal?: string;
      intentActionType?: string;
      intentEntityTypes?: string[];
      artifactType?: MemoryFrontmatter["artifactType"];
      sourceMemoryId?: string;
      sourceTurnId?: string;
      memoryKind?: MemoryFrontmatter["memoryKind"];
      expiresAt?: string;
      structuredAttributes?: Record<string, string>;
      /**
       * When provided, this string is used as the source for the fact-content
       * dedup hash index instead of the persisted body (`content`).
       *
       * Use this when the persisted body differs from the canonical fact text
       * — for example when `content` is a citation-annotated variant of a raw
       * fact. Passing the raw fact as `contentHashSource` ensures that
       * `hasFactContentHash(rawFact)` returns `true` after the write, so
       * subsequent extractions of the same logical fact are correctly deduped
       * even when their citation timestamp differs.
       */
      contentHashSource?: string;
    } = {},
  ): Promise<string> {
    await this.ensureDirectories();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const id = `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const conf = options.confidence ?? 0.8;
    const tier = confidenceTier(conf);

    // Auto-set TTL for speculative memories
    let expiresAt: string | undefined;
    if (typeof options.expiresAt === "string" && options.expiresAt.length > 0) {
      expiresAt = options.expiresAt;
    } else if (tier === "speculative") {
      const expiry = new Date(now.getTime() + SPECULATIVE_TTL_DAYS * 24 * 60 * 60 * 1000);
      expiresAt = expiry.toISOString();
    }

    const fm: MemoryFrontmatter = {
      id,
      category,
      created: now.toISOString(),
      updated: now.toISOString(),
      source: options.source ?? "extraction",
      confidence: conf,
      confidenceTier: tier,
      tags: options.tags ?? [],
      entityRef: options.entityRef,
      supersedes: options.supersedes,
      expiresAt,
      lineage: options.lineage,
      importance: options.importance,
      links: options.links,
      intentGoal: options.intentGoal,
      intentActionType: options.intentActionType,
      intentEntityTypes: options.intentEntityTypes,
      artifactType: options.artifactType,
      sourceMemoryId: options.sourceMemoryId,
      sourceTurnId: options.sourceTurnId,
      memoryKind: options.memoryKind,
      structuredAttributes: options.structuredAttributes,
    };

    // Append structured attributes as searchable suffix so QMD indexes them
    let enrichedContent = content;
    if (options.structuredAttributes && Object.keys(options.structuredAttributes).length > 0) {
      const attrLines = Object.entries(options.structuredAttributes)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ");
      enrichedContent = `${content}\n[Attributes: ${attrLines}]`;
    }

    const sanitized = sanitizeMemoryContent(enrichedContent);
    if (!sanitized.clean) {
      log.warn(`memory content sanitized for ${id}; violations=${sanitized.violations.join(", ")}`);
    }

    // Persist the raw-content dedup hash on the frontmatter so archive and
    // consolidation paths can remove the correct hash from ContentHashIndex
    // regardless of what citation format (if any) has been appended to the
    // stored body. Mirrors the logic in the fact-hash-index update below.
    if (category === "fact") {
      const hashSource =
        options.contentHashSource !== undefined && options.contentHashSource.length > 0
          ? sanitizeMemoryContent(options.contentHashSource).text
          : sanitized.text;
      fm.contentHash = ContentHashIndex.computeHash(hashSource);
    }

    const fileContent = `${serializeFrontmatter(fm)}\n\n${sanitized.text}\n`;

    let filePath: string;
    if (category === "correction") {
      filePath = path.join(this.correctionsDir, `${id}.md`);
    } else {
      filePath = path.join(this.factsDir, today, `${id}.md`);
    }

    await writeFile(filePath, fileContent, "utf-8");
    this.invalidateAllMemoriesCache();
    await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.writeMemory", {
      memoryId: id,
      eventType: "created",
      timestamp: fm.created,
      actor: options.actor ?? "storage.writeMemory",
      after: this.summarizeLifecycleState(fm, filePath),
      relatedMemoryIds: [
        ...(options.supersedes ? [options.supersedes] : []),
        ...((options.lineage ?? []).filter(Boolean)),
      ],
    });
    if (category === "fact") {
      try {
        const factHashIndex = await this.getFactHashIndex();
        // When the caller provides a separate contentHashSource (e.g. the raw
        // fact text before citation annotation), index THAT string so that
        // hasFactContentHash(rawFact) returns true on subsequent extractions.
        // Otherwise fall back to the sanitized persisted body as before.
        if (options.contentHashSource !== undefined && options.contentHashSource.length > 0) {
          const hashSourceSanitized = sanitizeMemoryContent(options.contentHashSource);
          factHashIndex.add(hashSourceSanitized.text);
        } else {
          factHashIndex.add(sanitized.text);
        }
        await factHashIndex.save();
      } catch (err) {
        log.warn(`storage.writeMemory completed but failed to update fact hash index: ${err}`);
      }
    }
    log.debug(`wrote memory ${id} to ${filePath}`);
    return id;
  }

  async hasFactContentHash(content: string): Promise<boolean> {
    await this.ensureFactHashIndexAuthoritative();
    const factHashIndex = await this.getFactHashIndex();
    const sanitized = sanitizeMemoryContent(content);
    return factHashIndex.has(sanitized.text);
  }

  async isFactContentHashAuthoritative(): Promise<boolean> {
    await this.ensureFactHashIndexAuthoritative();
    return true;
  }

  async writeArtifact(
    quote: string,
    options: {
      actor?: string;
      tags?: string[];
      confidence?: number;
      artifactType?: MemoryFrontmatter["artifactType"];
      sourceMemoryId?: string;
      sourceTurnId?: string;
      intentGoal?: string;
      intentActionType?: string;
      intentEntityTypes?: string[];
    } = {},
  ): Promise<string> {
    await this.ensureDirectories();
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const dir = path.join(this.artifactsDir, day);
    await mkdir(dir, { recursive: true });

    const id = `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const fm: MemoryFrontmatter = {
      id,
      category: "fact",
      created: now.toISOString(),
      updated: now.toISOString(),
      source: "artifact",
      confidence: options.confidence ?? 0.9,
      confidenceTier: confidenceTier(options.confidence ?? 0.9),
      tags: options.tags ?? [],
      artifactType: options.artifactType ?? "fact",
      sourceMemoryId: options.sourceMemoryId,
      sourceTurnId: options.sourceTurnId,
      intentGoal: options.intentGoal,
      intentActionType: options.intentActionType,
      intentEntityTypes: options.intentEntityTypes,
    };

    const sanitized = sanitizeMemoryContent(quote);
    if (!sanitized.clean) {
      log.warn(`artifact content rejected for ${id}; violations=${sanitized.violations.join(", ")}`);
      return "";
    }
    const filePath = path.join(dir, `${id}.md`);
    await writeFile(filePath, `${serializeFrontmatter(fm)}\n\n${sanitized.text}\n`, "utf-8");
    const actor =
      typeof options.actor === "string" && options.actor.length > 0
        ? options.actor
        : "storage.writeArtifact";
    await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.writeArtifact", {
      memoryId: id,
      eventType: "created",
      timestamp: fm.created,
      actor,
      after: this.summarizeLifecycleState(fm, filePath),
      relatedMemoryIds: options.sourceMemoryId ? [options.sourceMemoryId] : [],
    });
    this.bumpArtifactWriteVersion();
    // Always invalidate on write. This avoids stale mixed snapshots when multiple
    // processes share the same memoryDir and write concurrently.
    this.artifactIndexCache = null;
    return id;
  }

  private async readAllArtifactsCached(): Promise<MemoryFile[]> {
    if (
      this.artifactIndexCache &&
      Date.now() - this.artifactIndexCache.loadedAtMs <= StorageManager.ARTIFACT_INDEX_CACHE_TTL_MS &&
      this.artifactIndexCache.writeVersion === this.getArtifactWriteVersion()
    ) {
      return this.artifactIndexCache.memories;
    }

    const scanArtifacts = async (): Promise<MemoryFile[]> => {
      const artifacts: MemoryFile[] = [];
      const readDir = async (dir: string) => {
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await readDir(fullPath);
              continue;
            }
            if (!entry.name.endsWith(".md")) continue;
            const memory = await this.readMemoryByPath(fullPath);
            if (!memory) continue;
            artifacts.push(memory);
          }
        } catch {
          // Directory doesn't exist yet
        }
      };
      await readDir(this.artifactsDir);
      return artifacts;
    };

    const MAX_REBUILD_RETRIES = 2;
    let latestArtifacts: MemoryFile[] = [];
    for (let attempt = 0; attempt <= MAX_REBUILD_RETRIES; attempt += 1) {
      const versionBefore = this.getArtifactWriteVersion();
      const artifacts = await scanArtifacts();
      const versionAfter = this.getArtifactWriteVersion();
      latestArtifacts = artifacts;
      if (versionAfter === versionBefore) {
        this.artifactIndexCache = { memories: artifacts, loadedAtMs: Date.now(), writeVersion: versionAfter };
        return artifacts;
      }
    }

    // Highly concurrent writer churn; keep cache invalid so next read retries a clean rebuild.
    // Return best-effort latest scan instead of an empty set to avoid dropping recall entirely.
    this.artifactIndexCache = null;
    return latestArtifacts;
  }

  async searchArtifacts(query: string, maxResults: number): Promise<MemoryFile[]> {
    const tokens = tokenizeArtifactSearchText(query);
    if (tokens.length === 0) return [];

    const artifacts = await this.readAllArtifactsCached();
    const hits: Array<{ score: number; memory: MemoryFile }> = [];
    for (const memory of artifacts) {
      const indexedTokens = new Set(
        tokenizeArtifactSearchText(`${memory.content} ${(memory.frontmatter.tags ?? []).join(" ")}`),
      );
      const score = tokens.reduce((sum, t) => sum + (indexedTokens.has(t) ? 1 : 0), 0);
      if (score > 0) {
        hits.push({ score, memory });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, maxResults).map((h) => h.memory);
  }

  async writeEntity(
    name: string,
    type: string,
    facts: string[],
  ): Promise<string> {
    await this.ensureDirectories();
    if (typeof name !== "string" || !name.trim() || typeof type !== "string" || !type.trim()) {
      log.warn("writeEntity: invalid entity payload, skipping", {
        nameType: typeof name,
        typeType: typeof type,
      });
      return "";
    }
    const safeFacts = Array.isArray(facts) ? facts.filter((f) => typeof f === "string") : [];
    let normalized = normalizeEntityName(name, type);

    // Check for fuzzy match against existing entities before creating a new file
    const match = await this.findMatchingEntity(name, type);
    if (match && match !== normalized) {
      log.debug(`fuzzy match: "${normalized}" → existing "${match}"`);
      normalized = match;
    }

    const filePath = path.join(this.entitiesDir, `${normalized}.md`);

    // Parse existing file to preserve relationships/activity/aliases/summary
    let entity: EntityFile = {
      name, type, updated: new Date().toISOString(),
      facts: [], summary: undefined, relationships: [], activity: [], aliases: [],
    };
    try {
      const existing = await readFile(filePath, "utf-8");
      entity = parseEntityFile(existing);
    } catch {
      // File doesn't exist yet
    }

    // Merge facts (dedup)
    entity.facts = [...new Set([...entity.facts, ...safeFacts])];
    entity.name = name;
    entity.type = type;
    entity.updated = new Date().toISOString();

    await writeFile(filePath, serializeEntityFile(entity), "utf-8");
    this.invalidateKnowledgeIndexCache();
    this.bumpMemoryStatusVersion(); // invalidate entity cache
    log.debug(`wrote entity ${normalized}`);
    return normalized;
  }

  async readProfile(): Promise<string> {
    try {
      return await readFile(this.profilePath, "utf-8");
    } catch {
      return "";
    }
  }

  async writeProfile(content: string): Promise<void> {
    await this.ensureDirectories();
    await writeFile(this.profilePath, content, "utf-8");
    log.debug("updated profile.md");
  }

  /**
   * Normalize a string for fuzzy profile dedup: lowercase, strip punctuation, collapse whitespace.
   */
  private static normalizeForDedup(s: string): string {
    if (typeof s !== "string") return "";
    return s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Check if a new bullet is a fuzzy duplicate of any existing bullet.
   * Returns true if the new bullet should be skipped.
   */
  private static isFuzzyDuplicate(newNorm: string, existingNorms: string[]): boolean {
    for (const existing of existingNorms) {
      // Exact normalized match
      if (newNorm === existing) return true;

      // Containment check: shorter must be >60% length of longer
      const shorter = newNorm.length <= existing.length ? newNorm : existing;
      const longer = newNorm.length > existing.length ? newNorm : existing;
      if (shorter.length > 20 && shorter.length / longer.length > 0.6 && longer.includes(shorter)) {
        return true;
      }
    }
    return false;
  }

  async appendToProfile(updates: string[]): Promise<void> {
    // Filter out non-string entries that the LLM may return
    updates = updates.filter((u) => typeof u === "string" && u.trim().length > 0);
    if (updates.length === 0) return;
    const existing = await this.readProfile();

    const lines = existing ? existing.split("\n") : [];
    const existingBulletRaw = lines
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());
    const existingNorms = existingBulletRaw.map(StorageManager.normalizeForDedup);

    const newBullets = updates.filter((u) => {
      const norm = StorageManager.normalizeForDedup(u);
      return !StorageManager.isFuzzyDuplicate(norm, existingNorms);
    });
    if (newBullets.length === 0) return;

    if (!existing) {
      const content = [
        "# Behavioral Profile",
        "",
        `*Last updated: ${new Date().toISOString()}*`,
        "",
        ...newBullets.map((b) => `- ${b}`),
        "",
      ].join("\n");
      await this.writeProfile(content);
    } else {
      const updatedTimestamp = existing.replace(
        /\*Last updated:.*\*/,
        `*Last updated: ${new Date().toISOString()}*`,
      );
      const withBullets = updatedTimestamp.trimEnd() + "\n" + newBullets.map((b) => `- ${b}`).join("\n") + "\n";
      await this.writeProfile(withBullets);
    }
  }

  /** Check if profile.md exceeds the max line cap and needs LLM consolidation */
  async profileNeedsConsolidation(triggerLines?: number): Promise<boolean> {
    const profile = await this.readProfile();
    if (!profile) return false;
    const lineCount = profile.split("\n").length;
    const threshold = typeof triggerLines === "number"
      ? Math.max(0, Math.floor(triggerLines))
      : StorageManager.PROFILE_MAX_LINES;
    return lineCount > threshold;
  }

  async readAllMemories(): Promise<MemoryFile[]> {
    // Deduplicate concurrent reads for the same directory so multiple
    // callers in the same recall share one disk scan.
    const inFlight = StorageManager.allMemoriesInFlight.get(this.baseDir);
    if (inFlight) return inFlight;

    const readPromise = this._readAllMemoriesFromDisk();
    StorageManager.allMemoriesInFlight.set(this.baseDir, readPromise);
    try {
      return await readPromise;
    } finally {
      // Only delete if we still own the slot — invalidateAllMemoriesCache()
      // may have already cleared it and a new read may have claimed it.
      if (StorageManager.allMemoriesInFlight.get(this.baseDir) === readPromise) {
        StorageManager.allMemoriesInFlight.delete(this.baseDir);
      }
    }
  }

  /** Invalidate the readAllMemories() cache after writes that add/remove memories. */
  /** Public cache invalidation for callers that need authoritative disk reads
   *  (e.g. projection verify/rebuild). */
  invalidateAllMemoriesCacheForDir(): void {
    this.invalidateAllMemoriesCache();
  }

  /** Clear ALL static caches. Use in tests that write files directly
   *  (bypassing StorageManager.writeMemory) to avoid stale reads. */
  static clearAllStaticCaches(): void {
    StorageManager.allMemoriesInFlight.clear();
    StorageManager.questionsCache.clear();
  }

  /** Cancel any in-flight concurrent read so the next readAllMemories()
   *  starts a fresh disk scan and sees the just-written data. */
  private invalidateAllMemoriesCache(): void {
    StorageManager.allMemoriesInFlight.delete(this.baseDir);
  }

  private normalizeMemoryReadBatchSize(batchSize?: number): number {
    if (typeof batchSize !== "number" || !Number.isFinite(batchSize)) {
      return 50;
    }
    return Math.max(1, Math.floor(batchSize));
  }

  private async collectActiveMemoryPaths(): Promise<string[]> {
    const filePaths: string[] = [];

    const collectPaths = async (dir: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const subdirs: string[] = [];
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            subdirs.push(fullPath);
          } else if (entry.name.endsWith(".md")) {
            filePaths.push(fullPath);
          }
        }
        for (const subdir of subdirs) {
          await collectPaths(subdir);
        }
      } catch {
        // Directory does not exist yet.
      }
    };

    await collectPaths(this.factsDir);
    await collectPaths(this.correctionsDir);
    return filePaths;
  }

  private async readParsedMemoriesFromPaths(
    filePaths: string[],
    batchSize?: number,
  ): Promise<MemoryFile[]> {
    if (filePaths.length === 0) return [];

    const normalizedBatchSize = this.normalizeMemoryReadBatchSize(batchSize);
    const memories: MemoryFile[] = [];
    for (let i = 0; i < filePaths.length; i += normalizedBatchSize) {
      const batch = filePaths.slice(i, i + normalizedBatchSize);
      const results = await Promise.all(
        batch.map(async (fullPath) => {
          try {
            const raw = await readFile(fullPath, "utf-8");
            const parsed = parseFrontmatter(raw);
            if (!parsed) return null;
            return {
              path: fullPath,
              frontmatter: normalizeFrontmatterForPath(
                parsed.frontmatter,
                toMemoryPathRel(this.baseDir, fullPath),
              ),
              content: parsed.content,
            } satisfies MemoryFile;
          } catch {
            return null;
          }
        }),
      );
      for (const memory of results) {
        if (memory !== null) memories.push(memory);
      }
    }
    return memories;
  }

  private async readWindowUpdatedMs(filePath: string): Promise<number | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
      if (!match) return null;
      const frontmatterBlock = match[1];
      const rawUpdated =
        frontmatterBlock.match(/^updated:\s*"?([^"\n]*)"?/m)?.[1]
        ?? frontmatterBlock.match(/^created:\s*"?([^"\n]*)"?/m)?.[1]
        ?? null;
      const updatedMs = rawUpdated ? Date.parse(rawUpdated) : Number.NaN;
      return Number.isFinite(updatedMs) ? updatedMs : null;
    } catch {
      return null;
    }
  }

  private async filterWindowPathsByUpdatedAfter(filePaths: string[], updatedAfterMs: number): Promise<string[]> {
    const results = await Promise.all(filePaths.map(async (filePath) => {
      const updatedMs = await this.readWindowUpdatedMs(filePath);
      if (updatedMs !== null) {
        return updatedMs >= updatedAfterMs ? filePath : null;
      }
      try {
        const fileStat = await stat(filePath);
        return fileStat.mtimeMs >= updatedAfterMs ? filePath : null;
      } catch {
        return filePath;
      }
    }));
    return results.filter((filePath): filePath is string => filePath !== null);
  }

  private orderWindowPaths(filePaths: string[]): string[] {
    const correctionPaths: string[] = [];
    const factPaths: string[] = [];

    for (const filePath of filePaths) {
      if (filePath === this.correctionsDir || filePath.startsWith(`${this.correctionsDir}${path.sep}`)) {
        correctionPaths.push(filePath);
      } else {
        factPaths.push(filePath);
      }
    }

    correctionPaths.sort((left, right) => right.localeCompare(left));
    factPaths.sort((left, right) => right.localeCompare(left));

    if (correctionPaths.length === 0) return factPaths;
    if (factPaths.length === 0) return correctionPaths;

    const ordered: string[] = [];
    const maxLength = Math.max(correctionPaths.length, factPaths.length);
    for (let i = 0; i < maxLength; i += 1) {
      const correctionPath = correctionPaths[i];
      if (correctionPath) ordered.push(correctionPath);
      const factPath = factPaths[i];
      if (factPath) ordered.push(factPath);
    }
    return ordered;
  }

  private async readWindowBoundedBatch(
    candidateBatchPaths: string[],
    remainingSlots: number,
    remainingInspectionBudget: number,
    readBatchSize: number,
  ): Promise<{ memories: MemoryFile[]; filePaths: string[] }> {
    const memories: MemoryFile[] = [];
    const filePaths: string[] = [];
    const normalizedReadBatchSize = this.normalizeMemoryReadBatchSize(readBatchSize);

    for (let index = 0; index < candidateBatchPaths.length; ) {
      if (memories.length >= remainingSlots || filePaths.length >= remainingInspectionBudget) break;
      const availableSlots = remainingSlots - memories.length;
      const availableInspectionBudget = remainingInspectionBudget - filePaths.length;
      const parallelWindow =
        availableSlots >= 4 && availableInspectionBudget >= 4
          ? Math.min(normalizedReadBatchSize, 4)
          : 1;
      const candidatePaths = candidateBatchPaths.slice(
        index,
        index + Math.min(parallelWindow, availableInspectionBudget),
      );
      index += candidatePaths.length;
      if (candidatePaths.length === 0) break;
      filePaths.push(...candidatePaths);
      const parsedMemories = await this.readParsedMemoriesFromPaths(candidatePaths, candidatePaths.length);
      if (parsedMemories.length === 0) continue;
      memories.push(...parsedMemories.slice(0, availableSlots));
    }

    return { memories, filePaths };
  }

  async readMemoriesWindow(options: {
    maxMemories?: number;
    batchSize?: number;
    updatedAfter?: Date;
  } = {}): Promise<{ memories: MemoryFile[]; filePaths: string[] }> {
    const allPaths = await this.collectActiveMemoryPaths();
    const sortedPaths = this.orderWindowPaths(allPaths);
    const maxMemories =
      typeof options.maxMemories === "number" && Number.isFinite(options.maxMemories)
        ? Math.max(1, Math.floor(options.maxMemories))
        : undefined;
    const maxCandidatePaths = maxMemories === undefined ? undefined : maxMemories * 2;
    const updatedAfterMs = options.updatedAfter?.getTime();
    const normalizedBatchSize = this.normalizeMemoryReadBatchSize(options.batchSize);
    const memories: MemoryFile[] = [];
    const selectedPaths: string[] = [];

    for (let i = 0; i < sortedPaths.length; i += normalizedBatchSize) {
      if (
        maxMemories !== undefined
        && (memories.length >= maxMemories || (maxCandidatePaths !== undefined && selectedPaths.length >= maxCandidatePaths))
      ) {
        return { memories, filePaths: selectedPaths };
      }
      const batchPaths = sortedPaths.slice(i, i + normalizedBatchSize);
      const candidateBatchPaths = updatedAfterMs === undefined
        ? batchPaths
        : await this.filterWindowPathsByUpdatedAfter(batchPaths, updatedAfterMs);
      const remainingSlots = maxMemories === undefined ? undefined : Math.max(0, maxMemories - memories.length);
      const remainingInspectionBudget = maxCandidatePaths === undefined ? undefined : Math.max(0, maxCandidatePaths - selectedPaths.length);
      const { memories: batchMemories, filePaths: parsedCandidatePaths } = remainingSlots === undefined
        ? {
            memories: await this.readParsedMemoriesFromPaths(candidateBatchPaths, normalizedBatchSize),
            filePaths: candidateBatchPaths,
          }
        : await this.readWindowBoundedBatch(
            candidateBatchPaths,
            remainingSlots,
            remainingInspectionBudget ?? remainingSlots,
            normalizedBatchSize,
          );
      selectedPaths.push(...parsedCandidatePaths);
      for (const memory of batchMemories) {
        memories.push(memory);
        if (maxMemories !== undefined && memories.length >= maxMemories) {
          return { memories, filePaths: selectedPaths };
        }
      }
    }

    return { memories, filePaths: selectedPaths };
  }

  private async _readAllMemoriesFromDisk(): Promise<MemoryFile[]> {
    const filePaths = await this.collectActiveMemoryPaths();
    return this.readParsedMemoriesFromPaths(filePaths, 50);
  }

  /**
   * Read archived memory markdown files under archive/.
   * Used by long-term recall fallback when hot recall has no hits.
   */
  async readArchivedMemories(): Promise<MemoryFile[]> {
    const memories: MemoryFile[] = [];
    const root = this.archiveDir;

    const readDir = async (dir: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await readDir(fullPath);
          } else if (entry.name.endsWith(".md")) {
            try {
              const raw = await readFile(fullPath, "utf-8");
              const parsed = parseFrontmatter(raw);
              if (parsed) {
                memories.push({
                  path: fullPath,
                  frontmatter: normalizeFrontmatterForPath(
                    parsed.frontmatter,
                    toMemoryPathRel(this.baseDir, fullPath),
                  ),
                  content: parsed.content,
                });
              }
            } catch {
              // Skip unreadable files
            }
          }
        }
      } catch {
        // Directory doesn't exist yet
      }
    };

    await readDir(root);
    return memories;
  }

  /** Read a single memory file by its absolute path. Returns null if unreadable. */
  async readMemoryByPath(filePath: string): Promise<MemoryFile | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseFrontmatter(raw);
      if (parsed) {
        return {
          path: filePath,
          frontmatter: normalizeFrontmatterForPath(
            parsed.frontmatter,
            toMemoryPathRel(this.baseDir, filePath),
          ),
          content: parsed.content,
        };
      }

      // Entity files use a `# Name` + `**Type:** ...` markdown format rather than
      // YAML frontmatter. Build a synthetic MemoryFile so entity files returned by
      // the direct retrieval agent participate in boostSearchResults and last-recall
      // tracking rather than being silently dropped.
      const normalizedPath = filePath.split(path.sep).join("/");
      if (normalizedPath.includes("/entities/") && filePath.endsWith(".md")) {
        const entity = parseEntityFile(raw);
        if (!entity.name) return null;
        const nameWithoutExt = path.basename(filePath, ".md");
        // Fall back to file mtime rather than new Date() so that entities without
        // an explicit Updated: timestamp are not treated as freshly created on every
        // read. Using new Date() would inflate boostSearchResults recency scores for
        // every entity that lacks a timestamp.
        // Use epoch as the last-resort fallback so that entities without a
        // parseable timestamp don't appear as "freshly created" and inflate scores.
        const fileMtime = entity.updated
          || await stat(filePath).then((s) => s.mtime.toISOString()).catch(() => new Date(0).toISOString());
        return {
          path: filePath,
          frontmatter: {
            id: nameWithoutExt,
            category: "entity",
            created: fileMtime,
            updated: fileMtime,
            source: "entity_extraction",
            confidence: 0.9,
            confidenceTier: confidenceTier(0.9),
            tags: entity.type ? [entity.type] : [],
          },
          content: raw,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private resolveTierRootDir(tier: "hot" | "cold"): string {
    return tier === "cold" ? path.join(this.baseDir, "cold") : this.baseDir;
  }

  private resolveMemoryDateDir(memory: MemoryFile): string {
    const preferred = memory.frontmatter.created || memory.frontmatter.updated;
    const dateToken = (preferred ?? "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(dateToken)
      ? dateToken
      : new Date().toISOString().slice(0, 10);
  }

  private isArtifactMemory(memory: MemoryFile): boolean {
    if (memory.frontmatter.source === "artifact") return true;
    if (memory.frontmatter.artifactType !== undefined) return true;
    return /[\\/]artifacts[\\/]/.test(memory.path);
  }

  buildTierMemoryPath(memory: MemoryFile, tier: "hot" | "cold"): string {
    const root = this.resolveTierRootDir(tier);
    if (this.isArtifactMemory(memory)) {
      return path.join(root, "artifacts", this.resolveMemoryDateDir(memory), `${memory.frontmatter.id}.md`);
    }
    if (memory.frontmatter.category === "correction") {
      return path.join(root, "corrections", `${memory.frontmatter.id}.md`);
    }
    return path.join(root, "facts", this.resolveMemoryDateDir(memory), `${memory.frontmatter.id}.md`);
  }

  private async writeMemoryFileAtomic(targetPath: string, memory: MemoryFile): Promise<void> {
    const fileContent = `${serializeFrontmatter(memory.frontmatter)}\n\n${memory.content}\n`;
    await mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tempPath, fileContent, "utf-8");
      await rename(tempPath, targetPath);
      this.invalidateAllMemoriesCache();
    } catch (err) {
      try {
        await unlink(tempPath);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
  }

  async moveMemoryToPath(memory: MemoryFile, targetPath: string): Promise<void> {
    await this.writeMemoryFileAtomic(targetPath, memory);
    const sourcePath = path.resolve(memory.path);
    const destPath = path.resolve(targetPath);
    if (sourcePath !== destPath) {
      try {
        await unlink(memory.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("ENOENT")) {
          throw err;
        }
      }
      // Re-invalidate after the unlink — writeMemoryFileAtomic already
      // invalidated, but a concurrent readAllMemories() may have re-populated
      // the cache between the write and the unlink.
      this.invalidateAllMemoriesCache();
    }
  }

  async migrateMemoryToTier(
    memory: MemoryFile,
    targetTier: "hot" | "cold",
  ): Promise<{ changed: boolean; targetPath: string }> {
    const targetPath = this.buildTierMemoryPath(memory, targetTier);
    const sourcePath = path.resolve(memory.path);
    const destPath = path.resolve(targetPath);
    if (sourcePath === destPath) {
      return { changed: false, targetPath };
    }

    const existing = await this.readMemoryByPath(targetPath);
    if (existing?.frontmatter.id === memory.frontmatter.id) {
      try {
        await unlink(memory.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("ENOENT")) {
          throw err;
        }
      }
      this.bumpMemoryStatusVersion();
      return { changed: false, targetPath };
    }

    await this.moveMemoryToPath(memory, targetPath);
    this.invalidateAllMemoriesCache();
    this.bumpMemoryStatusVersion();
    return { changed: true, targetPath };
  }

  private get archiveDir(): string {
    return path.join(this.baseDir, "archive");
  }

  /**
   * Archive a memory by moving it from facts/ to archive/YYYY-MM-DD/.
   * Updates frontmatter with archived status before moving.
   * Returns the new file path on success, null on failure.
   */
  async archiveMemory(
    memory: MemoryFile,
    lifecycle?: MemoryLifecycleEventWriteOptions,
  ): Promise<string | null> {
    try {
      const now = lifecycle?.at ?? new Date();
      const today = now.toISOString().slice(0, 10);
      const destDir = path.join(this.archiveDir, today);
      await mkdir(destDir, { recursive: true });

      // Update frontmatter to reflect archived status
      const updatedFm: MemoryFrontmatter = {
        ...memory.frontmatter,
        status: "archived",
        archivedAt: now.toISOString(),
        updated: now.toISOString(),
      };

      const fileContent = `${serializeFrontmatter(updatedFm)}\n\n${memory.content}\n`;
      const destPath = path.join(destDir, path.basename(memory.path));

      // Write to archive location first, then remove original
      await writeFile(destPath, fileContent, "utf-8");
      await unlink(memory.path);
      this.invalidateAllMemoriesCache();
      await this.appendGeneratedMemoryLifecycleEventFailOpen(
        "storage.archiveMemory",
        {
          memoryId: memory.frontmatter.id,
          eventType: "archived",
          timestamp: updatedFm.archivedAt ?? updatedFm.updated,
          actor: lifecycle?.actor ?? "storage.archiveMemory",
          reasonCode: lifecycle?.reasonCode,
          before: this.summarizeLifecycleState(memory.frontmatter, memory.path),
          after: this.summarizeLifecycleState(updatedFm, destPath),
          relatedMemoryIds: lifecycle?.relatedMemoryIds,
          correlationId: lifecycle?.correlationId,
        },
        lifecycle?.ruleVersion,
      );
      this.bumpMemoryStatusVersion();

      log.debug(`archived memory ${memory.frontmatter.id} → ${destPath}`);
      return destPath;
    } catch (err) {
      log.warn(`failed to archive memory ${memory.frontmatter.id}: ${err}`);
      return null;
    }
  }

  async readEntities(): Promise<string[]> {
    try {
      const entries = await readdir(this.entitiesDir);
      return entries.filter((e) => e.endsWith(".md")).map((e) => e.replace(".md", ""));
    } catch {
      return [];
    }
  }

  async readEntity(name: string): Promise<string> {
    try {
      return await readFile(path.join(this.entitiesDir, `${name}.md`), "utf-8");
    } catch {
      return "";
    }
  }

  /** Return sorted list of entity filenames (without .md extension) */
  async listEntityNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.entitiesDir);
      return entries
        .filter((e) => e.endsWith(".md"))
        .map((e) => e.replace(".md", ""))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Find an existing entity that fuzzy-matches the proposed name.
   * Returns the existing entity filename (without .md) or null if no match.
   *
   * Matching priority:
   * 1. Exact normalized match (handled by normalizeEntityName already)
   * 2. Dehyphenated match: "jane-doe" vs "janedoe"
   * 3. Substring containment: "handle-janedoe" contains "janedoe"
   * 4. Levenshtein ≤ 2 on dehyphenated names
   */
  async findMatchingEntity(proposedName: string, type: string): Promise<string | null> {
    const existing = await this.listEntityNames();
    if (existing.length === 0) return null;

    const typePrefix = `${type.toLowerCase()}-`;
    // Extract the name part from the proposed normalized name
    const proposedFull = normalizeEntityName(proposedName, type);
    const proposedNamePart = proposedFull.startsWith(typePrefix)
      ? proposedFull.slice(typePrefix.length)
      : proposedFull;
    const proposedDehyph = dehyphenate(proposedNamePart);

    // Only compare against entities of the same type
    const sameType = existing.filter((e) => e.startsWith(typePrefix));

    for (const entity of sameType) {
      const entityNamePart = entity.slice(typePrefix.length);
      const entityDehyph = dehyphenate(entityNamePart);

      // Already the exact normalized form
      if (entity === proposedFull) return entity;

      // Dehyphenated exact match
      if (entityDehyph === proposedDehyph) return entity;

      // Substring containment (shorter must be >60% length of longer)
      const shorter = proposedDehyph.length <= entityDehyph.length ? proposedDehyph : entityDehyph;
      const longer = proposedDehyph.length > entityDehyph.length ? proposedDehyph : entityDehyph;
      if (shorter.length > 3 && shorter.length / longer.length > 0.6 && longer.includes(shorter)) {
        return entity;
      }

      // Levenshtein distance ≤ 2 (only for names of reasonable length)
      if (proposedDehyph.length >= 4 && entityDehyph.length >= 4) {
        const dist = levenshtein(proposedDehyph, entityDehyph);
        if (dist <= 2) return entity;
      }
    }

    return null;
  }

  async invalidateMemory(id: string): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    if (!memory) return false;

    try {
      await unlink(memory.path);
      this.invalidateAllMemoriesCache();
      this.bumpMemoryStatusVersion();
      log.debug(`invalidated memory ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  async updateMemory(
    id: string,
    newContent: string,
    options?: { supersedes?: string; lineage?: string[]; actor?: string },
  ): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    if (!memory) return false;

    const mergedLineage = [
      ...(memory.frontmatter.lineage ?? []),
      ...(options?.lineage ?? []),
    ].filter((v, i, a) => a.indexOf(v) === i); // dedupe

    const updated: MemoryFrontmatter = {
      ...memory.frontmatter,
      updated: new Date().toISOString(),
      supersedes: options?.supersedes ?? memory.frontmatter.supersedes,
      lineage: mergedLineage.length > 0 ? mergedLineage : undefined,
    };
    const sanitized = sanitizeMemoryContent(newContent);
    if (!sanitized.clean) {
      log.warn(`updated memory content sanitized for ${id}; violations=${sanitized.violations.join(", ")}`);
    }
    const fileContent = `${serializeFrontmatter(updated)}\n\n${sanitized.text}\n`;
    await writeFile(memory.path, fileContent, "utf-8");
    this.invalidateAllMemoriesCache();
    await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.updateMemory", {
      memoryId: id,
      eventType: "updated",
      timestamp: updated.updated,
      actor: options?.actor ?? "storage.updateMemory",
      before: this.summarizeLifecycleState(memory.frontmatter, memory.path),
      after: this.summarizeLifecycleState(updated, memory.path),
      relatedMemoryIds: [
        ...(updated.supersedes ? [updated.supersedes] : []),
        ...((updated.lineage ?? []).filter(Boolean)),
      ],
    });
    log.debug(`updated memory ${id}`);
    return true;
  }

  /**
   * Update frontmatter fields without changing memory content.
   * Returns false when the memory is not found.
   */
  async writeMemoryFrontmatter(
    memory: MemoryFile,
    patch: Partial<MemoryFrontmatter>,
    lifecycle?: MemoryLifecycleEventWriteOptions,
  ): Promise<boolean> {
    const beforeStatus = memory.frontmatter.status ?? "active";
    const updated: MemoryFrontmatter = {
      ...memory.frontmatter,
      ...patch,
    };
    const afterStatus = updated.status ?? "active";

    const fileContent = `${serializeFrontmatter(updated)}\n\n${memory.content}\n`;
    await writeFile(memory.path, fileContent, "utf-8");
    this.invalidateAllMemoriesCache();
    await this.appendGeneratedMemoryLifecycleEventFailOpen(
      "storage.writeMemoryFrontmatter",
      {
        memoryId: updated.id,
        eventType: this.frontmatterPatchEventType(memory.frontmatter, updated),
        timestamp: updated.updated ?? new Date().toISOString(),
        actor: lifecycle?.actor ?? "storage.writeMemoryFrontmatter",
        reasonCode: lifecycle?.reasonCode,
        before: this.summarizeLifecycleState(memory.frontmatter, memory.path),
        after: this.summarizeLifecycleState(updated, memory.path),
        relatedMemoryIds: [
          ...(lifecycle?.relatedMemoryIds ?? []),
          ...(updated.supersededBy ? [updated.supersededBy] : []),
          ...(updated.supersedes ? [updated.supersedes] : []),
        ],
        correlationId: lifecycle?.correlationId,
      },
      lifecycle?.ruleVersion,
    );
    if (beforeStatus !== afterStatus) {
      this.bumpMemoryStatusVersion();
    }
    return true;
  }

  /**
   * Update frontmatter by memory ID.
   * Prefer writeMemoryFrontmatter(memory, patch) in batch loops to avoid full-corpus rescans.
   */
  async updateMemoryFrontmatter(
    id: string,
    patch: Partial<MemoryFrontmatter>,
  ): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === id);
    if (!memory) return false;
    return this.writeMemoryFrontmatter(memory, patch);
  }

  /** Remove memories past their TTL expiresAt date */
  async cleanExpiredTTL(): Promise<MemoryFile[]> {
    const memories = await this.readAllMemories();
    const now = Date.now();
    const deleted: MemoryFile[] = [];

    for (const m of memories) {
      if (!m.frontmatter.expiresAt) continue;
      const expiresAt = new Date(m.frontmatter.expiresAt).getTime();
      if (expiresAt < now) {
        try {
          await unlink(m.path);
          deleted.push(m);
          log.debug(`cleaned expired memory ${m.frontmatter.id} (TTL expired)`);
        } catch {
          // Ignore
        }
      }
    }

    if (deleted.length > 0) {
      this.invalidateAllMemoriesCache();
      this.bumpMemoryStatusVersion();
    }

    return deleted;
  }

  async loadBuffer(): Promise<BufferState> {
    const bufferPath = path.join(this.stateDir, "buffer.json");
    try {
      const raw = await readFile(bufferPath, "utf-8");
      return JSON.parse(raw) as BufferState;
    } catch {
      return { turns: [], lastExtractionAt: null, extractionCount: 0 };
    }
  }

  async saveBuffer(state: BufferState): Promise<void> {
    await this.ensureDirectories();
    const bufferPath = path.join(this.stateDir, "buffer.json");
    await writeFile(bufferPath, JSON.stringify(state, null, 2), "utf-8");
  }

  async loadMeta(): Promise<MetaState> {
    const metaPath = path.join(this.stateDir, "meta.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      return JSON.parse(raw) as MetaState;
    } catch {
      return {
        extractionCount: 0,
        lastExtractionAt: null,
        lastConsolidationAt: null,
        totalMemories: 0,
        totalEntities: 0,
      };
    }
  }

  async saveMeta(state: MetaState): Promise<void> {
    await this.ensureDirectories();
    const metaPath = path.join(this.stateDir, "meta.json");
    await writeFile(metaPath, JSON.stringify(state, null, 2), "utf-8");
  }

  async appendMemoryActionEvents(events: MemoryActionEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.ensureDirectories();

    const nowIso = new Date().toISOString();
    const payload = events.map((event) => {
      const normalized: MemoryActionEvent = {
        ...event,
        timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : nowIso,
      };
      return `${JSON.stringify(normalized)}\n`;
    }).join("");

    await appendFile(this.memoryActionsPath, payload, "utf-8");
    return events.length;
  }

  async appendMemoryLifecycleEvents(events: MemoryLifecycleEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.ensureDirectories();

    const nowIso = new Date().toISOString();
    const payload = events.map((event) => {
      const normalized: MemoryLifecycleEvent = {
        ...event,
        timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : nowIso,
      };
      return `${JSON.stringify(normalized)}\n`;
    }).join("");

    await appendFile(this.memoryLifecycleLedgerPath, payload, "utf-8");
    return events.length;
  }

  async appendBehaviorSignals(events: BehaviorSignalEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.ensureDirectories();

    let existingKeys = new Set<string>();
    try {
      const raw = await readFile(this.behaviorSignalsPath, "utf-8");
      const lines = raw.split("\n");
      for (const line of lines) {
        const row = line.trim();
        if (!row) continue;
        try {
          const parsed = JSON.parse(row) as Partial<BehaviorSignalEvent>;
          if (typeof parsed.memoryId === "string" && typeof parsed.signalHash === "string") {
            existingKeys.add(`${parsed.memoryId}:${parsed.signalHash}`);
          }
        } catch {
          // Ignore malformed rows (fail-open).
        }
      }
    } catch {
      existingKeys = new Set<string>();
    }

    const nowIso = new Date().toISOString();
    const deduped: BehaviorSignalEvent[] = [];
    for (const event of events) {
      const key = `${event.memoryId}:${event.signalHash}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      deduped.push({
        ...event,
        timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : nowIso,
      });
    }

    if (deduped.length === 0) return 0;
    const payload = deduped.map((event) => `${JSON.stringify(event)}\n`).join("");
    await appendFile(this.behaviorSignalsPath, payload, "utf-8");
    return deduped.length;
  }

  async appendReextractJobs(events: ReextractJobRequest[]): Promise<number> {
    if (events.length === 0) return 0;
    await this.ensureDirectories();
    const filePath = path.join(this.stateDir, "reextract-jobs.jsonl");
    const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    try {
      await appendFile(filePath, lines, "utf-8");
      return events.length;
    } catch {
      return 0;
    }
  }

  async readReextractJobs(limit: number = 200): Promise<ReextractJobRequest[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 200;
    const filePath = path.join(this.stateDir, "reextract-jobs.jsonl");
    try {
      const raw = await readFile(filePath, "utf-8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      const parsed: ReextractJobRequest[] = [];
      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Partial<ReextractJobRequest>;
          if (
            typeof record.memoryId !== "string" ||
            record.memoryId.length === 0 ||
            typeof record.model !== "string" ||
            record.model.length === 0 ||
            typeof record.requestedAt !== "string" ||
            record.requestedAt.length === 0 ||
            record.source !== "cli-migrate"
          ) {
            continue;
          }
          parsed.push({
            memoryId: record.memoryId,
            model: record.model,
            requestedAt: record.requestedAt,
            source: "cli-migrate",
          });
        } catch {
          continue;
        }
      }
      return parsed.slice(-safeLimit);
    } catch {
      return [];
    }
  }

  async readBehaviorSignals(limit: number = 200): Promise<BehaviorSignalEvent[]> {
    const cappedLimit = Math.max(0, Math.floor(limit));
    if (cappedLimit === 0) return [];

    try {
      const raw = await readFile(this.behaviorSignalsPath, "utf-8");
      const out: BehaviorSignalEvent[] = [];
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < cappedLimit; i -= 1) {
        const row = lines[i]?.trim();
        if (!row) continue;
        try {
          const parsed = JSON.parse(row) as Partial<BehaviorSignalEvent>;
          if (
            typeof parsed.timestamp === "string" &&
            typeof parsed.namespace === "string" &&
            typeof parsed.memoryId === "string" &&
            typeof parsed.category === "string" &&
            typeof parsed.signalType === "string" &&
            typeof parsed.direction === "string" &&
            typeof parsed.confidence === "number" &&
            typeof parsed.signalHash === "string" &&
            typeof parsed.source === "string"
          ) {
            out.push(parsed as BehaviorSignalEvent);
          }
        } catch {
          // Ignore malformed rows (fail-open).
        }
      }
      return out.reverse();
    } catch {
      return [];
    }
  }

  async readMemoryActionEvents(limit: number = 200): Promise<MemoryActionEvent[]> {
    const cappedLimit = Math.max(0, Math.floor(limit));
    if (cappedLimit === 0) return [];

    try {
      const raw = await readFile(this.memoryActionsPath, "utf-8");
      const out: MemoryActionEvent[] = [];
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0 && out.length < cappedLimit; i -= 1) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Partial<MemoryActionEvent>;
          if (
            typeof parsed.timestamp === "string" &&
            typeof parsed.action === "string" &&
            typeof parsed.outcome === "string"
          ) {
            out.push(parsed as MemoryActionEvent);
          }
        } catch {
          // Ignore malformed rows (fail-open).
        }
      }
      return out.reverse();
    } catch {
      return [];
    }
  }

  async readAllMemoryLifecycleEvents(): Promise<MemoryLifecycleEvent[]> {
    try {
      const raw = await readFile(this.memoryLifecycleLedgerPath, "utf-8");
      const out: MemoryLifecycleEvent[] = [];
      const lines = raw.split("\n");
      for (const line of lines) {
        const row = line.trim();
        if (!row) continue;
        try {
          const parsed = JSON.parse(row) as Partial<MemoryLifecycleEvent>;
          if (
            typeof parsed.eventId === "string" &&
            typeof parsed.memoryId === "string" &&
            typeof parsed.eventType === "string" &&
            typeof parsed.timestamp === "string" &&
            typeof parsed.actor === "string" &&
            typeof parsed.ruleVersion === "string"
          ) {
            out.push(parsed as MemoryLifecycleEvent);
          }
        } catch {
          // Ignore malformed rows (fail-open).
        }
      }
      return sortMemoryLifecycleEvents(out);
    } catch {
      return [];
    }
  }

  async readMemoryLifecycleEvents(limit: number = 200): Promise<MemoryLifecycleEvent[]> {
    const cappedLimit = Math.max(0, Math.floor(limit));
    if (cappedLimit === 0) return [];
    const events = await this.readAllMemoryLifecycleEvents();
    return events.slice(-cappedLimit);
  }

  async writeCompressionGuidelines(content: string): Promise<void> {
    await this.ensureDirectories();
    await writeFile(this.compressionGuidelinesPath, content, "utf-8");
  }

  async readCompressionGuidelines(): Promise<string | null> {
    try {
      return await readFile(this.compressionGuidelinesPath, "utf-8");
    } catch {
      return null;
    }
  }

  async writeCompressionGuidelineDraft(content: string): Promise<void> {
    await this.ensureDirectories();
    await writeFile(this.compressionGuidelineDraftPath, content, "utf-8");
  }

  async readCompressionGuidelineDraft(): Promise<string | null> {
    try {
      return await readFile(this.compressionGuidelineDraftPath, "utf-8");
    } catch {
      return null;
    }
  }

  async writeCompressionGuidelineOptimizerState(
    state: CompressionGuidelineOptimizerState,
  ): Promise<void> {
    await this.ensureDirectories();
    await writeFile(this.compressionGuidelineStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  }

  async writeCompressionGuidelineDraftState(
    state: CompressionGuidelineOptimizerState,
  ): Promise<void> {
    await this.ensureDirectories();
    await writeFile(this.compressionGuidelineDraftStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  }

  async readCompressionGuidelineOptimizerState(): Promise<CompressionGuidelineOptimizerState | null> {
    return this.readCompressionGuidelineStateFile(this.compressionGuidelineStatePath);
  }

  async readCompressionGuidelineDraftState(): Promise<CompressionGuidelineOptimizerState | null> {
    return this.readCompressionGuidelineStateFile(this.compressionGuidelineDraftStatePath);
  }

  async activateCompressionGuidelineDraft(options?: {
    expectedContentHash?: string;
    expectedGuidelineVersion?: number;
  }): Promise<boolean> {
    const [draftContent, draftState] = await Promise.all([
      this.readCompressionGuidelineDraft(),
      this.readCompressionGuidelineDraftState(),
    ]);
    if (!draftContent || !draftState) return false;
    if (
      typeof options?.expectedContentHash === "string" &&
      options.expectedContentHash.length > 0 &&
      draftState.contentHash !== options.expectedContentHash
    ) {
      return false;
    }
    if (
      typeof options?.expectedGuidelineVersion === "number" &&
      Number.isFinite(options.expectedGuidelineVersion) &&
      draftState.guidelineVersion !== options.expectedGuidelineVersion
    ) {
      return false;
    }
    if (draftState.contentHash) {
      const contentHash = createHash("sha256").update(draftContent).digest("hex");
      if (contentHash !== draftState.contentHash) return false;
    }

    await this.writeCompressionGuidelines(draftContent);
    await this.writeCompressionGuidelineOptimizerState({
      ...draftState,
      activationState: "active",
    });
    await Promise.all([
      unlink(this.compressionGuidelineDraftPath).catch(() => undefined),
      unlink(this.compressionGuidelineDraftStatePath).catch(() => undefined),
    ]);
    return true;
  }

  private async readCompressionGuidelineStateFile(
    filePath: string,
  ): Promise<CompressionGuidelineOptimizerState | null> {
    const isFiniteNonNegativeInteger = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
    const isValidActionSummary = (
      value: unknown,
    ): value is NonNullable<CompressionGuidelineOptimizerState["actionSummaries"]>[number] => {
      if (!value || typeof value !== "object") return false;
      const summary = value as NonNullable<CompressionGuidelineOptimizerState["actionSummaries"]>[number];
      return (
        typeof summary.action === "string" &&
        isFiniteNonNegativeInteger(summary.total) &&
        summary.outcomes !== null &&
        typeof summary.outcomes === "object" &&
        isFiniteNonNegativeInteger(summary.outcomes.applied) &&
        isFiniteNonNegativeInteger(summary.outcomes.skipped) &&
        isFiniteNonNegativeInteger(summary.outcomes.failed) &&
        summary.quality !== null &&
        typeof summary.quality === "object" &&
        isFiniteNonNegativeInteger(summary.quality.good) &&
        isFiniteNonNegativeInteger(summary.quality.poor) &&
        isFiniteNonNegativeInteger(summary.quality.unknown)
      );
    };
    const isValidRuleUpdate = (
      value: unknown,
    ): value is NonNullable<CompressionGuidelineOptimizerState["ruleUpdates"]>[number] => {
      if (!value || typeof value !== "object") return false;
      const rule = value as NonNullable<CompressionGuidelineOptimizerState["ruleUpdates"]>[number];
      return (
        typeof rule.action === "string" &&
        typeof rule.delta === "number" &&
        Number.isFinite(rule.delta) &&
        (rule.direction === "increase" || rule.direction === "decrease" || rule.direction === "hold") &&
        (rule.confidence === "low" || rule.confidence === "medium" || rule.confidence === "high") &&
        Array.isArray(rule.notes) &&
        rule.notes.every((note) => typeof note === "string")
      );
    };

    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<CompressionGuidelineOptimizerState>;
      const sourceWindow = parsed?.sourceWindow as Partial<CompressionGuidelineOptimizerState["sourceWindow"]>;
      const eventCounts = parsed?.eventCounts as Partial<CompressionGuidelineOptimizerState["eventCounts"]>;
      const activationState =
        parsed?.activationState === "draft" || parsed?.activationState === "active"
          ? parsed.activationState
          : undefined;
      const contentHash =
        typeof parsed?.contentHash === "string" && parsed.contentHash.length > 0
          ? parsed.contentHash
          : undefined;
      const actionSummaries = Array.isArray(parsed?.actionSummaries)
        ? parsed.actionSummaries.filter(isValidActionSummary)
        : undefined;
      const ruleUpdates = Array.isArray(parsed?.ruleUpdates)
        ? parsed.ruleUpdates.filter(isValidRuleUpdate)
        : undefined;
      if (
        !isFiniteNonNegativeInteger(parsed?.version) ||
        typeof parsed?.updatedAt !== "string" ||
        parsed.updatedAt.length === 0 ||
        !sourceWindow ||
        typeof sourceWindow.from !== "string" ||
        sourceWindow.from.length === 0 ||
        typeof sourceWindow.to !== "string" ||
        sourceWindow.to.length === 0 ||
        !eventCounts ||
        !isFiniteNonNegativeInteger(eventCounts.total) ||
        !isFiniteNonNegativeInteger(eventCounts.applied) ||
        !isFiniteNonNegativeInteger(eventCounts.skipped) ||
        !isFiniteNonNegativeInteger(eventCounts.failed) ||
        !isFiniteNonNegativeInteger(parsed?.guidelineVersion)
      ) {
        return null;
      }

      return {
        version: parsed.version,
        updatedAt: parsed.updatedAt,
        sourceWindow: {
          from: sourceWindow.from,
          to: sourceWindow.to,
        },
        eventCounts: {
          total: eventCounts.total,
          applied: eventCounts.applied,
          skipped: eventCounts.skipped,
          failed: eventCounts.failed,
        },
        guidelineVersion: parsed.guidelineVersion,
        ...(contentHash ? { contentHash } : {}),
        ...(activationState ? { activationState } : {}),
        ...(actionSummaries ? { actionSummaries } : {}),
        ...(ruleUpdates ? { ruleUpdates } : {}),
      };
    } catch {
      return null;
    }
  }

  async writeIdentityAnchor(content: string): Promise<void> {
    await this.ensureDirectories();
    await writeFile(this.identityAnchorPath, content, "utf-8");
  }

  async readIdentityAnchor(): Promise<string | null> {
    try {
      return await readFile(this.identityAnchorPath, "utf-8");
    } catch {
      return null;
    }
  }

  async appendContinuityIncident(input: ContinuityIncidentOpenInput): Promise<ContinuityIncidentRecord> {
    await this.ensureDirectories();
    const now = new Date();
    const nowIso = now.toISOString();
    const date = nowIso.slice(0, 10);
    const id = this.generateId("incident");
    const incident = createContinuityIncidentRecord(id, input, nowIso);
    const filePath = path.join(this.identityIncidentsDir, `${date}-${id}.md`);
    await writeFile(filePath, serializeContinuityIncident(incident), "utf-8");
    return { ...incident, filePath };
  }

  async readContinuityIncidents(
    limit: number = 200,
    state: "open" | "closed" | "all" = "all",
  ): Promise<ContinuityIncidentRecord[]> {
    const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;
    const cappedLimit = Math.max(0, normalizedLimit);
    if (cappedLimit === 0) return [];

    try {
      const candidates = await this.readContinuityIncidentFileNames();
      const incidents: ContinuityIncidentRecord[] = [];

      for (const file of candidates) {
        if (incidents.length >= cappedLimit) break;
        const filePath = path.join(this.identityIncidentsDir, file);
        try {
          const raw = await readFile(filePath, "utf-8");
          const parsed = parseContinuityIncident(raw);
          if (!parsed) continue;
          if (state !== "all" && parsed.state !== state) continue;
          incidents.push({ ...parsed, filePath });
        } catch {
          // Fail-open on malformed/missing files.
        }
      }
      return incidents;
    } catch {
      return [];
    }
  }

  async closeContinuityIncident(
    id: string,
    closure: ContinuityIncidentCloseInput,
  ): Promise<ContinuityIncidentRecord | null> {
    const directFilePath = await this.findContinuityIncidentFilePathById(id);
    const target = directFilePath ? await this.readContinuityIncidentFile(directFilePath) : null;
    if (!target || !directFilePath) return null;
    if (target.state === "closed") return target;

    const closed = closeContinuityIncidentRecord(target, closure, new Date().toISOString());
    await writeFile(directFilePath, serializeContinuityIncident(closed), "utf-8");
    return { ...closed, filePath: directFilePath };
  }

  async writeIdentityAudit(period: "weekly" | "monthly", key: string, content: string): Promise<string> {
    await this.ensureDirectories();
    const safeKey = this.sanitizeIdentityAuditKey(key);
    const dir = period === "weekly" ? this.identityAuditsWeeklyDir : this.identityAuditsMonthlyDir;
    const filePath = path.join(dir, `${safeKey}.md`);
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  async readIdentityAudit(period: "weekly" | "monthly", key: string): Promise<string | null> {
    try {
      const safeKey = this.sanitizeIdentityAuditKey(key);
      const dir = period === "weekly" ? this.identityAuditsWeeklyDir : this.identityAuditsMonthlyDir;
      return await readFile(path.join(dir, `${safeKey}.md`), "utf-8");
    } catch {
      return null;
    }
  }

  async writeIdentityImprovementLoops(content: string): Promise<void> {
    await this.ensureDirectories();
    await writeFile(this.identityImprovementLoopsPath, content, "utf-8");
  }

  async readIdentityImprovementLoops(): Promise<string | null> {
    try {
      return await readFile(this.identityImprovementLoopsPath, "utf-8");
    } catch {
      return null;
    }
  }

  async readIdentityImprovementLoopRegister(): Promise<ContinuityImprovementLoop[]> {
    const raw = await this.readIdentityImprovementLoops();
    if (!raw) return [];
    return parseContinuityImprovementLoops(raw);
  }

  async upsertIdentityImprovementLoop(input: ContinuityLoopUpsertInput): Promise<ContinuityImprovementLoop> {
    const nowIso = new Date().toISOString();
    const raw = await this.readIdentityImprovementLoops();
    const { markdown, loop } = upsertContinuityLoopInMarkdown(raw, input, nowIso);
    await this.writeIdentityImprovementLoops(markdown);
    return loop;
  }

  async reviewIdentityImprovementLoop(
    id: string,
    input: ContinuityLoopReviewInput,
  ): Promise<ContinuityImprovementLoop | null> {
    const raw = await this.readIdentityImprovementLoops();
    const { markdown, loop } = reviewContinuityLoopInMarkdown(raw, id, input, new Date().toISOString());
    if (!loop) return null;
    await this.writeIdentityImprovementLoops(markdown);
    return loop;
  }

  // ---------------------------------------------------------------------------
  // Question storage
  // ---------------------------------------------------------------------------

  private generateId(prefix: string = "m"): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 4);
    return `${prefix}-${ts}-${rand}`;
  }

  private async readContinuityIncidentFileNames(): Promise<string[]> {
    const files = await readdir(this.identityIncidentsDir);
    return files
      .filter((file) => file.endsWith(".md"))
      .sort()
      .reverse();
  }

  private async readContinuityIncidentFile(filePath: string): Promise<ContinuityIncidentRecord | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = parseContinuityIncident(raw);
      return parsed ? { ...parsed, filePath } : null;
    } catch {
      return null;
    }
  }

  private async findContinuityIncidentFilePathById(id: string): Promise<string | null> {
    const fileNames = await this.readContinuityIncidentFileNames();
    const directMatch = fileNames.find((name) => name.endsWith(`-${id}.md`));
    if (directMatch) {
      const directPath = path.join(this.identityIncidentsDir, directMatch);
      const parsed = await this.readContinuityIncidentFile(directPath);
      if (parsed?.id === id) return directPath;
    }

    for (const fileName of fileNames) {
      const filePath = path.join(this.identityIncidentsDir, fileName);
      const parsed = await this.readContinuityIncidentFile(filePath);
      if (parsed?.id === id) return filePath;
    }
    return null;
  }

  private sanitizeIdentityAuditKey(key: string): string {
    const trimmed = key.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) || trimmed.includes("..")) {
      throw new Error("Invalid identity audit key");
    }
    return trimmed;
  }

  async writeQuestion(
    question: string,
    context: string,
    priority: number,
  ): Promise<string> {
    await mkdir(this.questionsDir, { recursive: true });

    const id = this.generateId("q");
    const frontmatter = {
      id,
      created: new Date().toISOString(),
      priority,
      resolved: false,
    };

    const content = `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n${question}\n\n**Context:** ${context}\n`;

    const filePath = path.join(this.questionsDir, `${id}.md`);
    await writeFile(filePath, content, "utf-8");

    log.debug(`wrote question ${id} to ${filePath}`);
    this.invalidateQuestionsCache();
    return id;
  }

  async readQuestions(
    opts?: { unresolvedOnly?: boolean },
  ): Promise<
    Array<{
      id: string;
      question: string;
      context: string;
      priority: number;
      resolved: boolean;
      created: string;
      filePath: string;
    }>
  > {
    const cacheKey = this.questionsDir;
    const cached = StorageManager.questionsCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < StorageManager.QUESTIONS_CACHE_TTL_MS) {
      // Check dir mtime for cross-process invalidation — if another process
      // wrote/resolved a question, the directory mtime will be newer than loadedAt.
      try {
        const dirStat = await stat(this.questionsDir);
        if (dirStat.mtimeMs <= cached.loadedAt) {
          const all = cached.questions;
          return opts?.unresolvedOnly ? all.filter((q) => !q.resolved) : all;
        }
      } catch {
        // Dir doesn't exist — fall through to re-read
      }
    }

    try {
      const files = await readdir(this.questionsDir);
      const questions = [];
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(this.questionsDir, file);
        const raw = await readFile(filePath, "utf-8");
        const parsed = this.parseQuestionFile(raw, filePath);
        if (parsed) {
          questions.push(parsed);
        }
      }
      const sorted = questions.sort((a, b) => b.priority - a.priority);
      StorageManager.questionsCache.set(cacheKey, { questions: sorted, loadedAt: Date.now() });
      return opts?.unresolvedOnly ? sorted.filter((q) => !q.resolved) : sorted;
    } catch {
      return [];
    }
  }

  /** Invalidate the questions cache (call after writing a question). */
  invalidateQuestionsCache(): void {
    StorageManager.questionsCache.delete(this.questionsDir);
  }

  private parseQuestionFile(
    raw: string,
    filePath: string,
  ): {
    id: string;
    question: string;
    context: string;
    priority: number;
    resolved: boolean;
    created: string;
    filePath: string;
  } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatterStr = match[1];
    const body = match[2].trim();

    // Parse frontmatter
    const id =
      this.extractFrontmatterValue(frontmatterStr, "id") ??
      path.basename(filePath, ".md");
    const created =
      this.extractFrontmatterValue(frontmatterStr, "created") ?? "";
    const priority = parseFloat(
      this.extractFrontmatterValue(frontmatterStr, "priority") ?? "0.5",
    );
    const resolved =
      this.extractFrontmatterValue(frontmatterStr, "resolved") === "true";

    // Extract question and context from body
    const contextMatch = body.match(/\*\*Context:\*\*\s*(.*)/);
    const question = contextMatch
      ? body.slice(0, contextMatch.index).trim()
      : body;
    const context = contextMatch ? contextMatch[1].trim() : "";

    return { id, question, context, priority, resolved, created, filePath };
  }

  private extractFrontmatterValue(
    frontmatter: string,
    key: string,
  ): string | null {
    const match = frontmatter.match(
      new RegExp(`^${key}:\\s*"?([^"\\n]*)"?`, "m"),
    );
    return match ? match[1] : null;
  }

  async resolveQuestion(id: string): Promise<boolean> {
    const questions = await this.readQuestions();
    const q = questions.find((q) => q.id === id);
    if (!q) return false;

    let raw = await readFile(q.filePath, "utf-8");
    raw = raw.replace(/resolved: false/, "resolved: true");
    raw = raw.replace(
      /---\n\n/,
      `resolvedAt: "${new Date().toISOString()}"\n---\n\n`,
    );
    await writeFile(q.filePath, raw, "utf-8");
    log.debug(`resolved question ${id}`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Identity file
  // ---------------------------------------------------------------------------

  async readIdentity(workspaceDir: string, namespace?: string): Promise<string> {
    const identityPath = this.identityFilePath(workspaceDir, namespace);
    try {
      return await readFile(identityPath, "utf-8");
    } catch {
      return "";
    }
  }

  async writeIdentity(workspaceDir: string, content: string, namespace?: string): Promise<void> {
    const identityPath = this.identityFilePath(workspaceDir, namespace);
    await writeFile(identityPath, content, "utf-8");
    log.debug(`wrote consolidated IDENTITY.md (${content.length} chars)`);
  }

  /** Max size for IDENTITY.md before we stop appending reflections (15KB leaves room under 20KB gateway limit) */
  private static readonly IDENTITY_MAX_BYTES = 15_000;
  /** Minimum interval between reflections (1 hour) */
  private static readonly REFLECTION_COOLDOWN_MS = 60 * 60 * 1000;

  async appendToIdentity(
    workspaceDir: string,
    reflection: string,
    opts?: { hygiene?: FileHygieneConfig; namespace?: string },
  ): Promise<void> {
    const identityPath = this.identityFilePath(workspaceDir, opts?.namespace);

    let existing = "";
    try {
      existing = await readFile(identityPath, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    const hygiene = opts?.hygiene;
    const rotateEnabled =
      hygiene?.enabled === true &&
      hygiene.rotateEnabled === true &&
      Array.isArray(hygiene.rotatePaths) &&
      hygiene.rotatePaths.includes(path.basename(identityPath));

    // Rotation/splitting: preserve full history, keep the bootstrap file small.
    if (rotateEnabled) {
      const maxBytes = hygiene.rotateMaxBytes;
      if (existing.length > maxBytes) {
        const archiveDir = path.join(workspaceDir, hygiene.archiveDir);
        const { newContent } = await rotateMarkdownFileToArchive({
          filePath: identityPath,
          archiveDir,
          archivePrefix: "IDENTITY",
          keepTailChars: hygiene.rotateKeepTailChars,
        });
        await writeFile(identityPath, newContent, "utf-8");
        existing = newContent;
        log.info(
          `rotated IDENTITY.md to archive (size=${existing.length} chars, maxBytes=${maxBytes})`,
        );
      }
    } else {
      // Legacy behavior: skip if file is too large
      if (existing.length > StorageManager.IDENTITY_MAX_BYTES) {
        log.debug(`IDENTITY.md is ${existing.length} chars (limit ${StorageManager.IDENTITY_MAX_BYTES}); skipping reflection`);
        return;
      }
    }

    // Rate-limit: skip if last reflection was less than 1 hour ago
    const lastMatch = existing.match(/## Reflection — (\S+)\s*$/m);
    if (lastMatch) {
      // Find the LAST reflection timestamp
      const allMatches = [...existing.matchAll(/## Reflection — (\S+)/g)];
      if (allMatches.length > 0) {
        const lastTimestamp = allMatches[allMatches.length - 1][1];
        const elapsed = Date.now() - new Date(lastTimestamp).getTime();
        if (elapsed < StorageManager.REFLECTION_COOLDOWN_MS) {
          log.debug(`reflection cooldown: ${Math.round(elapsed / 1000)}s since last (need ${StorageManager.REFLECTION_COOLDOWN_MS / 1000}s)`);
          return;
        }
      }
    }

    const timestamp = new Date().toISOString();
    const section = `\n\n## Reflection — ${timestamp}\n\n${reflection}\n`;

    await writeFile(identityPath, existing + section, "utf-8");
    log.debug(`appended reflection to ${identityPath}`);
  }

  async readIdentityReflections(): Promise<string | null> {
    try {
      return await readFile(this.identityReflectionsPath, "utf-8");
    } catch {
      return null;
    }
  }

  async writeIdentityReflections(content: string): Promise<void> {
    await mkdir(this.identityDir, { recursive: true });
    await writeFile(this.identityReflectionsPath, content, "utf-8");
  }

  async appendIdentityReflection(reflection: string): Promise<void> {
    let existing = "";
    try {
      existing = await readFile(this.identityReflectionsPath, "utf-8");
    } catch {
      // File doesn't exist yet.
    }

    if (existing.length > StorageManager.IDENTITY_MAX_BYTES) {
      log.debug(
        `identity/reflections.md is ${existing.length} chars (limit ${StorageManager.IDENTITY_MAX_BYTES}); skipping reflection`,
      );
      return;
    }

    const allMatches = [...existing.matchAll(/## Reflection — (\S+)/g)];
    if (allMatches.length > 0) {
      const lastTimestamp = allMatches[allMatches.length - 1][1];
      const elapsed = Date.now() - new Date(lastTimestamp).getTime();
      if (elapsed < StorageManager.REFLECTION_COOLDOWN_MS) {
        log.debug(
          `reflection cooldown: ${Math.round(elapsed / 1000)}s since last (need ${StorageManager.REFLECTION_COOLDOWN_MS / 1000}s)`,
        );
        return;
      }
    }

    const timestamp = new Date().toISOString();
    const section = `${existing.trimEnd().length > 0 ? "\n\n" : ""}## Reflection — ${timestamp}\n\n${reflection}\n`;
    await mkdir(this.identityDir, { recursive: true });
    await writeFile(this.identityReflectionsPath, `${existing.trimEnd()}${section}`, "utf-8");
    log.debug(`appended namespace-local reflection to ${this.identityReflectionsPath}`);
  }

  // ---------------------------------------------------------------------------
  // Entity mutation helpers (Knowledge Graph v7.0)
  // ---------------------------------------------------------------------------

  /**
   * Add a relationship to an entity file.
   * Deduplicates by target+label.
   */
  async addEntityRelationship(name: string, rel: EntityRelationship): Promise<void> {
    const filePath = path.join(this.entitiesDir, `${name}.md`);
    let entity: EntityFile;
    try {
      const content = await readFile(filePath, "utf-8");
      entity = parseEntityFile(content);
    } catch {
      log.debug(`addEntityRelationship: entity file ${name}.md not found`);
      return;
    }

    // Dedupe by target+label
    const exists = entity.relationships.some(
      (r) => r.target === rel.target && r.label === rel.label,
    );
    if (exists) return;

    entity.relationships.push(rel);
    entity.updated = new Date().toISOString();
    await writeFile(filePath, serializeEntityFile(entity), "utf-8");
    this.invalidateKnowledgeIndexCache();
  }

  /**
   * Add an activity entry to an entity file.
   * Prepends to the beginning, prunes oldest entries beyond maxEntries.
   */
  async addEntityActivity(
    name: string,
    entry: EntityActivityEntry,
    maxEntries: number,
  ): Promise<void> {
    const filePath = path.join(this.entitiesDir, `${name}.md`);
    let entity: EntityFile;
    try {
      const content = await readFile(filePath, "utf-8");
      entity = parseEntityFile(content);
    } catch {
      log.debug(`addEntityActivity: entity file ${name}.md not found`);
      return;
    }

    entity.activity.unshift(entry);
    if (entity.activity.length > maxEntries) {
      entity.activity = entity.activity.slice(0, maxEntries);
    }
    entity.updated = new Date().toISOString();
    await writeFile(filePath, serializeEntityFile(entity), "utf-8");
    this.invalidateKnowledgeIndexCache();
  }

  /**
   * Add an alias to an entity file. Deduplicates.
   */
  async addEntityAlias(name: string, alias: string): Promise<void> {
    const filePath = path.join(this.entitiesDir, `${name}.md`);
    let entity: EntityFile;
    try {
      const content = await readFile(filePath, "utf-8");
      entity = parseEntityFile(content);
    } catch {
      log.debug(`addEntityAlias: entity file ${name}.md not found`);
      return;
    }

    if (entity.aliases.includes(alias)) return;
    entity.aliases.push(alias);
    entity.updated = new Date().toISOString();
    await writeFile(filePath, serializeEntityFile(entity), "utf-8");
    this.invalidateKnowledgeIndexCache();
  }

  /**
   * Set or update the summary of an entity file.
   */
  async updateEntitySummary(name: string, summary: string): Promise<void> {
    const filePath = path.join(this.entitiesDir, `${name}.md`);
    let entity: EntityFile;
    try {
      const content = await readFile(filePath, "utf-8");
      entity = parseEntityFile(content);
    } catch {
      log.debug(`updateEntitySummary: entity file ${name}.md not found`);
      return;
    }

    entity.summary = summary;
    entity.updated = new Date().toISOString();
    await writeFile(filePath, serializeEntityFile(entity), "utf-8");
    this.invalidateKnowledgeIndexCache();
    this.bumpMemoryStatusVersion(); // invalidate entity cache
  }

  // ---------------------------------------------------------------------------
  // Scoring + Knowledge Index (Knowledge Graph v7.0)
  // ---------------------------------------------------------------------------

  /**
   * Read all entity files and return lightweight EntityFile objects.
   * Parsing is fast (~50-100ms for ~1,800 files) since entity files are small.
   */
  async readAllEntityFiles(): Promise<EntityFile[]> {
    const currentVersion = this.getMemoryStatusVersion();
    const cached = getCachedEntities(this.baseDir, currentVersion);
    if (cached) return cached;

    try {
      const entries = await readdir(this.entitiesDir);
      const mdFiles = entries.filter((e) => e.endsWith(".md"));
      if (mdFiles.length === 0) return [];

      // Read all entity files in parallel batches to avoid O(N) sequential I/O.
      // With 3000+ entity files, sequential reads can take 15-20s under load.
      // Batching at 100 keeps file-descriptor pressure manageable while staying fast.
      const BATCH_SIZE = 100;
      const entities: EntityFile[] = [];
      for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
        const batch = mdFiles.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map((entry) =>
            readFile(path.join(this.entitiesDir, entry), "utf-8").catch(() => null),
          ),
        );
        for (const content of results) {
          if (content !== null) entities.push(parseEntityFile(content));
        }
      }

      setCachedEntities(this.baseDir, entities, currentVersion);
      return entities;
    } catch {
      // Directory doesn't exist yet
      return [];
    }
  }

  /**
   * Score an entity based on recency, frequency, activity, type priority,
   * and relationship density.
   *
   * score = recency*0.40 + frequency*0.25 + activity*0.15 + typePriority*0.10 + relationshipDensity*0.10
   */
  static scoreEntity(entity: EntityFile, now: Date): number {
    // Recency: 1 / (1 + daysSince/7) — 7-day half-life
    const updated = entity.updated ? new Date(entity.updated).getTime() : 0;
    const daysSince = Math.max(0, (now.getTime() - updated) / (1000 * 60 * 60 * 24));
    const recency = 1 / (1 + daysSince / 7);

    // Frequency: min(facts.length / 20, 1.0)
    const frequency = Math.min(entity.facts.length / 20, 1.0);

    // Activity: min(activity.length / 10, 1.0)
    const activityScore = Math.min(entity.activity.length / 10, 1.0);

    // Type priority
    const TYPE_PRIORITY: Record<string, number> = {
      person: 1.0,
      project: 0.8,
      company: 0.7,
      tool: 0.6,
      place: 0.5,
      other: 0.3,
    };
    const typePriority = TYPE_PRIORITY[entity.type.toLowerCase()] ?? 0.3;

    // Relationship density: min(relationships.length / 8, 1.0)
    const relDensity = Math.min(entity.relationships.length / 8, 1.0);

    return (
      recency * 0.40 +
      frequency * 0.25 +
      activityScore * 0.15 +
      typePriority * 0.10 +
      relDensity * 0.10
    );
  }

  /**
   * Build the Knowledge Index: a compact markdown table of top-scored entities.
   * Respects maxEntities and maxChars limits from config.
   */
  async buildKnowledgeIndex(
    config: PluginConfig,
    overrides?: { maxEntities?: number; maxChars?: number },
  ): Promise<{ result: string; cached: boolean }> {
    const useDefaultLimits =
      overrides?.maxEntities === undefined &&
      overrides?.maxChars === undefined;
    // Return cached index if still fresh
    if (
      useDefaultLimits &&
      this.knowledgeIndexCache &&
      Date.now() - this.knowledgeIndexCache.builtAt < StorageManager.KNOWLEDGE_INDEX_CACHE_TTL_MS
    ) {
      return { result: this.knowledgeIndexCache.result, cached: true };
    }

    const entities = await this.readAllEntityFiles();
    if (entities.length === 0) {
      if (useDefaultLimits) this.knowledgeIndexCache = { result: "", builtAt: Date.now() };
      return { result: "", cached: false };
    }

    const now = new Date();
    const scored: ScoredEntity[] = entities.map((e) => ({
      name: e.name,
      type: e.type,
      score: StorageManager.scoreEntity(e, now),
      factCount: e.facts.length,
      summary: e.summary,
      topRelationships: e.relationships.slice(0, 3).map((r) => r.target),
    }));

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score);
    const maxEntities = typeof overrides?.maxEntities === "number"
      ? Math.max(0, Math.floor(overrides.maxEntities))
      : config.knowledgeIndexMaxEntities;
    const topN = scored.slice(0, maxEntities);

    if (topN.length === 0) {
      if (useDefaultLimits) this.knowledgeIndexCache = { result: "", builtAt: Date.now() };
      return { result: "", cached: false };
    }

    // Build markdown table
    const header = "## Knowledge Index\n\n| Entity | Type | Summary | Connected to |\n|--------|------|---------|-------------|";
    const rows: string[] = [];
    let totalChars = header.length;
    const maxChars = typeof overrides?.maxChars === "number"
      ? Math.max(0, Math.floor(overrides.maxChars))
      : config.knowledgeIndexMaxChars;

    for (const entity of topN) {
      const summary = entity.summary || `${entity.factCount} facts`;
      const connected = entity.topRelationships.length > 0
        ? entity.topRelationships.join(", ")
        : "—";
      const row = `| ${entity.name} | ${entity.type} | ${summary} | ${connected} |`;

      if (totalChars + row.length + 1 > maxChars) break;
      rows.push(row);
      totalChars += row.length + 1;
    }

    const result = rows.length === 0 ? "" : `${header}\n${rows.join("\n")}\n`;
    if (useDefaultLimits) this.knowledgeIndexCache = { result, builtAt: Date.now() };
    return { result, cached: false };
  }

  /** Invalidate the Knowledge Index cache (call after entity mutations). */
  invalidateKnowledgeIndexCache(): void {
    this.knowledgeIndexCache = null;
  }

  // ---------------------------------------------------------------------------
  // Commitment decay
  // ---------------------------------------------------------------------------

  /** Max lines for profile.md before LLM consolidation triggers */
  private static readonly PROFILE_MAX_LINES = 300;

  /**
   * Merge fragmented entity files that resolve to the same canonical name.
   * Preserves relationships, activity, aliases, and summary from all fragments.
   * Returns count of files merged.
   */
  async mergeFragmentedEntities(): Promise<number> {
    let merged = 0;
    try {
      const entries = await readdir(this.entitiesDir);
      const mdFiles = entries.filter((e) => e.endsWith(".md"));

      // Group files by their canonical name
      const groups = new Map<string, string[]>();
      for (const file of mdFiles) {
        const baseName = file.replace(".md", "");
        // Extract type and name from filename (type-rest-of-name)
        const dashIdx = baseName.indexOf("-");
        if (dashIdx === -1) continue;
        const type = baseName.slice(0, dashIdx);
        const restOfName = baseName.slice(dashIdx + 1);
        const canonical = normalizeEntityName(restOfName, type);

        if (!groups.has(canonical)) groups.set(canonical, []);
        groups.get(canonical)!.push(file);
      }

      // Merge groups with more than one file
      for (const [canonical, files] of groups) {
        if (files.length <= 1) continue;

        // Parse all files and merge into a single EntityFile
        const mergedEntity: EntityFile = {
          name: "",
          type: "other",
          updated: "",
          facts: [],
          summary: undefined,
          relationships: [],
          activity: [],
          aliases: [],
        };

        for (const file of files) {
          const filePath = path.join(this.entitiesDir, file);
          try {
            const content = await readFile(filePath, "utf-8");
            const parsed = parseEntityFile(content);

            // Prefer specific types over "other"
            if (!mergedEntity.type || mergedEntity.type === "other") {
              mergedEntity.type = parsed.type;
            }

            // Keep latest update time
            if (!mergedEntity.updated || parsed.updated > mergedEntity.updated) {
              mergedEntity.updated = parsed.updated;
            }

            // Keep longest/best name
            if (parsed.name.length > mergedEntity.name.length) {
              mergedEntity.name = parsed.name;
            }

            // Keep first non-empty summary
            if (!mergedEntity.summary && parsed.summary) {
              mergedEntity.summary = parsed.summary;
            }

            // Collect all facts
            mergedEntity.facts.push(...parsed.facts);

            // Collect relationships (dedup later)
            mergedEntity.relationships.push(...parsed.relationships);

            // Collect activity entries
            mergedEntity.activity.push(...parsed.activity);

            // Collect aliases
            mergedEntity.aliases.push(...parsed.aliases);
          } catch {
            // Skip unreadable
          }
        }

        // Deduplicate facts
        mergedEntity.facts = [...new Set(mergedEntity.facts)];

        // Deduplicate relationships by target+label
        const relKeys = new Set<string>();
        mergedEntity.relationships = mergedEntity.relationships.filter((r) => {
          const key = `${r.target}::${r.label}`;
          if (relKeys.has(key)) return false;
          relKeys.add(key);
          return true;
        });

        // Sort activity by date descending, deduplicate by date+note
        const actKeys = new Set<string>();
        mergedEntity.activity = mergedEntity.activity
          .filter((a) => {
            const key = `${a.date}::${a.note}`;
            if (actKeys.has(key)) return false;
            actKeys.add(key);
            return true;
          })
          .sort((a, b) => b.date.localeCompare(a.date));

        // Deduplicate aliases
        mergedEntity.aliases = [...new Set(mergedEntity.aliases)];

        // Fallback name from canonical
        if (!mergedEntity.name) {
          const dashIdx = canonical.indexOf("-");
          mergedEntity.name = dashIdx !== -1 ? canonical.slice(dashIdx + 1) : canonical;
        }

        mergedEntity.updated = mergedEntity.updated || new Date().toISOString();

        const canonicalPath = path.join(this.entitiesDir, `${canonical}.md`);
        await writeFile(canonicalPath, serializeEntityFile(mergedEntity), "utf-8");

        // Remove non-canonical files
        for (const file of files) {
          const filePath = path.join(this.entitiesDir, file);
          if (filePath !== canonicalPath) {
            try {
              await unlink(filePath);
              merged++;
              log.debug(`merged entity ${file} → ${canonical}.md`);
            } catch {
              // Ignore
            }
          }
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return merged;
  }

  async cleanExpiredCommitments(decayDays: number): Promise<MemoryFile[]> {
    const memories = await this.readAllMemories();
    const cutoff = Date.now() - decayDays * 24 * 60 * 60 * 1000;
    const deleted: MemoryFile[] = [];

    for (const m of memories) {
      if (m.frontmatter.category !== "commitment") continue;
      // Only decay commitments that have been marked as resolved/expired
      // (indicated by tags containing "fulfilled" or "expired")
      const isResolved = m.frontmatter.tags.some(
        (t) => t === "fulfilled" || t === "expired",
      );
      if (!isResolved) continue;

      const updatedAt = new Date(m.frontmatter.updated).getTime();
      if (updatedAt < cutoff) {
        // Remove the file
        try {
          await unlink(m.path);
          deleted.push(m);
          log.debug(`cleaned expired commitment ${m.frontmatter.id}`);
        } catch {
          // Ignore
        }
      }
    }

    if (deleted.length > 0) {
      this.bumpMemoryStatusVersion();
    }

    return deleted;
  }

  // ---------------------------------------------------------------------------
  // Access Tracking (Phase 1A)
  // ---------------------------------------------------------------------------

  /**
   * Flush batched access tracking updates to disk.
   * Called during consolidation or when buffer exceeds max size.
   */
  async flushAccessTracking(entries: AccessTrackingEntry[]): Promise<number> {
    if (entries.length === 0) return 0;

    const memories = await this.readAllMemories();
    const memoryMap = new Map(memories.map((m) => [m.frontmatter.id, m]));
    let updated = 0;

    for (const entry of entries) {
      const memory = memoryMap.get(entry.memoryId);
      if (!memory) continue;

      const newFm: MemoryFrontmatter = {
        ...memory.frontmatter,
        accessCount: entry.newCount,
        lastAccessed: entry.lastAccessed,
      };

      const fileContent = `${serializeFrontmatter(newFm)}\n\n${memory.content}\n`;
      try {
        await writeFile(memory.path, fileContent, "utf-8");
        updated++;
      } catch (err) {
        log.debug(`failed to update access tracking for ${entry.memoryId}: ${err}`);
      }
    }

    if (updated > 0) {
      log.debug(`flushed access tracking for ${updated} memories`);
    }
    return updated;
  }

  /**
   * Get a memory by its ID.
   */
  async getMemoryById(id: string): Promise<MemoryFile | null> {
    const memories = await this.readAllMemories();
    return memories.find((m) => m.frontmatter.id === id) ?? null;
  }

  async getProjectedMemoryState(id: string): Promise<MemoryProjectionCurrentState | null> {
    const projected = readProjectedMemoryState(this.baseDir, id);
    if (projected) return projected;

    const active = await this.getMemoryById(id);
    if (active) return this.toProjectedCurrentState(active, "active");

    const archived = (await this.readArchivedMemories()).find((memory) => memory.frontmatter.id === id);
    if (!archived) return null;

    return this.toProjectedCurrentState(archived, "archived");
  }

  async browseProjectedMemories(
    options: ProjectedMemoryBrowseOptions,
  ): Promise<ProjectedMemoryBrowsePage | null> {
    return readProjectedMemoryBrowse(this.baseDir, options);
  }

  async getProjectedGovernanceRecord(): Promise<ReturnType<typeof readProjectedGovernanceRecord>> {
    return readProjectedGovernanceRecord(this.baseDir);
  }

  private toProjectedCurrentState(
    memory: MemoryFile,
    fallbackStatus: MemoryStatus,
  ): MemoryProjectionCurrentState {
    const pathRel = toMemoryPathRel(this.baseDir, memory.path);
    return {
      memoryId: memory.frontmatter.id,
      category: memory.frontmatter.category,
      status: inferCurrentStateStatus(memory.frontmatter, pathRel, fallbackStatus),
      lifecycleState: memory.frontmatter.lifecycleState,
      path: memory.path,
      pathRel,
      created: memory.frontmatter.created,
      updated: memory.frontmatter.updated,
      archivedAt: memory.frontmatter.archivedAt,
      supersededAt: memory.frontmatter.supersededAt,
      entityRef: memory.frontmatter.entityRef,
      source: memory.frontmatter.source,
      confidence: memory.frontmatter.confidence,
      confidenceTier: memory.frontmatter.confidenceTier,
      memoryKind: memory.frontmatter.memoryKind,
      accessCount: memory.frontmatter.accessCount,
      lastAccessed: memory.frontmatter.lastAccessed,
      tags: normalizeProjectionTags(memory.frontmatter.tags),
      preview: normalizeProjectionPreview(memory.content),
    };
  }

  async getMemoryTimeline(memoryId: string, limit: number = 200): Promise<MemoryLifecycleEvent[]> {
    const cappedLimit = Math.max(0, Math.floor(limit));
    if (cappedLimit === 0) return [];

    const projected = readProjectedMemoryTimeline(this.baseDir, memoryId, cappedLimit);
    if (projected && projected.length > 0) return projected;

    const events = await this.readAllMemoryLifecycleEvents();
    return events.filter((event) => event.memoryId === memoryId).slice(-cappedLimit);
  }

  // ---------------------------------------------------------------------------
  // Chunking (Phase 2A)
  // ---------------------------------------------------------------------------

  /**
   * Write a memory chunk with parent reference.
   * Chunk IDs follow format: {parentId}-chunk-{index}
   */
  async writeChunk(
    parentId: string,
    chunkIndex: number,
    chunkTotal: number,
    category: MemoryCategory,
    content: string,
    options: {
      confidence?: number;
      tags?: string[];
      entityRef?: string;
      source?: string;
      importance?: ImportanceScore;
      intentGoal?: string;
      intentActionType?: string;
      intentEntityTypes?: string[];
      memoryKind?: MemoryFrontmatter["memoryKind"];
    } = {},
  ): Promise<string> {
    await this.ensureDirectories();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const id = `${parentId}-chunk-${chunkIndex}`;
    const conf = options.confidence ?? 0.8;
    const tier = confidenceTier(conf);

    const fm: MemoryFrontmatter = {
      id,
      category,
      created: now.toISOString(),
      updated: now.toISOString(),
      source: options.source ?? "chunking",
      confidence: conf,
      confidenceTier: tier,
      tags: options.tags ?? [],
      entityRef: options.entityRef,
      importance: options.importance,
      parentId,
      chunkIndex,
      chunkTotal,
      intentGoal: options.intentGoal,
      intentActionType: options.intentActionType,
      intentEntityTypes: options.intentEntityTypes,
      memoryKind: options.memoryKind,
    };

    const sanitized = sanitizeMemoryContent(content);
    if (!sanitized.clean) {
      log.warn(`chunk content sanitized for ${id}; violations=${sanitized.violations.join(", ")}`);
    }
    const fileContent = `${serializeFrontmatter(fm)}\n\n${sanitized.text}\n`;

    let filePath: string;
    if (category === "correction") {
      filePath = path.join(this.correctionsDir, `${id}.md`);
    } else {
      filePath = path.join(this.factsDir, today, `${id}.md`);
    }

    await writeFile(filePath, fileContent, "utf-8");
    log.debug(`wrote chunk ${id} (${chunkIndex + 1}/${chunkTotal}) to ${filePath}`);
    return id;
  }

  /**
   * Get all chunks for a given parent memory ID.
   * Returns chunks sorted by chunkIndex.
   */
  async getChunksForParent(parentId: string): Promise<MemoryFile[]> {
    const memories = await this.readAllMemories();
    return memories
      .filter((m) => m.frontmatter.parentId === parentId)
      .sort((a, b) => (a.frontmatter.chunkIndex ?? 0) - (b.frontmatter.chunkIndex ?? 0));
  }

  // ---------------------------------------------------------------------------
  // Contradiction Detection (Phase 2B)
  // ---------------------------------------------------------------------------

  /**
   * Mark a memory as superseded by another.
   * Updates the old memory's status and adds the supersededBy link.
   */
  async supersedeMemory(
    oldMemoryId: string,
    newMemoryId: string,
    reason: string,
  ): Promise<boolean> {
    const memories = await this.readAllMemories();
    const oldMemory = memories.find((m) => m.frontmatter.id === oldMemoryId);
    if (!oldMemory) return false;

    const now = new Date().toISOString();
    const updatedFm: MemoryFrontmatter = {
      ...oldMemory.frontmatter,
      status: "superseded",
      supersededBy: newMemoryId,
      supersededAt: now,
      updated: now,
    };

    const fileContent = `${serializeFrontmatter(updatedFm)}\n\n${oldMemory.content}\n`;

    try {
      await writeFile(oldMemory.path, fileContent, "utf-8");
      await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.supersedeMemory", {
        memoryId: oldMemoryId,
        eventType: "superseded",
        timestamp: now,
        actor: "storage.supersedeMemory",
        reasonCode: reason,
        before: this.summarizeLifecycleState(oldMemory.frontmatter, oldMemory.path),
        after: this.summarizeLifecycleState(updatedFm, oldMemory.path),
        relatedMemoryIds: [newMemoryId],
      });
      this.bumpMemoryStatusVersion();
      log.debug(`superseded memory ${oldMemoryId} by ${newMemoryId}: ${reason}`);

      // Also write a correction entry for the audit trail
      await this.writeMemory("correction", `Superseded: ${oldMemory.content}\n\nReason: ${reason}`, {
        confidence: 1.0,
        tags: ["supersession", "auto-resolved"],
        source: "contradiction-detection",
        lineage: [oldMemoryId, newMemoryId],
      });

      return true;
    } catch (err) {
      log.error(`failed to supersede memory ${oldMemoryId}:`, err);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Memory Summarization (Phase 4A)
  // ---------------------------------------------------------------------------

  private get summariesDir(): string {
    return path.join(this.baseDir, "summaries");
  }

  /**
   * Write a memory summary.
   */
  async writeSummary(summary: MemorySummary): Promise<void> {
    await mkdir(this.summariesDir, { recursive: true });
    const filePath = path.join(this.summariesDir, `${summary.id}.json`);
    await writeFile(filePath, JSON.stringify(summary, null, 2), "utf-8");
    log.debug(`wrote summary ${summary.id}`);
  }

  /**
   * Get all summaries.
   */
  async readSummaries(): Promise<MemorySummary[]> {
    try {
      const files = await readdir(this.summariesDir);
      const summaries: MemorySummary[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(this.summariesDir, file);
        const raw = await readFile(filePath, "utf-8");
        summaries.push(JSON.parse(raw) as MemorySummary);
      }

      return summaries;
    } catch {
      return [];
    }
  }

  /**
   * Archive memories (mark as archived, not delete).
   */
  async archiveMemories(memoryIds: string[], summaryId: string): Promise<number> {
    const memories = await this.readAllMemories();
    const memoryMap = new Map(memories.map((m) => [m.frontmatter.id, m]));
    let archived = 0;

    for (const id of memoryIds) {
      const memory = memoryMap.get(id);
      if (!memory) continue;

      const now = new Date().toISOString();
      const updatedFm: MemoryFrontmatter = {
        ...memory.frontmatter,
        status: "archived",
        archivedAt: now,
        updated: now,
      };

      const fileContent = `${serializeFrontmatter(updatedFm)}\n\n${memory.content}\n`;

      try {
        await writeFile(memory.path, fileContent, "utf-8");
        await this.appendGeneratedMemoryLifecycleEventFailOpen("storage.archiveMemories", {
          memoryId: id,
          eventType: "archived",
          timestamp: updatedFm.archivedAt ?? updatedFm.updated,
          actor: "storage.archiveMemories",
          reasonCode: `summary:${summaryId}`,
          before: this.summarizeLifecycleState(memory.frontmatter, memory.path),
          after: this.summarizeLifecycleState(updatedFm, memory.path),
          relatedMemoryIds: [summaryId],
        });
        archived++;
      } catch {
        // Ignore individual failures
      }
    }

    if (archived > 0) {
      this.bumpMemoryStatusVersion();
      log.debug(`archived ${archived} memories for summary ${summaryId}`);
    }
    return archived;
  }

  // ---------------------------------------------------------------------------
  // Topic Extraction (Phase 4B)
  // ---------------------------------------------------------------------------

  /**
   * Save topic scores to meta.json.
   */
  async saveTopics(topics: TopicScore[]): Promise<void> {
    const metaPath = path.join(this.stateDir, "topics.json");
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify({ topics, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
    log.debug(`saved ${topics.length} topic scores`);
  }

  /**
   * Load topic scores from meta.json.
   */
  async loadTopics(): Promise<{ topics: TopicScore[]; updatedAt: string | null }> {
    const metaPath = path.join(this.stateDir, "topics.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      return JSON.parse(raw) as { topics: TopicScore[]; updatedAt: string | null };
    } catch {
      return { topics: [], updatedAt: null };
    }
  }

  /**
   * Add links to an existing memory.
   */
  async addLinksToMemory(
    memoryId: string,
    links: MemoryLink[],
    lifecycle?: MemoryLifecycleEventWriteOptions,
  ): Promise<boolean> {
    const memories = await this.readAllMemories();
    const memory = memories.find((m) => m.frontmatter.id === memoryId);
    if (!memory) return false;

    const existingLinks = memory.frontmatter.links ?? [];
    const mergedLinks = [...existingLinks];

    // Add new links, avoiding duplicates
    for (const link of links) {
      if (!mergedLinks.some((l) => l.targetId === link.targetId && l.linkType === link.linkType)) {
        mergedLinks.push(link);
      }
    }

    try {
      await this.writeMemoryFrontmatter(
        memory,
        {
          links: mergedLinks,
          updated: new Date().toISOString(),
        },
        lifecycle,
      );
      log.debug(`added ${links.length} links to memory ${memoryId}`);
      return true;
    } catch (err) {
      log.error(`failed to add links to memory ${memoryId}:`, err);
      return false;
    }
  }

  private summarizeLifecycleState(
    frontmatter: MemoryFrontmatter,
    filePath: string,
  ): MemoryLifecycleStateSummary {
    return {
      category: frontmatter.category,
      path: filePath,
      status: frontmatter.status ?? "active",
      lifecycleState: frontmatter.lifecycleState,
    };
  }

  private frontmatterPatchEventType(
    before: MemoryFrontmatter,
    after: MemoryFrontmatter,
  ): MemoryLifecycleEventType {
    const beforeStatus = before.status ?? "active";
    const afterStatus = after.status ?? "active";
    if (beforeStatus !== "archived" && afterStatus === "archived") return "archived";
    if (beforeStatus !== "superseded" && afterStatus === "superseded") return "superseded";
    if (beforeStatus !== "rejected" && afterStatus === "rejected") return "rejected";
    if (beforeStatus !== "active" && afterStatus === "active") {
      return "restored";
    }
    return "updated";
  }

  private async appendGeneratedMemoryLifecycleEvent(
    input: Omit<MemoryLifecycleEvent, "eventId" | "ruleVersion">,
    ruleVersion = "memory-lifecycle-ledger.v1",
  ): Promise<void> {
    await this.appendMemoryLifecycleEvents([
      {
        ...input,
        eventId: this.generateId("mle"),
        ruleVersion,
      },
    ]);
  }

  private async appendGeneratedMemoryLifecycleEventFailOpen(
    operation: string,
    input: Omit<MemoryLifecycleEvent, "eventId" | "ruleVersion">,
    ruleVersion?: string,
  ): Promise<void> {
    try {
      await this.appendGeneratedMemoryLifecycleEvent(input, ruleVersion);
    } catch (appendErr) {
      log.warn(`${operation} completed but failed to append lifecycle event: ${appendErr}`);
    }
  }
}
