/**
 * Daily Context Briefing (Issue #370)
 *
 * Produces a focused "here is what matters right now" briefing by
 * cross-referencing active entities, recent facts, open commitments,
 * LLM-generated follow-ups, and an optional calendar source.
 *
 * The module exposes:
 *   - `parseBriefingWindow(token)` — CLI-friendly window parser.
 *   - `buildBriefing(options)` — core builder that returns markdown + JSON.
 *   - `FileCalendarSource` — stub CalendarSource implementation that reads
 *     a local ICS or JSON file.
 *
 * ALL OpenAI usage in this module goes through the Responses API. Chat
 * Completions is never used.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import { StorageManager } from "./storage.js";
import type {
  BriefingActiveThread,
  BriefingFocus,
  BriefingFollowup,
  BriefingOpenCommitment,
  BriefingRecentEntity,
  BriefingResult,
  BriefingSections,
  CalendarEvent,
  CalendarSource,
  EntityFile,
  MemoryFile,
} from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// Window parsing
// ──────────────────────────────────────────────────────────────────────────

/** Allowed values for the briefing format flag/field. */
export const BRIEFING_FORMAT_ALLOWED = ["markdown", "json"] as const;
export type BriefingFormatValue = typeof BRIEFING_FORMAT_ALLOWED[number];

/**
 * Validate a user-supplied `--format` flag value.
 * Returns `null` when the value is valid (or `undefined`, meaning the flag
 * was not supplied and the caller should fall back to the configured default).
 * Returns an error message string when the value is explicitly invalid.
 */
export function validateBriefingFormat(value: string | undefined): string | null {
  if (value === undefined) return null;
  if ((BRIEFING_FORMAT_ALLOWED as readonly string[]).includes(value)) return null;
  return `Invalid --format value: "${value}". Accepted: ${BRIEFING_FORMAT_ALLOWED.join(", ")}.`;
}

