import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import type {
  AccessTrackingEntry,
  BufferState,
  ConfidenceTier,
  ImportanceLevel,
  ImportanceScore,
  MemoryCategory,
  MemoryFile,
  MemoryFrontmatter,
  MemoryLink,
  MemoryStatus,
  MemorySummary,
  MetaState,
  TopicScore,
} from "./types.js";
import { confidenceTier, SPECULATIVE_TTL_DAYS } from "./types.js";

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
      lines.push(`importanceReasons: [${fm.importance.reasons.map((r) => `"${r.replace(/"/g, '\\"')}"`).join(", ")}]`);
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
      if (link.reason) lines.push(`    reason: "${link.reason.replace(/"/g, '\\"')}"`);
    }
  }
  lines.push("---");
  return lines.join("\n");
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

  // Parse importance
  let importance: ImportanceScore | undefined;
  if (fm.importanceScore) {
    const score = parseFloat(fm.importanceScore);
    const level = (fm.importanceLevel as ImportanceLevel) || "normal";

    // Parse importance reasons array
    let reasons: string[] = [];
    const reasonsStr = fm.importanceReasons ?? "";
    const reasonsMatch = reasonsStr.match(/\[(.*)]/);
    if (reasonsMatch) {
      reasons = reasonsMatch[1]
        .split(/",\s*"/)
        .map((r) => r.replace(/^"|"$/g, "").replace(/\\"/g, '"'))
        .filter(Boolean);
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
    },
    content,
  };

  // Parse links (YAML array format)
  // Note: Simple parsing - for full YAML we'd need a library.
  if (fmBlock.includes("links:")) {
    const links: MemoryLink[] = [];
    const linkMatches = fmBlock.matchAll(
      /- targetId: (\S+)\s+linkType: (\S+)\s+strength: ([\d.]+)(?:\s+reason: "([^"]*)")?/g,
    );
    for (const match of linkMatches) {
      links.push({
        targetId: match[1],
        linkType: match[2] as MemoryLink["linkType"],
        strength: parseFloat(match[3]),
        reason: match[4] || undefined,
      });
    }
    if (links.length > 0) {
      result.frontmatter.links = links;
    }
  }

  return result;
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

export class StorageManager {
  constructor(private readonly baseDir: string) {}

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
  private get questionsDir(): string {
    return path.join(this.baseDir, "questions");
  }
  private get profilePath(): string {
    return path.join(this.baseDir, "profile.md");
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
    await mkdir(path.join(this.baseDir, "config"), { recursive: true });
  }

  async writeMemory(
    category: MemoryCategory,
    content: string,
    options: {
      confidence?: number;
      tags?: string[];
      entityRef?: string;
      source?: string;
      supersedes?: string;
      lineage?: string[];
      importance?: ImportanceScore;
      links?: MemoryLink[];
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
    if (tier === "speculative") {
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
    };

    const fileContent = `${serializeFrontmatter(fm)}\n\n${content}\n`;

    let filePath: string;
    if (category === "correction") {
      filePath = path.join(this.correctionsDir, `${id}.md`);
    } else {
      filePath = path.join(this.factsDir, today, `${id}.md`);
    }

    await writeFile(filePath, fileContent, "utf-8");
    log.debug(`wrote memory ${id} to ${filePath}`);
    return id;
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

    let existingFacts: string[] = [];
    try {
      const existing = await readFile(filePath, "utf-8");
      const lines = existing.split("\n");
      existingFacts = lines
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2).trim());
    } catch {
      // File doesn't exist yet
    }

    const allFacts = [...new Set([...existingFacts, ...safeFacts])];
    const content = [
      `# ${name}`,
      "",
      `**Type:** ${type}`,
      `**Updated:** ${new Date().toISOString()}`,
      "",
      "## Facts",
      "",
      ...allFacts.map((f) => `- ${f}`),
      "",
    ].join("\n");

    await writeFile(filePath, content, "utf-8");
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
  async profileNeedsConsolidation(): Promise<boolean> {
    const profile = await this.readProfile();
    if (!profile) return false;
    const lineCount = profile.split("\n").length;
    return lineCount > StorageManager.PROFILE_MAX_LINES;
  }

  async readAllMemories(): Promise<MemoryFile[]> {
    const memories: MemoryFile[] = [];

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
                  frontmatter: parsed.frontmatter,
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

    await readDir(this.factsDir);
    await readDir(this.correctionsDir);
    return memories;
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
      log.debug(`invalidated memory ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  async updateMemory(
    id: string,
    newContent: string,
    options?: { supersedes?: string; lineage?: string[] },
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
    const fileContent = `${serializeFrontmatter(updated)}\n\n${newContent}\n`;
    await writeFile(memory.path, fileContent, "utf-8");
    log.debug(`updated memory ${id}`);
    return true;
  }

  /** Remove memories past their TTL expiresAt date */
  async cleanExpiredTTL(): Promise<number> {
    const memories = await this.readAllMemories();
    const now = Date.now();
    let cleaned = 0;

    for (const m of memories) {
      if (!m.frontmatter.expiresAt) continue;
      const expiresAt = new Date(m.frontmatter.expiresAt).getTime();
      if (expiresAt < now) {
        try {
          await unlink(m.path);
          cleaned++;
          log.debug(`cleaned expired memory ${m.frontmatter.id} (TTL expired)`);
        } catch {
          // Ignore
        }
      }
    }

    return cleaned;
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

  // ---------------------------------------------------------------------------
  // Question storage
  // ---------------------------------------------------------------------------

  private generateId(prefix: string = "m"): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 4);
    return `${prefix}-${ts}-${rand}`;
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
    try {
      const files = await readdir(this.questionsDir);
      const questions = [];
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(this.questionsDir, file);
        const raw = await readFile(filePath, "utf-8");
        const parsed = this.parseQuestionFile(raw, filePath);
        if (parsed) {
          if (opts?.unresolvedOnly && parsed.resolved) continue;
          questions.push(parsed);
        }
      }
      return questions.sort((a, b) => b.priority - a.priority);
    } catch {
      return [];
    }
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

  async readIdentity(workspaceDir: string): Promise<string> {
    const identityPath = path.join(workspaceDir, "IDENTITY.md");
    try {
      return await readFile(identityPath, "utf-8");
    } catch {
      return "";
    }
  }

  async writeIdentity(workspaceDir: string, content: string): Promise<void> {
    const identityPath = path.join(workspaceDir, "IDENTITY.md");
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
  ): Promise<void> {
    const identityPath = path.join(workspaceDir, "IDENTITY.md");

    let existing = "";
    try {
      existing = await readFile(identityPath, "utf-8");
    } catch {
      // File doesn't exist yet
    }

    // Rate-limit: skip if file is too large
    if (existing.length > StorageManager.IDENTITY_MAX_BYTES) {
      log.debug(`IDENTITY.md is ${existing.length} chars (limit ${StorageManager.IDENTITY_MAX_BYTES}); skipping reflection`);
      return;
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

  // ---------------------------------------------------------------------------
  // Commitment decay
  // ---------------------------------------------------------------------------

  /** Max lines for profile.md before LLM consolidation triggers */
  private static readonly PROFILE_MAX_LINES = 300;

  /**
   * Merge fragmented entity files that resolve to the same canonical name.
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

        // Collect all facts from all files
        const allFacts: string[] = [];
        let bestType = "";
        let latestUpdate = "";

        for (const file of files) {
          const filePath = path.join(this.entitiesDir, file);
          try {
            const content = await readFile(filePath, "utf-8");
            const lines = content.split("\n");

            // Extract type
            const typeLine = lines.find((l) => l.startsWith("**Type:**"));
            if (typeLine) {
              const t = typeLine.replace("**Type:**", "").trim();
              // Prefer "company" or "project" or "person" over "other"
              if (!bestType || bestType === "other") bestType = t;
            }

            // Extract update time
            const updatedLine = lines.find((l) => l.startsWith("**Updated:**"));
            if (updatedLine) {
              const u = updatedLine.replace("**Updated:**", "").trim();
              if (!latestUpdate || u > latestUpdate) latestUpdate = u;
            }

            // Extract facts
            const facts = lines
              .filter((l) => l.startsWith("- "))
              .map((l) => l.slice(2).trim());
            allFacts.push(...facts);
          } catch {
            // Skip unreadable
          }
        }

        // Deduplicate facts
        const uniqueFacts = [...new Set(allFacts)];

        // Extract readable name from canonical (strip type prefix)
        const dashIdx = canonical.indexOf("-");
        const readableName = dashIdx !== -1 ? canonical.slice(dashIdx + 1) : canonical;

        // Write merged file
        const content = [
          `# ${readableName}`,
          "",
          `**Type:** ${bestType || "other"}`,
          `**Updated:** ${latestUpdate || new Date().toISOString()}`,
          "",
          "## Facts",
          "",
          ...uniqueFacts.map((f) => `- ${f}`),
          "",
        ].join("\n");

        const canonicalPath = path.join(this.entitiesDir, `${canonical}.md`);
        await writeFile(canonicalPath, content, "utf-8");

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

  async cleanExpiredCommitments(decayDays: number): Promise<number> {
    const memories = await this.readAllMemories();
    const cutoff = Date.now() - decayDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;

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
          cleaned++;
          log.debug(`cleaned expired commitment ${m.frontmatter.id}`);
        } catch {
          // Ignore
        }
      }
    }

    return cleaned;
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
    };

    const fileContent = `${serializeFrontmatter(fm)}\n\n${content}\n`;

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
        archived++;
      } catch {
        // Ignore individual failures
      }
    }

    if (archived > 0) {
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
  async addLinksToMemory(memoryId: string, links: MemoryLink[]): Promise<boolean> {
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

    const updatedFm: MemoryFrontmatter = {
      ...memory.frontmatter,
      links: mergedLinks,
      updated: new Date().toISOString(),
    };

    const fileContent = `${serializeFrontmatter(updatedFm)}\n\n${memory.content}\n`;

    try {
      await writeFile(memory.path, fileContent, "utf-8");
      log.debug(`added ${links.length} links to memory ${memoryId}`);
      return true;
    } catch (err) {
      log.error(`failed to add links to memory ${memoryId}:`, err);
      return false;
    }
  }
}
