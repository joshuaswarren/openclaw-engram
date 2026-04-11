/**
 * codex-materialize.ts — Codex CLI native memory artifact materialization (#378)
 *
 * Periodically writes Remnic memories into the file layout that Codex CLI's
 * phase-2 consolidation reads directly under `<codex_home>/memories/`:
 *
 *   memory_summary.md                — always-loaded at session start (tight budget)
 *   MEMORY.md                        — searchable handbook (task-group schema)
 *   raw_memories.md                  — mechanical merge of raw memories, latest first
 *   rollout_summaries/<slug>.md      — per-session recaps
 *
 * Codex's own read path is agnostic to which producer wrote these files — it
 * tags reads by `memory_md` / `memory_summary` / `raw_memories` /
 * `rollout_summaries` / `skills`. By materializing Remnic content into this
 * exact layout we let Codex pick up Remnic memories without a single MCP call.
 *
 * Safety invariants
 * ─────────────────
 *  - **Atomic writes.** Every file is rendered under `.remnic-tmp/` and then
 *    `rename()`d into place so Codex never observes a half-written file.
 *  - **Sentinel-based opt-in.** If `<codex_home>/memories/.remnic-managed` is
 *    missing, we SKIP materialization entirely and log a warning. This honors
 *    user hand-edits to the directory — a user who manually curated their
 *    Codex memory layout will never have those edits overwritten.
 *  - **Schema validation.** `MEMORY.md` content is validated against the
 *    task-group schema before write. Invalid content throws and nothing is
 *    written.
 *  - **Idempotent no-ops.** A content hash is written into the sentinel. If
 *    the re-rendered hash matches the previous run, we skip writes entirely.
 *  - **Token budget.** `memory_summary.md` is truncated to fit under the
 *    configured token budget (whitespace-tokenized approximation), leaving
 *    headroom under Codex's 5000-token summary cap.
 *
 * Privacy
 * ───────
 * This module does not persist any user content outside `<codex_home>/memories`
 * — it only mirrors the memories that Remnic already wrote. It does not log
 * memory content to stdout; it logs file names, counts, and hashes.
 */