/** Parsed briefing lookback window. */
export interface ParsedBriefingWindow {
  /** Start of the window (inclusive). */
  from: Date;
  /** End of the window (exclusive). */
  to: Date;
  /** Human-readable label. */
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum allowed lookback offset in milliseconds (100 years).
 * Anything beyond this is almost certainly a typo or abuse — and would
 * overflow to `Invalid Date` for sufficiently large values anyway.
 */
const MAX_WINDOW_MS = 100 * 365 * DAY_MS;

/**
 * Parse a CLI-friendly window token into a concrete date range.
 *
 * Accepted forms (case-insensitive):
 *   - `yesterday` — the previous UTC calendar day.
 *   - `today`    — the current UTC calendar day so far.
 *   - `NNh`      — last N hours (e.g. `24h`, `48h`).
 *   - `NNd`      — last N calendar days (e.g. `3d`, `7d`).
 *   - `NNw`      — last N weeks (e.g. `1w`, `2w`).
 *
 * Returns `null` for invalid tokens so callers can surface a clean error.
 */
export function parseBriefingWindow(
  token: string,
  now: Date = new Date(),
): ParsedBriefingWindow | null {
  const raw = typeof token === "string" ? token.trim().toLowerCase() : "";
  if (raw.length === 0) return null;

  if (raw === "yesterday") {
    const startOfToday = startOfUtcDay(now);
    const from = new Date(startOfToday.getTime() - DAY_MS);
    return { from, to: startOfToday, label: "yesterday" };
  }

  if (raw === "today") {
    return { from: startOfUtcDay(now), to: now, label: "today" };
  }

  const match = raw.match(/^(\d+)\s*(h|d|w)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2];
  let ms = 0;
  if (unit === "h") ms = value * 60 * 60 * 1000;
  else if (unit === "d") ms = value * DAY_MS;
  else if (unit === "w") ms = value * 7 * DAY_MS;
  if (ms === 0) return null;
  // Reject values that exceed the 100-year cap or would overflow to Invalid Date.
  if (ms > MAX_WINDOW_MS || !Number.isFinite(ms)) return null;
  const from = new Date(now.getTime() - ms);
  if (!Number.isFinite(from.getTime())) return null;
  return {
    from,
    to: now,
    label: `last ${value}${unit}`,
  };
}

function startOfUtcDay(date: Date): Date {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ──────────────────────────────────────────────────────────────────────────
// Focus filter
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse a CLI `--focus` string into a structured focus filter.
 *
 * Accepted forms:
 *   - `person:Jane Doe`
 *   - `project:remnic-core`
 *   - `topic:retrieval`
 *
 * If no prefix is supplied, falls back to `topic:<value>`.
 */
export function parseBriefingFocus(token: string | undefined): BriefingFocus | null {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  const [maybeType, ...rest] = trimmed.split(":");
  if (rest.length === 0) {
    return { type: "topic", value: maybeType };
  }
  const rawType = maybeType.toLowerCase();
  if (rawType === "person" || rawType === "project" || rawType === "topic") {
    const value = rest.join(":").trim();
    if (value.length === 0) return null;
    return { type: rawType, value };
  }
  return { type: "topic", value: trimmed };
}

/**
 * Decide whether a memory/entity matches the given focus filter.
 * Purely deterministic — no LLM, case-insensitive substring match across
 * the most useful surfaces.
 */
export function focusMatchesMemory(memory: MemoryFile, focus: BriefingFocus): boolean {
  const needle = focus.value.toLowerCase();
  const haystack = [
    memory.content,
    memory.frontmatter.entityRef ?? "",
    ...(memory.frontmatter.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function focusMatchesEntity(entity: EntityFile, focus: BriefingFocus): boolean {
  const needle = focus.value.toLowerCase();
  if (focus.type === "person" && entity.type.toLowerCase() !== "person") return false;
  if (focus.type === "project" && entity.type.toLowerCase() !== "project") return false;
  const haystack = [
    entity.name,
    entity.summary ?? "",
    ...entity.facts,
    ...(entity.aliases ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

// ──────────────────────────────────────────────────────────────────────────
// Calendar source
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stub `CalendarSource` backed by a single local file. Supports:
 *   - JSON files containing an array of `CalendarEvent` records, OR a wrapper
 *     `{ events: CalendarEvent[] }` object.
 *   - Minimal ICS (`.ics`) files — extracts `VEVENT` blocks with `SUMMARY`,
 *     `DTSTART`, `DTEND`, `LOCATION`, `DESCRIPTION`, `UID`.
 *
 * Real calendar integrations (Google, iCloud, Microsoft) can plug into the
 * same `CalendarSource` interface later.
 */
export class FileCalendarSource implements CalendarSource {
  constructor(private readonly filePath: string) {}

  async eventsForDate(dateIso: string): Promise<CalendarEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (err) {
      log.warn(`briefing: calendar source unreadable at ${this.filePath}: ${err}`);
      return [];
    }

    const events = this.filePath.toLowerCase().endsWith(".ics")
      ? parseIcsEvents(raw)
      : parseJsonEvents(raw);

    return events.filter((event) => eventFallsOnDate(event, dateIso));
  }
}

function parseJsonEvents(raw: string): CalendarEvent[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown }).events)
        ? ((parsed as { events: unknown[] }).events)
        : [];
    const events: CalendarEvent[] = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : typeof e.uid === "string" ? e.uid : cryptoRandomId();
      const title = typeof e.title === "string" ? e.title : typeof e.summary === "string" ? e.summary : "";
      const start = typeof e.start === "string" ? e.start : typeof e.dtstart === "string" ? e.dtstart : "";
      if (!title || !start) continue;
      events.push({
        id,
        title,
        start,
        end: typeof e.end === "string" ? e.end : typeof e.dtend === "string" ? e.dtend : undefined,
        location: typeof e.location === "string" ? e.location : undefined,
        notes: typeof e.notes === "string" ? e.notes : typeof e.description === "string" ? e.description : undefined,
      });
    }
    return events;
  } catch (err) {
    log.warn(`briefing: calendar JSON parse failed: ${err}`);
    return [];
  }
}

function parseIcsEvents(raw: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const normalized = raw.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/BEGIN:VEVENT/i).slice(1);
  for (const block of blocks) {
    const endIdx = block.search(/END:VEVENT/i);
    const body = endIdx === -1 ? block : block.slice(0, endIdx);
    const fields: Record<string, string> = {};
    for (const line of body.split("\n")) {
      const m = line.match(/^([A-Z0-9-]+)(?:;[^:]*)?:(.*)$/i);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const value = m[2].trim();
      if (fields[key] === undefined) fields[key] = value;
    }
    const title = fields.SUMMARY;
    const start = fields.DTSTART;
    if (!title || !start) continue;
    events.push({
      id: fields.UID ?? cryptoRandomId(),
      title,
      start: normalizeIcsDate(start),
      end: fields.DTEND ? normalizeIcsDate(fields.DTEND) : undefined,
      location: fields.LOCATION,
      notes: fields.DESCRIPTION,
    });
  }
  return events;
}

function normalizeIcsDate(value: string): string {
  // ICS basic forms: 20260411T150000Z or 20260411
  if (/^\d{8}T\d{6}Z?$/.test(value)) {
    const y = value.slice(0, 4);
    const m = value.slice(4, 6);
    const d = value.slice(6, 8);
    const hh = value.slice(9, 11);
    const mm = value.slice(11, 13);
    const ss = value.slice(13, 15);
    const tz = value.endsWith("Z") ? "Z" : "";
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}${tz}`;
  }
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`;
  }
  return value;
}

