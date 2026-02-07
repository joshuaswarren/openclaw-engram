import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import type {
  BufferState,
  ConfidenceTier,
  MemoryCategory,
  MemoryFile,
  MemoryFrontmatter,
  MetaState,
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

  return {
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
    },
    content,
  };
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
  let name = raw.toLowerCase().trim();
  const typePrefix = `${type.toLowerCase()}-`;
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

  return `${type.toLowerCase()}-${normalized}`;
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

    const allFacts = [...new Set([...existingFacts, ...facts])];
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
}