import {
  createHash,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { log } from "../logger.js";
import type { MemoryFile } from "../types.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Input for {@link materializeForNamespace}. Prefer passing pre-loaded
 * `memories` so this module stays I/O-agnostic and trivially testable.
 */
export interface MaterializeOptions {
  /** Pre-loaded Remnic memories for this namespace (required). */
  memories: MemoryFile[];
  /** Override `<codex_home>`. Defaults to `$CODEX_HOME` or `~/.codex`. */
  codexHome?: string;
  /** Maximum whitespace-tokenized size of memory_summary.md. Default 4500. */
  maxSummaryTokens?: number;
  /** Maximum age of rollout_summaries/*.md in days. Default 30. */
  rolloutRetentionDays?: number;
  /** Per-session rollout summaries to render. */
  rolloutSummaries?: RolloutSummaryInput[];
  /** Current time, injected for deterministic tests. */
  now?: Date;
  /** Optional logger override for tests. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; debug?: (msg: string) => void };
}

/** Input describing one Codex rollout summary file. */
export interface RolloutSummaryInput {
  /** Stable slug for the file (becomes `<slug>.md`). */
  slug: string;
  /** Working directory used during the rollout. */
  cwd?: string;
  /** Path to the raw Codex rollout log, if known. */
  rolloutPath?: string;
  /** ISO-8601 timestamp of the last update. */
  updatedAt?: string;
  /** Opaque thread / session id. */
  threadId?: string;
  /** Markdown body for the recap. */
  body: string;
  /** Freeform keywords / search hints. */
  keywords?: string[];
}

/** Result of a materialization run. */
export interface MaterializeResult {
  /** Namespace that was materialized. */
  namespace: string;
  /** `<codex_home>/memories` path this run targeted. */
  memoriesDir: string;
  /** Was anything actually written (vs. skipped / idempotent no-op)? */
  wrote: boolean;
  /** True if the sentinel was missing and we skipped with a warning. */
  skippedNoSentinel: boolean;
  /** True if the hash matched the previous run and we short-circuited. */
  skippedIdempotent: boolean;
  /** Files that were written this run (relative to `memoriesDir`). */
  filesWritten: string[];
  /** Content hash computed for this run. */
  contentHash: string;
}

/** On-disk shape of the `.remnic-managed` sentinel. */
interface SentinelFile {
  version: number;
  namespace: string;
  updated_at: string;
  content_hash: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Bump when the on-disk layout or semantics change. */
export const MATERIALIZE_VERSION = 1;

/** Sentinel file name at the root of the materialized memories dir. */
export const SENTINEL_FILE = ".remnic-managed";

/** Scratch directory used for atomic renames. */
export const TMP_DIR = ".remnic-tmp";

/** File names we own. Anything else in the directory is considered user-managed. */
const OWNED_FILES = new Set<string>([
  "memory_summary.md",
  "MEMORY.md",
  "raw_memories.md",
]);

/** Sub-directory for per-session rollout recaps. */
const ROLLOUT_SUBDIR = "rollout_summaries";

// ─── Public entry points ───────────────────────────────────────────────────

/**
 * Materialize a Remnic namespace into Codex's native memory layout.
 *
 * Returns a {@link MaterializeResult} describing what happened. Callers
 * should treat "skipped" as success — the sentinel / idempotent cases are
 * expected and intentional.
 *
 * @throws if `MEMORY.md` fails schema validation (we do not write garbage).
 */
export function materializeForNamespace(
  namespace: string,
  options: MaterializeOptions,
): MaterializeResult {
  const logger = options.logger ?? {
    info: (msg) => log.info(`[codex-materialize] ${msg}`),
    warn: (msg) => log.warn(`[codex-materialize] ${msg}`),
    debug: (msg) => log.debug(`[codex-materialize] ${msg}`),
  };
  const codexHome = resolveCodexHome(options.codexHome);
  const memoriesDir = path.join(codexHome, "memories");
  const now = options.now ?? new Date();
  const maxSummaryTokens =
    typeof options.maxSummaryTokens === "number" && options.maxSummaryTokens > 0
      ? options.maxSummaryTokens
      : 4500;
  const rolloutRetentionDays =
    typeof options.rolloutRetentionDays === "number" && options.rolloutRetentionDays >= 0
      ? options.rolloutRetentionDays
      : 30;

  mkdirSync(memoriesDir, { recursive: true });

  // ── Sentinel check ─────────────────────────────────────────────────────
  const sentinelPath = path.join(memoriesDir, SENTINEL_FILE);
  const existingSentinel = readSentinel(sentinelPath);
  if (!existingSentinel) {
    logger.warn(
      `sentinel ${SENTINEL_FILE} missing in ${memoriesDir}; skipping materialization to preserve hand-edits`,
    );
    return {
      namespace,
      memoriesDir,
      wrote: false,
      skippedNoSentinel: true,
      skippedIdempotent: false,
      filesWritten: [],
      contentHash: "",
    };
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const memories = [...options.memories];
  const rolloutSummaries = options.rolloutSummaries ?? [];

  const memorySummary = renderMemorySummary({
    namespace,
    memories,
    rolloutSummaries,
    maxTokens: maxSummaryTokens,
    now,
  });

  const memoryMd = renderMemoryMd({
    namespace,
    memories,
    rolloutSummaries,
    now,
  });

  // Fail fast on schema issues — do not write garbage.
  const validation = validateMemoryMd(memoryMd);
  if (!validation.valid) {
    const reason = validation.errors.join("; ");
    logger.warn(`MEMORY.md failed schema validation: ${reason}`);
    throw new Error(`codex-materialize: MEMORY.md schema validation failed: ${reason}`);
  }

  const rawMemories = renderRawMemories({ memories });

  const retainedRollouts = pruneRollouts(rolloutSummaries, rolloutRetentionDays, now);
  // Deduplicate on sanitized filename. Two different slugs ("Session 1" and
  // "session_1") can sanitize to the same output ("session-1"), which would
  // otherwise make the first entry's tmp file get overwritten and cause the
  // later rename step to crash with ENOENT. We keep the *last* entry with a
  // given sanitized name so the most-recent rollout for that slot wins.
  const rolloutFileMap = new Map<string, { name: string; body: string }>();
  for (const r of retainedRollouts) {
    const name = `${sanitizeSlug(r.slug)}.md`;
    rolloutFileMap.set(name, { name, body: renderRolloutSummary(r) });
  }
  const rolloutFiles = [...rolloutFileMap.values()];

  // ── Idempotence check ──────────────────────────────────────────────────
  const hash = computeContentHash({
    namespace,
    memorySummary,
    memoryMd,
    rawMemories,
    rolloutFiles,
  });

  if (existingSentinel.content_hash === hash) {
    logger.debug?.(`no-op materialization for namespace=${namespace} (hash unchanged)`);
    return {
      namespace,
      memoriesDir,
      wrote: false,
      skippedNoSentinel: false,
      skippedIdempotent: true,
      filesWritten: [],
      contentHash: hash,
    };
  }

  // ── Atomic writes ──────────────────────────────────────────────────────
  const tmpDir = path.join(memoriesDir, TMP_DIR);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(path.join(tmpDir, ROLLOUT_SUBDIR), { recursive: true });

  const filesWritten: string[] = [];

  writeFileSync(path.join(tmpDir, "memory_summary.md"), memorySummary);
  filesWritten.push("memory_summary.md");

  writeFileSync(path.join(tmpDir, "MEMORY.md"), memoryMd);
  filesWritten.push("MEMORY.md");

  writeFileSync(path.join(tmpDir, "raw_memories.md"), rawMemories);
  filesWritten.push("raw_memories.md");

  for (const rollout of rolloutFiles) {
    writeFileSync(path.join(tmpDir, ROLLOUT_SUBDIR, rollout.name), rollout.body);
    filesWritten.push(path.join(ROLLOUT_SUBDIR, rollout.name));
  }

  // Rename into place. Atomic per-file is sufficient — Codex reads each file
  // independently and tolerates an inconsistent in-between snapshot across
  // files for the duration of the rename loop (milliseconds).
  for (const rel of ["memory_summary.md", "MEMORY.md", "raw_memories.md"]) {
    const src = path.join(tmpDir, rel);
    const dest = path.join(memoriesDir, rel);
    renameSync(src, dest);
  }

  const destRolloutsDir = path.join(memoriesDir, ROLLOUT_SUBDIR);
  mkdirSync(destRolloutsDir, { recursive: true });
  // Clear any rollout files we previously owned but that are no longer in the set.
  const retainedRolloutNames = new Set(rolloutFiles.map((r) => r.name));
  try {
    for (const entry of readdirSync(destRolloutsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (retainedRolloutNames.has(entry.name)) continue;
      try {
        unlinkSync(path.join(destRolloutsDir, entry.name));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore — directory may not exist yet
  }

  for (const rollout of rolloutFiles) {
    const src = path.join(tmpDir, ROLLOUT_SUBDIR, rollout.name);
    const dest = path.join(destRolloutsDir, rollout.name);
    renameSync(src, dest);
  }

  // Update sentinel last so a crash leaves hash mismatched → next run rewrites.
  const sentinel: SentinelFile = {
    version: MATERIALIZE_VERSION,
    namespace,
    updated_at: now.toISOString(),
    content_hash: hash,
  };
  writeFileSync(sentinelPath, `${JSON.stringify(sentinel, null, 2)}\n`);

  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  logger.info(
    `materialized namespace=${namespace} files=${filesWritten.length} hash=${hash.slice(0, 12)}`,
  );

  return {
    namespace,
    memoriesDir,
    wrote: true,
    skippedNoSentinel: false,
    skippedIdempotent: false,
    filesWritten,
    contentHash: hash,
  };
}

/**
 * Create (or refresh) the `.remnic-managed` sentinel. Callers must do this
 * explicitly the first time they want Remnic to start managing a directory —
 * we never write it implicitly, because its presence is the user's opt-in.
 */
export function ensureSentinel(memoriesDir: string, namespace: string, now: Date = new Date()): void {
  mkdirSync(memoriesDir, { recursive: true });
  const sentinelPath = path.join(memoriesDir, SENTINEL_FILE);
  if (existsSync(sentinelPath)) return;
  const sentinel: SentinelFile = {
    version: MATERIALIZE_VERSION,
    namespace,
    updated_at: now.toISOString(),
    content_hash: "",
  };
  writeFileSync(sentinelPath, `${JSON.stringify(sentinel, null, 2)}\n`);
}

// ─── Rendering ─────────────────────────────────────────────────────────────

interface RenderContext {
  namespace: string;
  memories: MemoryFile[];
  rolloutSummaries: RolloutSummaryInput[];
  now: Date;
}

interface SummaryRenderContext extends RenderContext {
  maxTokens: number;
}

/**
 * Render `memory_summary.md` — the always-loaded file.
 * Budget-capped at `maxTokens` whitespace tokens.
 */
export function renderMemorySummary(ctx: SummaryRenderContext): string {
  const lines: string[] = [];
  lines.push("# Memory Summary");
  lines.push("");
  lines.push(`_namespace: ${ctx.namespace}_`);
  lines.push(`_source: remnic_`);
  lines.push("");

  const highValue = selectSummaryMemories(ctx.memories, 12);
  if (highValue.length > 0) {
    lines.push("## Top memories");
    lines.push("");
    for (const mem of highValue) {
      lines.push(`- ${oneLineSummary(mem)}`);
    }
    lines.push("");
  }

  if (ctx.rolloutSummaries.length > 0) {
    lines.push("## Recent rollouts");
    lines.push("");
    const sorted = [...ctx.rolloutSummaries]
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, 5);
    for (const r of sorted) {
      const when = r.updatedAt ? ` (${r.updatedAt})` : "";
      lines.push(`- ${r.slug}${when}`);
    }
    lines.push("");
  }

  const full = lines.join("\n").replace(/\n+$/u, "\n");
  return truncateToTokenBudget(full, ctx.maxTokens);
}

/**
 * Render `MEMORY.md` — the searchable handbook in Codex's task-group schema.
 */
export function renderMemoryMd(ctx: RenderContext): string {
  const lines: string[] = [];
  lines.push(`# Task Group: ${ctx.namespace}`);
  lines.push(`scope: ${ctx.namespace}`);
  lines.push(`applies_to: cwd=*; reuse_rule=namespace-match`);
  lines.push("");

  // One "task" per top-level topic cluster. For the first cut we group by
  // memory category so the schema validator always sees at least one task.
  const byCategory = groupMemoriesByCategory(ctx.memories);
  let taskIndex = 1;
  if (byCategory.size === 0) {
    lines.push(`## Task ${taskIndex}: baseline — no memories yet`);
    lines.push("");
    lines.push("### rollout_summary_files");
    for (const r of ctx.rolloutSummaries) {
      lines.push(
        `- rollout_summaries/${sanitizeSlug(r.slug)}.md (cwd=${r.cwd ?? "*"}, rollout_path=${r.rolloutPath ?? ""}, updated_at=${r.updatedAt ?? ""}, thread_id=${r.threadId ?? ""})`,
      );
    }
    if (ctx.rolloutSummaries.length === 0) {
      lines.push("- (none)");
    }
    lines.push("");
    lines.push("### keywords");
    lines.push(`- ${ctx.namespace}`);
    lines.push("");
    taskIndex += 1;
  } else {
    for (const [category, mems] of byCategory) {
      lines.push(`## Task ${taskIndex}: ${category} memories, outcome=surface-to-codex`);
      lines.push("");
      lines.push("### rollout_summary_files");
      const relevantRollouts = ctx.rolloutSummaries.slice(0, 5);
      if (relevantRollouts.length === 0) {
        lines.push("- (none)");
      } else {
        for (const r of relevantRollouts) {
          lines.push(
            `- rollout_summaries/${sanitizeSlug(r.slug)}.md (cwd=${r.cwd ?? "*"}, rollout_path=${r.rolloutPath ?? ""}, updated_at=${r.updatedAt ?? ""}, thread_id=${r.threadId ?? ""})`,
          );
        }
      }
      lines.push("");
      lines.push("### keywords");
      const keywords = collectKeywords(mems, category, ctx.namespace);
      lines.push(`- ${keywords.join(", ")}`);
      lines.push("");
      taskIndex += 1;
    }
  }

  lines.push("## User preferences");
  const prefs = pickCategory(ctx.memories, ["preference"]);
  if (prefs.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const pref of prefs.slice(0, 20)) {
      lines.push(`- ${oneLineSummary(pref)}`);
    }
  }
  lines.push("");

  lines.push("## Reusable knowledge");
  const knowledge = pickCategory(ctx.memories, ["fact", "decision", "principle", "rule", "skill"]);
  if (knowledge.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const mem of knowledge.slice(0, 30)) {
      lines.push(`- ${oneLineSummary(mem)}`);
    }
  }
  lines.push("");

  lines.push("## Failures and how to do differently");
  const corrections = pickCategory(ctx.memories, ["correction"]);
  if (corrections.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const mem of corrections.slice(0, 20)) {
      lines.push(`- ${oneLineSummary(mem)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/** Render `raw_memories.md` — mechanical dump, latest first. */
export function renderRawMemories(ctx: { memories: MemoryFile[] }): string {
  const sorted = [...ctx.memories].sort((a, b) => {
    const aUpdated = a.frontmatter.updated ?? a.frontmatter.created ?? "";
    const bUpdated = b.frontmatter.updated ?? b.frontmatter.created ?? "";
    return bUpdated.localeCompare(aUpdated);
  });

  const lines: string[] = ["# Raw Memories", "", "_source: remnic — latest first_", ""];
  for (const mem of sorted) {
    const fm = mem.frontmatter;
    const id = fm.id ?? "unknown";
    const category = fm.category ?? "unknown";
    const updated = fm.updated ?? fm.created ?? "";
    lines.push(`## ${id} (${category}, updated=${updated})`);
    lines.push("");
    lines.push(mem.content.trim());
    lines.push("");
  }
  return lines.join("\n");
}

/** Render a single rollout summary file. */
export function renderRolloutSummary(input: RolloutSummaryInput): string {
  const lines: string[] = [];
  lines.push(`# Rollout Summary: ${input.slug}`);
  lines.push("");
  const meta: string[] = [];
  if (input.cwd) meta.push(`cwd=${input.cwd}`);
  if (input.rolloutPath) meta.push(`rollout_path=${input.rolloutPath}`);
  if (input.updatedAt) meta.push(`updated_at=${input.updatedAt}`);
  if (input.threadId) meta.push(`thread_id=${input.threadId}`);
  if (meta.length > 0) {
    lines.push(`_${meta.join("; ")}_`);
    lines.push("");
  }
  if (input.keywords && input.keywords.length > 0) {
    lines.push(`**keywords:** ${input.keywords.join(", ")}`);
    lines.push("");
  }
  lines.push(input.body.trim());
  lines.push("");
  return lines.join("\n");
}

// ─── Schema validation ─────────────────────────────────────────────────────

export interface MemoryMdValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate that a rendered `MEMORY.md` matches Codex's task-group schema.
 * We enforce the minimum set of structural requirements called out in #378:
 *
 *  - one `# Task Group:` header
 *  - `scope:` and `applies_to:` lines directly beneath it
 *  - at least one `## Task N:` section
 *  - each task section has `### rollout_summary_files` and `### keywords`
 *  - `## User preferences`, `## Reusable knowledge`,
 *    `## Failures and how to do differently` sections all present
 */
export function validateMemoryMd(content: string): MemoryMdValidation {
  const errors: string[] = [];
  const lines = content.split(/\r?\n/u);

  const taskGroupIndex = lines.findIndex((l) => /^#\s+Task Group:\s+\S+/u.test(l));
  if (taskGroupIndex === -1) {
    errors.push("missing `# Task Group:` header");
  } else {
    const tail = lines.slice(taskGroupIndex + 1, taskGroupIndex + 5);
    if (!tail.some((l) => /^scope:\s*\S+/u.test(l))) {
      errors.push("missing `scope:` line under Task Group header");
    }
    if (!tail.some((l) => /^applies_to:\s*\S+/u.test(l))) {
      errors.push("missing `applies_to:` line under Task Group header");
    }
  }

  const taskHeaders = lines.filter((l) => /^##\s+Task\s+\d+:/u.test(l));
  if (taskHeaders.length === 0) {
    errors.push("at least one `## Task N:` section is required");
  }

  // For every task section, make sure we have rollout_summary_files + keywords
  // before the next `##` header at the same level.
  const sectionRegex = /^##\s+/u;
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s+Task\s+\d+:/u.test(lines[i])) continue;
    let hasRollout = false;
    let hasKeywords = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (sectionRegex.test(lines[j])) break;
      if (/^###\s+rollout_summary_files\s*$/u.test(lines[j])) hasRollout = true;
      if (/^###\s+keywords\s*$/u.test(lines[j])) hasKeywords = true;
    }
    if (!hasRollout) errors.push(`task block at line ${i + 1} missing \`### rollout_summary_files\``);
    if (!hasKeywords) errors.push(`task block at line ${i + 1} missing \`### keywords\``);
  }

  const requiredSections = [
    /^##\s+User preferences\s*$/u,
    /^##\s+Reusable knowledge\s*$/u,
    /^##\s+Failures and how to do differently\s*$/u,
  ];
  for (const re of requiredSections) {
    if (!lines.some((l) => re.test(l))) {
      errors.push(`missing required section: ${re.source}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function resolveCodexHome(override?: string): string {
  if (override && override.trim().length > 0) return override;
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(home, ".codex");
}

function readSentinel(sentinelPath: string): SentinelFile | null {
  if (!existsSync(sentinelPath)) return null;
  try {
    const raw = readFileSync(sentinelPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SentinelFile>;
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      version: typeof parsed.version === "number" ? parsed.version : MATERIALIZE_VERSION,
      namespace: typeof parsed.namespace === "string" ? parsed.namespace : "",
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
      content_hash: typeof parsed.content_hash === "string" ? parsed.content_hash : "",
    };
  } catch {
    return null;
  }
}

function selectSummaryMemories(memories: MemoryFile[], limit: number): MemoryFile[] {
  const scored = memories
    .filter((m) => !m.frontmatter.status || m.frontmatter.status === "active")
    .map((m) => {
      const confidence = typeof m.frontmatter.confidence === "number" ? m.frontmatter.confidence : 0;
      const importance =
        typeof m.frontmatter.importance === "object" &&
        m.frontmatter.importance !== null &&
        typeof (m.frontmatter.importance as { score?: number }).score === "number"
          ? ((m.frontmatter.importance as { score: number }).score ?? 0)
          : 0;
      const updated = m.frontmatter.updated ?? m.frontmatter.created ?? "";
      return { memory: m, score: importance * 2 + confidence, updated };
    });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.updated.localeCompare(a.updated);
  });

  return scored.slice(0, limit).map((s) => s.memory);
}

function oneLineSummary(memory: MemoryFile): string {
  const raw = memory.content.replace(/\s+/gu, " ").trim();
  if (raw.length <= 160) return raw;
  return `${raw.slice(0, 157)}...`;
}

function groupMemoriesByCategory(memories: MemoryFile[]): Map<string, MemoryFile[]> {
  const map = new Map<string, MemoryFile[]>();
  for (const memory of memories) {
    if (memory.frontmatter.status && memory.frontmatter.status !== "active") continue;
    const category = memory.frontmatter.category ?? "unknown";
    const list = map.get(category) ?? [];
    list.push(memory);
    map.set(category, list);
  }
  return map;
}

function pickCategory(memories: MemoryFile[], categories: string[]): MemoryFile[] {
  const allowed = new Set(categories);
  return memories.filter(
    (m) =>
      (!m.frontmatter.status || m.frontmatter.status === "active") &&
      allowed.has(m.frontmatter.category ?? ""),
  );
}

function collectKeywords(memories: MemoryFile[], category: string, namespace: string): string[] {
  const keywords = new Set<string>();
  keywords.add(category);
  keywords.add(namespace);
  for (const mem of memories.slice(0, 10)) {
    for (const tag of mem.frontmatter.tags ?? []) {
      if (typeof tag === "string" && tag.trim().length > 0) keywords.add(tag.trim());
    }
  }
  return [...keywords].slice(0, 16);
}

function pruneRollouts(
  rollouts: RolloutSummaryInput[],
  retentionDays: number,
  now: Date,
): RolloutSummaryInput[] {
  if (retentionDays <= 0) return rollouts;
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return rollouts.filter((r) => {
    if (!r.updatedAt) return true;
    const t = Date.parse(r.updatedAt);
    if (!Number.isFinite(t)) return true;
    return t >= cutoffMs;
  });
}

function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96)
    || "rollout";
}

/**
 * Whitespace-tokenized approximation used by the budget check. Matches the
 * simple heuristic Codex's usage.rs reporting uses for the "5000 token"
 * memory_summary cap.
 */
export function approximateTokenCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/u).length;
}

/**
 * Truncate `text` so it fits under `maxTokens` whitespace tokens. We drop
 * trailing lines until we're under the budget and then append an ellipsis
 * marker so downstream readers can see that truncation happened.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (approximateTokenCount(text) <= maxTokens) return text;

  const lines = text.split(/\r?\n/u);
  while (lines.length > 0 && approximateTokenCount(lines.join("\n")) > maxTokens - 1) {
    lines.pop();
  }
  lines.push("_[truncated for summary budget]_");
  let result = lines.join("\n");

  // If a single huge line still blows the budget, hard-cut tokens.
  if (approximateTokenCount(result) > maxTokens) {
    const tokens = result.split(/\s+/u);
    result = `${tokens.slice(0, Math.max(0, maxTokens - 1)).join(" ")} [truncated]`;
  }
  return result;
}

function computeContentHash(input: {
  namespace: string;
  memorySummary: string;
  memoryMd: string;
  rawMemories: string;
  rolloutFiles: Array<{ name: string; body: string }>;
}): string {
  const hash = createHash("sha256");
  hash.update(`v${MATERIALIZE_VERSION}\n`);
  hash.update(`namespace=${input.namespace}\n`);
  hash.update("---memory_summary---\n");
  hash.update(input.memorySummary);
  hash.update("\n---memory_md---\n");
  hash.update(input.memoryMd);
  hash.update("\n---raw_memories---\n");
  hash.update(input.rawMemories);
  const sortedRollouts = [...input.rolloutFiles].sort((a, b) => a.name.localeCompare(b.name));
  for (const r of sortedRollouts) {
    hash.update(`\n---rollout:${r.name}---\n`);
    hash.update(r.body);
  }
  return hash.digest("hex");
}

// ─── Stat helper for tests / debugging ─────────────────────────────────────

/**
 * Return basic stats about a materialized memories dir. Useful for tests and
 * debug CLI output. Returns `null` if the dir does not exist.
 */
export function describeMemoriesDir(memoriesDir: string): {
  exists: boolean;
  hasSentinel: boolean;
  files: string[];
  sentinel: SentinelFile | null;
} | null {
  if (!existsSync(memoriesDir)) return null;
  const sentinelPath = path.join(memoriesDir, SENTINEL_FILE);
  const sentinel = readSentinel(sentinelPath);
  const files: string[] = [];
  for (const entry of readdirSync(memoriesDir, { withFileTypes: true })) {
    if (entry.isFile() && OWNED_FILES.has(entry.name)) files.push(entry.name);
  }
  const rolloutsDir = path.join(memoriesDir, ROLLOUT_SUBDIR);
  if (existsSync(rolloutsDir)) {
    try {
      for (const entry of readdirSync(rolloutsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(path.join(ROLLOUT_SUBDIR, entry.name));
        }
      }
    } catch {
      // ignore
    }
  }
  return {
    exists: true,
    hasSentinel: sentinel !== null,
    files: files.sort(),
    sentinel,
  };
}