/** @internal — exported for testing only. */
export function eventFallsOnDate(event: CalendarEvent, dateIso: string): boolean {
  const target = dateIso.slice(0, 10);
  const start = event.start;

  // Floating ICS datetime (no Z, no offset): `normalizeIcsDate` produces
  // "YYYY-MM-DDTHH:MM:SS" with no timezone. Passing this to `new Date()`
  // causes ECMAScript to parse it as local time, which then round-trips
  // through UTC via `toISOString()` and can shift the calendar date.
  // For floating times we compare the date portion directly.
  const hasTimezone = /Z$|[+-]\d{2}:\d{2}$/.test(start);
  if (!hasTimezone) {
    // Verify the value is at least parseable before accepting it.
    const probe = new Date(start);
    if (!Number.isFinite(probe.getTime())) {
      log.debug(`briefing: skipping calendar event with invalid start value: ${JSON.stringify(start)}`);
      return false;
    }
    // Extract YYYY-MM-DD directly from the string — no UTC shift.
    return start.slice(0, 10) === target;
  }

  // UTC or offset-aware ISO string: parse and normalise to UTC date.
  const parsed = new Date(start);
  if (!Number.isFinite(parsed.getTime())) {
    log.debug(`briefing: skipping calendar event with invalid start value: ${JSON.stringify(start)}`);
    return false;
  }
  return parsed.toISOString().slice(0, 10) === target;
}

function cryptoRandomId(): string {
  // Keep dependency-free: Math.random is fine for synthetic fixture IDs.
  return `evt-${Math.random().toString(36).slice(2, 10)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// buildBriefing
// ──────────────────────────────────────────────────────────────────────────

/** Dependency-injection hook for LLM follow-up generation (used in tests). */
export type BriefingFollowupGenerator = (
  prompt: {
    sections: BriefingSections;
    windowLabel: string;
    maxFollowups: number;
  },
) => Promise<BriefingFollowup[]>;

/** Options accepted by `buildBriefing`. */
export interface BuildBriefingOptions {
  /** Workspace-scoped storage. Tests pass a temp dir. */
  storage: StorageManager;
  /** Parsed window. If omitted, a default 1-day window is used. */
  window?: ParsedBriefingWindow;
  /** Optional focus filter. */
  focus?: BriefingFocus | null;
  /** Optional namespace hint for logging. */
  namespace?: string;
  /** Calendar source. Section omitted entirely when undefined. */
  calendarSource?: CalendarSource;
  /** Maximum LLM follow-ups (0 to disable the section). */
  maxFollowups?: number;
  /** Whether the module is allowed to invoke the Responses API. */
  allowLlm?: boolean;
  /** OpenAI API key. If absent the follow-up section is gracefully omitted. */
  openaiApiKey?: string;
  /** Model id for the Responses call. */
  model?: string;
  /** Injected follow-up generator. Overrides real LLM call (tests). */
  followupGenerator?: BriefingFollowupGenerator;
  /** Injected "now" — makes tests deterministic. */
  now?: Date;
}

const MAX_ACTIVE_THREADS = 8;
const MAX_RECENT_ENTITIES = 8;
const MAX_OPEN_COMMITMENTS = 8;

/**
 * Build the daily context briefing.
 *
 * Never throws on LLM failures — the suggested follow-ups section is simply
 * omitted and `followupsUnavailableReason` is set.
 */
export async function buildBriefing(options: BuildBriefingOptions): Promise<BriefingResult> {
  const now = options.now ?? new Date();
  const window = options.window ?? defaultWindow(now);
  const maxFollowups = clampFollowups(options.maxFollowups);
  const focus = options.focus ?? null;

  const [allMemories, allEntities] = await Promise.all([
    safeReadMemories(options.storage),
    safeReadEntities(options.storage),
  ]);

  const memoriesInWindow = filterMemoriesByWindow(allMemories, window);
  const focusedMemories = focus
    ? memoriesInWindow.filter((m) => focusMatchesMemory(m, focus))
    : memoriesInWindow;

  const activeThreads = buildActiveThreads(focusedMemories);
  const recentEntities = buildRecentEntities(allEntities, window, focus);
  const openCommitments = buildOpenCommitments(focusedMemories);

  const todayCalendar = options.calendarSource
    ? await loadTodayCalendar(options.calendarSource, now)
    : undefined;

  const sectionsBase: BriefingSections = {
    activeThreads,
    recentEntities,
    openCommitments,
    suggestedFollowups: [],
    todayCalendar,
  };

  let followups: BriefingFollowup[] = [];
  let followupsUnavailableReason: string | undefined;

  if (maxFollowups === 0 || options.allowLlm === false) {
    followupsUnavailableReason = "LLM follow-ups disabled by configuration";
  } else if (!options.openaiApiKey && !options.followupGenerator) {
    followupsUnavailableReason = "OPENAI_API_KEY not configured";
  } else {
    try {
      const generator = options.followupGenerator ?? buildOpenAiFollowupGenerator({
        apiKey: options.openaiApiKey!,
        model: options.model ?? "gpt-5.2",
      });
      const generated = await generator({
        sections: sectionsBase,
        windowLabel: window.label,
        maxFollowups,
      });
      followups = generated.slice(0, maxFollowups);
    } catch (err) {
      followupsUnavailableReason = `LLM follow-ups failed: ${stringifyError(err)}`;
      log.warn(`briefing: ${followupsUnavailableReason}`);
    }
  }

  const sections: BriefingSections = {
    ...sectionsBase,
    suggestedFollowups: followups,
  };

  const windowIso = { from: window.from.toISOString(), to: window.to.toISOString() };
  const markdown = renderBriefingMarkdown({
    sections,
    windowLabel: window.label,
    focus,
    followupsUnavailableReason,
    generatedAt: now,
    namespace: options.namespace,
  });

  const json: Record<string, unknown> = {
    generatedAt: now.toISOString(),
    window: windowIso,
    focus,
    namespace: options.namespace ?? null,
    sections,
    followupsUnavailableReason: followupsUnavailableReason ?? null,
  };

  return {
    markdown,
    json,
    sections,
    followupsUnavailableReason,
    window: windowIso,
  };
}

function clampFollowups(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  return Math.max(0, Math.min(10, Math.floor(value)));
}

function defaultWindow(now: Date): ParsedBriefingWindow {
  const parsed = parseBriefingWindow("yesterday", now);
  if (parsed) return parsed;
  return { from: new Date(now.getTime() - DAY_MS), to: now, label: "yesterday" };
}

async function safeReadMemories(storage: StorageManager): Promise<MemoryFile[]> {
  try {
    return await storage.readAllMemories();
  } catch (err) {
    log.warn(`briefing: readAllMemories failed: ${err}`);
    return [];
  }
}

async function safeReadEntities(storage: StorageManager): Promise<EntityFile[]> {
  try {
    return await storage.readAllEntityFiles();
  } catch (err) {
    log.warn(`briefing: readAllEntityFiles failed: ${err}`);
    return [];
  }
}

function memoryTimestamp(memory: MemoryFile): number {
  const raw = memory.frontmatter.updated || memory.frontmatter.created;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

/** @internal — exported for testing only. */
export function filterMemoriesByWindow(memories: MemoryFile[], window: ParsedBriefingWindow): MemoryFile[] {
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();
  return memories.filter((m) => {
    // Exclude non-active memories (superseded, archived, etc.) so that
    // commitments overridden within the window don't appear as open.
    const status = m.frontmatter.status;
    if (status !== undefined && status !== "active") return false;
    const ts = memoryTimestamp(m);
    return ts >= fromMs && ts < toMs;
  });
}

function buildActiveThreads(memories: MemoryFile[]): BriefingActiveThread[] {
  const buckets = new Map<string, BriefingActiveThread>();
  for (const memory of memories) {
    const threadKey = extractThreadKey(memory);
    const updatedAt = memory.frontmatter.updated || memory.frontmatter.created || "";
    const existing = buckets.get(threadKey);
    if (!existing || updatedAt > existing.updatedAt) {
      buckets.set(threadKey, {
        id: threadKey,
        title: summarizeContentTitle(memory),
        updatedAt,
        reason: existing ? existing.reason : describeReason(memory),
      });
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1))
    .slice(0, MAX_ACTIVE_THREADS);
}

function extractThreadKey(memory: MemoryFile): string {
  const entityRef = memory.frontmatter.entityRef?.trim();
  if (entityRef) return `entity:${entityRef}`;
  const tags = memory.frontmatter.tags ?? [];
  const topicTag = tags.find((t) => t.startsWith("topic:"));
  if (topicTag) return topicTag;
  if (tags.length > 0) return `tag:${tags[0]}`;
  return `memory:${memory.frontmatter.id}`;
}

function summarizeContentTitle(memory: MemoryFile): string {
  const firstLine = (memory.content || "").split("\n").find((line) => line.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) return memory.frontmatter.id;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function describeReason(memory: MemoryFile): string {
  const cat = memory.frontmatter.category;
  if (cat === "commitment") return "open commitment";
  if (cat === "decision") return "recent decision";
  if (cat === "correction") return "recent correction";
  return "recent activity";
}

/** @internal — exported for testing only. */
export function buildRecentEntities(
  entities: EntityFile[],
  window: ParsedBriefingWindow,
  focus: BriefingFocus | null,
): BriefingRecentEntity[] {
  const fromMs = window.from.getTime();
  const scored: BriefingRecentEntity[] = [];
  const now = window.to;
  for (const entity of entities) {
    if (focus && !focusMatchesEntity(entity, focus)) continue;
    const toMs = window.to.getTime();
    const updatedMs = entity.updated ? Date.parse(entity.updated) : 0;
    if (!Number.isFinite(updatedMs) || updatedMs < fromMs || updatedMs >= toMs) continue;
    const score = StorageManager.scoreEntity(entity, now);
    scored.push({
      name: entity.name,
      type: entity.type,
      updatedAt: entity.updated,
      score: Number(score.toFixed(4)),
      summary: entity.summary,
    });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.updatedAt > b.updatedAt ? -1 : 1))
    .slice(0, MAX_RECENT_ENTITIES);
}

function buildOpenCommitments(memories: MemoryFile[]): BriefingOpenCommitment[] {
  const commitments: BriefingOpenCommitment[] = [];

  for (const memory of memories) {
    const tags = memory.frontmatter.tags ?? [];
    const isPending = tags.some((t) => t.toLowerCase() === "pending");
    const isCommitment = memory.frontmatter.category === "commitment";
    const isUnresolvedQuestion = /(?:\?$|\bfollow[- ]up\b|\btodo\b)/i.test(memory.content);

    if (isPending || isCommitment || isUnresolvedQuestion) {
      const kind: BriefingOpenCommitment["kind"] = isCommitment
        ? "commitment"
        : isUnresolvedQuestion
          ? "question"
          : "pending_memory";
      commitments.push({
        id: memory.frontmatter.id,
        kind,
        text: summarizeContentTitle(memory),
        source: memory.frontmatter.source,
        createdAt: memory.frontmatter.created,
      });
    }
  }

  return commitments
    .sort((a, b) => (a.createdAt && b.createdAt && a.createdAt > b.createdAt ? -1 : 1))
    .slice(0, MAX_OPEN_COMMITMENTS);
}

async function loadTodayCalendar(
  source: CalendarSource,
  now: Date,
): Promise<CalendarEvent[] | undefined> {
  try {
    const dateIso = now.toISOString().slice(0, 10);
    const events = await source.eventsForDate(dateIso);
    return events.length > 0 ? events : [];
  } catch (err) {
    log.warn(`briefing: calendar source error: ${err}`);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Follow-ups (Responses API)
// ──────────────────────────────────────────────────────────────────────────

function buildOpenAiFollowupGenerator(cfg: {
  apiKey: string;
  model: string;
}): BriefingFollowupGenerator {
  return async ({ sections, windowLabel, maxFollowups }) => {
    // Lazy import keeps the module dependency-free when LLM path is unused.
    const { OpenAI } = (await import("openai")) as { OpenAI: new (opts: { apiKey: string }) => unknown };
    const client = new OpenAI({ apiKey: cfg.apiKey }) as {
      responses: {
        create: (args: {
          model: string;
          instructions: string;
          input: string;
          max_output_tokens?: number;
        }) => Promise<{ output_text?: string }>;
      };
    };

    const prompt = buildFollowupPrompt(sections, windowLabel, maxFollowups);
    const response = await client.responses.create({
      model: cfg.model,
      instructions: FOLLOWUP_INSTRUCTIONS,
      input: prompt,
      max_output_tokens: 512,
    });

    const text = typeof response.output_text === "string" ? response.output_text : "";
    return parseFollowupResponse(text, maxFollowups);
  };
}

const FOLLOWUP_INSTRUCTIONS = `You suggest short follow-up prompts for a daily context briefing.
Return strict JSON of the form { "followups": [{ "text": "...", "rationale": "..." }] }.
Rules:
- Never invent facts absent from the input.
- Keep each "text" under 140 characters.
- Prefer concrete, action-oriented phrasing.
- Omit duplicates. Avoid filler.`;

function buildFollowupPrompt(
  sections: BriefingSections,
  windowLabel: string,
  maxFollowups: number,
): string {
  const lines: string[] = [];
  lines.push(`Window: ${windowLabel}`);
  lines.push(`Desired follow-ups: ${maxFollowups}`);
  lines.push("");
  lines.push("Active threads:");
  for (const t of sections.activeThreads) lines.push(`- ${t.title} (${t.reason})`);
  lines.push("");
  lines.push("Recent entities:");
  for (const e of sections.recentEntities) lines.push(`- ${e.name} [${e.type}]`);
  lines.push("");
  lines.push("Open commitments:");
  for (const c of sections.openCommitments) lines.push(`- [${c.kind}] ${c.text}`);
  return lines.join("\n");
}

function parseFollowupResponse(raw: string, max: number): BriefingFollowup[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const arr = (parsed as { followups?: unknown }).followups;
    if (!Array.isArray(arr)) return [];
    const out: BriefingFollowup[] = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const text = (entry as Record<string, unknown>).text;
      if (typeof text !== "string" || text.trim().length === 0) continue;
      const rationale = (entry as Record<string, unknown>).rationale;
      out.push({
        text: text.trim(),
        rationale: typeof rationale === "string" ? rationale.trim() : undefined,
      });
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ──────────────────────────────────────────────────────────────────────────
// Markdown rendering
// ──────────────────────────────────────────────────────────────────────────

interface RenderContext {
  sections: BriefingSections;
  windowLabel: string;
  focus: BriefingFocus | null;
  followupsUnavailableReason?: string;
  generatedAt: Date;
  namespace?: string;
}

export function renderBriefingMarkdown(ctx: RenderContext): string {
  const lines: string[] = [];
  lines.push(`# Daily Context Briefing`);
  lines.push("");
  lines.push(`_Generated ${ctx.generatedAt.toISOString()} (window: ${ctx.windowLabel})_`);
  if (ctx.focus) {
    lines.push(`_Focus: ${ctx.focus.type}:${ctx.focus.value}_`);
  }
  if (ctx.namespace) {
    lines.push(`_Namespace: ${ctx.namespace}_`);
  }
  lines.push("");

  lines.push(`## Active threads`);
  if (ctx.sections.activeThreads.length === 0) {
    lines.push(`_No active threads in window._`);
  } else {
    for (const t of ctx.sections.activeThreads) {
      lines.push(`- **${t.title}** — ${t.reason} (updated ${t.updatedAt})`);
    }
  }
  lines.push("");

  lines.push(`## Recent entities`);
  if (ctx.sections.recentEntities.length === 0) {
    lines.push(`_No entities updated in window._`);
  } else {
    for (const e of ctx.sections.recentEntities) {
      const summary = e.summary ? ` — ${e.summary}` : "";
      lines.push(`- **${e.name}** (${e.type}, score ${e.score})${summary}`);
    }
  }
  lines.push("");

  lines.push(`## Open commitments`);
  if (ctx.sections.openCommitments.length === 0) {
    lines.push(`_No open commitments detected._`);
  } else {
    for (const c of ctx.sections.openCommitments) {
      lines.push(`- [${c.kind}] ${c.text}`);
    }
  }
  lines.push("");

  lines.push(`## Suggested follow-ups`);
  if (ctx.followupsUnavailableReason) {
    lines.push(`_Unavailable: ${ctx.followupsUnavailableReason}_`);
  } else if (ctx.sections.suggestedFollowups.length === 0) {
    lines.push(`_No follow-ups suggested._`);
  } else {
    for (const f of ctx.sections.suggestedFollowups) {
      const rationale = f.rationale ? ` _(${f.rationale})_` : "";
      lines.push(`- ${f.text}${rationale}`);
    }
  }
  lines.push("");

  if (ctx.sections.todayCalendar !== undefined) {
    lines.push(`## Today's calendar`);
    if (ctx.sections.todayCalendar.length === 0) {
      lines.push(`_No events on the calendar today._`);
    } else {
      for (const ev of ctx.sections.todayCalendar) {
        const end = ev.end ? ` → ${ev.end}` : "";
        const loc = ev.location ? ` @ ${ev.location}` : "";
        lines.push(`- **${ev.title}** (${ev.start}${end})${loc}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Save helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve the directory where `--save` writes dated briefings.
 * Respects the following precedence:
 *   1. explicit `configOverride` argument
 *   2. `$REMNIC_HOME/briefings/`
 *   3. `$HOME/.remnic/briefings/`
 */
export function resolveBriefingSaveDir(
  configOverride: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof configOverride === "string" && configOverride.trim().length > 0) {
    return path.resolve(configOverride.trim());
  }
  const remnicHome = env.REMNIC_HOME?.trim();
  if (remnicHome && remnicHome.length > 0) {
    return path.join(remnicHome, "briefings");
  }
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  return path.join(home, ".remnic", "briefings");
}

/** Format the dated filename for a given briefing. */
export function briefingFilename(date: Date, format: "markdown" | "json" = "markdown"): string {
  const day = date.toISOString().slice(0, 10);
  return format === "json" ? `${day}.json` : `${day}.md`;
}

