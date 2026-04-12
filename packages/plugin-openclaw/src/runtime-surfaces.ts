import type {
  ConsolidationObservation,
  MemoryFile,
  MemoryFrontmatter,
} from "../../remnic-core/src/types.js";
import type { DreamEntry } from "../../remnic-core/src/surfaces/dreams.js";
import type { HeartbeatEntry } from "../../remnic-core/src/surfaces/heartbeat.js";

type StorageWriteOptions = {
  confidence?: number;
  tags?: string[];
  source?: string;
  memoryKind?: MemoryFrontmatter["memoryKind"];
  structuredAttributes?: Record<string, string>;
};

export interface RuntimeSurfaceStorage {
  readAllMemories(): Promise<MemoryFile[]>;
  writeMemory(
    category: MemoryFrontmatter["category"],
    content: string,
    options?: StorageWriteOptions,
  ): Promise<string>;
  updateMemory(id: string, newContent: string): Promise<boolean>;
  writeMemoryFrontmatter(
    memory: MemoryFile,
    patch: Partial<MemoryFrontmatter>,
  ): Promise<boolean>;
}

export interface RuntimeSurfaceLogger {
  debug?(message: string): void;
  warn?(message: string): void;
}

export interface SurfaceSyncResult {
  created: number;
  updated: number;
  linked: number;
}

export interface DreamNarrativePlan {
  timestamp: string;
  suggestedTags: string[];
  sessionLikeCount: number;
  memoryContext: string[];
}

const DREAM_SURFACE_TYPE = "dream";
const HEARTBEAT_SURFACE_TYPE = "heartbeat";
const DREAM_ENTRY_ID_KEY = "remnicDreamEntryId";
const HEARTBEAT_ENTRY_ID_KEY = "remnicHeartbeatEntryId";
const HEARTBEAT_SLUG_KEY = "relatedHeartbeatSlug";
const SURFACE_TYPE_KEY = "remnicSurfaceType";
const DREAM_REFLECTION_TAGS = new Set([
  "frustration",
  "recurring",
  "surprising",
  "stuck",
  "reflection",
  "reflective",
  "debug",
  "meta",
  "pattern",
  "patterns",
]);

function uniqueTags(tags: string[]): string[] {
  return Array.from(
    new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)),
  );
}

function buildDreamMemoryContent(entry: DreamEntry): string {
  return entry.title ? `${entry.title}\n\n${entry.body}` : entry.body;
}

function buildHeartbeatMemoryContent(entry: HeartbeatEntry): string {
  const lines = [entry.title, "", entry.body];
  if (entry.schedule) {
    lines.push("", `Schedule: ${entry.schedule}`);
  }
  return lines.join("\n").trim();
}

function findSurfaceMemoryByAttribute(
  memories: MemoryFile[],
  key: string,
  value: string,
): MemoryFile | null {
  return (
    memories.find(
      (memory) => memory.frontmatter.structuredAttributes?.[key] === value,
    ) ?? null
  );
}

function isSurfaceMemory(memory: MemoryFile, surfaceType: string): boolean {
  return memory.frontmatter.structuredAttributes?.[SURFACE_TYPE_KEY] === surfaceType;
}

async function patchMemory(
  storage: RuntimeSurfaceStorage,
  memory: MemoryFile,
  nextContent: string,
  patch: Partial<MemoryFrontmatter>,
): Promise<boolean> {
  let changed = false;
  if (memory.content.trim() !== nextContent.trim()) {
    changed = (await storage.updateMemory(memory.frontmatter.id, nextContent)) || changed;
  }
  const nextTags = JSON.stringify(uniqueTags(patch.tags ?? memory.frontmatter.tags ?? []));
  const prevTags = JSON.stringify(uniqueTags(memory.frontmatter.tags ?? []));
  const nextAttrs = JSON.stringify(patch.structuredAttributes ?? memory.frontmatter.structuredAttributes ?? {});
  const prevAttrs = JSON.stringify(memory.frontmatter.structuredAttributes ?? {});
  const sourceChanged =
    patch.source !== undefined && patch.source !== memory.frontmatter.source;
  const memoryKindChanged =
    patch.memoryKind !== undefined &&
    patch.memoryKind !== memory.frontmatter.memoryKind;
  if (
    nextTags !== prevTags ||
    nextAttrs !== prevAttrs ||
    sourceChanged ||
    memoryKindChanged
  ) {
    changed =
      (await storage.writeMemoryFrontmatter(memory, {
        ...patch,
        tags: uniqueTags(patch.tags ?? memory.frontmatter.tags ?? []),
        updated: new Date().toISOString(),
      })) || changed;
  }
  return changed;
}

export async function syncDreamSurfaceEntries(params: {
  storage: RuntimeSurfaceStorage;
  entries: DreamEntry[];
  journalPath: string;
  maxEntries: number;
  reindexMemory?: (id: string) => Promise<void>;
}): Promise<SurfaceSyncResult> {
  const { storage, journalPath, reindexMemory } = params;
  const maxEntries = Math.max(0, params.maxEntries);
  if (maxEntries === 0) {
    return { created: 0, updated: 0, linked: 0 };
  }
  const entries = params.entries.slice(-maxEntries);
  const memories = await storage.readAllMemories();
  let created = 0;
  let updated = 0;

  for (const entry of entries) {
    const content = buildDreamMemoryContent(entry);
    const tags = uniqueTags([...entry.tags, "dream"]);
    const structuredAttributes = {
      [SURFACE_TYPE_KEY]: DREAM_SURFACE_TYPE,
      [DREAM_ENTRY_ID_KEY]: entry.id,
      remnicDreamTimestamp: entry.timestamp,
      remnicDreamJournalPath: journalPath,
      remnicDreamSourceOffset: String(entry.sourceOffset),
      ...(entry.title ? { remnicDreamTitle: entry.title } : {}),
    };
    const existing = findSurfaceMemoryByAttribute(memories, DREAM_ENTRY_ID_KEY, entry.id);
    if (!existing) {
      const memoryId = await storage.writeMemory("moment", content, {
        confidence: 0.85,
        tags,
        source: "dreams.md",
        memoryKind: "dream",
        structuredAttributes,
      });
      await reindexMemory?.(memoryId);
      created += 1;
      continue;
    }
    if (
      await patchMemory(storage, existing, content, {
        source: "dreams.md",
        memoryKind: "dream",
        tags,
        structuredAttributes,
      })
    ) {
      await reindexMemory?.(existing.frontmatter.id);
      updated += 1;
    }
  }

  return { created, updated, linked: 0 };
}

export async function syncHeartbeatSurfaceEntries(params: {
  storage: RuntimeSurfaceStorage;
  entries: HeartbeatEntry[];
  journalPath: string;
}): Promise<SurfaceSyncResult> {
  const { storage, entries, journalPath } = params;
  const memories = await storage.readAllMemories();
  let created = 0;
  let updated = 0;

  for (const entry of entries) {
    const content = buildHeartbeatMemoryContent(entry);
    const tags = uniqueTags([...entry.tags, "heartbeat", "procedural", entry.slug]);
    const structuredAttributes = {
      [SURFACE_TYPE_KEY]: HEARTBEAT_SURFACE_TYPE,
      [HEARTBEAT_ENTRY_ID_KEY]: entry.id,
      [HEARTBEAT_SLUG_KEY]: entry.slug,
      remnicHeartbeatJournalPath: journalPath,
      remnicHeartbeatSourceOffset: String(entry.sourceOffset),
      ...(entry.schedule ? { remnicHeartbeatSchedule: entry.schedule } : {}),
    };
    const existing =
      findSurfaceMemoryByAttribute(memories, HEARTBEAT_SLUG_KEY, entry.slug) ??
      findSurfaceMemoryByAttribute(memories, HEARTBEAT_ENTRY_ID_KEY, entry.id);

    if (!existing) {
      await storage.writeMemory("principle", content, {
        confidence: 0.95,
        tags,
        source: "heartbeat.md",
        memoryKind: "procedural",
        structuredAttributes,
      });
      created += 1;
      continue;
    }

    if (
      await patchMemory(storage, existing, content, {
        source: "heartbeat.md",
        memoryKind: "procedural",
        tags,
        structuredAttributes,
      })
    ) {
      updated += 1;
    }
  }

  return { created, updated, linked: 0 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectHeartbeatSlug(
  memory: MemoryFile,
  entries: HeartbeatEntry[],
): string | null {
  const haystack = `${memory.content}\n${(memory.frontmatter.tags ?? []).join(" ")}`.toLowerCase();
  const matches = entries.filter((entry) => {
    if (haystack.includes(entry.title.toLowerCase())) return true;
    const slugPattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(entry.slug.toLowerCase())}([^a-z0-9]|$)`);
    return slugPattern.test(haystack);
  });
  return matches.length === 1 ? (matches[0]?.slug ?? null) : null;
}

export async function syncHeartbeatOutcomeLinks(params: {
  storage: RuntimeSurfaceStorage;
  entries: HeartbeatEntry[];
  reindexMemory?: (id: string) => Promise<void>;
  logger?: RuntimeSurfaceLogger;
}): Promise<SurfaceSyncResult> {
  const { storage, entries, reindexMemory, logger } = params;
  const memories = await storage.readAllMemories();
  let linked = 0;

  for (const memory of memories) {
    if (isSurfaceMemory(memory, HEARTBEAT_SURFACE_TYPE)) continue;
    const existingSlug = memory.frontmatter.structuredAttributes?.[HEARTBEAT_SLUG_KEY];
    if (existingSlug) continue;
    const detectedSlug = detectHeartbeatSlug(memory, entries);
    if (!detectedSlug) continue;
    const nextAttributes = {
      ...(memory.frontmatter.structuredAttributes ?? {}),
      [HEARTBEAT_SLUG_KEY]: detectedSlug,
    };
    const nextTags = uniqueTags([
      ...(memory.frontmatter.tags ?? []),
      `heartbeat:${detectedSlug}`,
    ]);
    const wrote = await storage.writeMemoryFrontmatter(memory, {
      structuredAttributes: nextAttributes,
      tags: nextTags,
      updated: new Date().toISOString(),
    });
    if (wrote) {
      await reindexMemory?.(memory.frontmatter.id);
      linked += 1;
      logger?.debug?.(
        `linked memory ${memory.frontmatter.id} to heartbeat slug ${detectedSlug}`,
      );
    }
  }

  return { created: 0, updated: 0, linked };
}

function parseIsoTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function planDreamEntryFromConsolidation(params: {
  observation: ConsolidationObservation;
  existingDreams: DreamEntry[];
  minIntervalMinutes: number;
  now?: Date;
}): DreamNarrativePlan | null {
  const now = params.now ?? new Date();
  const latestDreamAt = Math.max(
    -1,
    ...params.existingDreams
      .map((entry) => parseIsoTimestamp(entry.timestamp))
      .filter((value): value is number => value !== null),
  );
  if (
    latestDreamAt > 0 &&
    now.getTime() - latestDreamAt < params.minIntervalMinutes * 60_000
  ) {
    return null;
  }

  const operationalMemories = params.observation.recentMemories.filter((memory) => {
    const surfaceType = memory.frontmatter.structuredAttributes?.[SURFACE_TYPE_KEY];
    return surfaceType !== DREAM_SURFACE_TYPE && surfaceType !== HEARTBEAT_SURFACE_TYPE;
  });
  const sessionLikeKeys = new Set(
    operationalMemories.map((memory) => {
      return (
        memory.frontmatter.sourceTurnId ??
        memory.frontmatter.created.slice(0, 13)
      );
    }),
  );
  if (sessionLikeKeys.size < 3) return null;

  const suggestedTags = uniqueTags(
    operationalMemories.flatMap((memory) =>
      (memory.frontmatter.tags ?? []).filter((tag) => DREAM_REFLECTION_TAGS.has(tag)),
    ),
  ).slice(0, 4);
  if (suggestedTags.length === 0) return null;

  const memoryContext = operationalMemories.slice(0, 6).map((memory) => {
    const preview = memory.content.replace(/\s+/g, " ").trim();
    const compactPreview =
      preview.length > 220 ? `${preview.slice(0, 220).trimEnd()}...` : preview;
    return `- (${memory.frontmatter.category}) ${compactPreview}`;
  });
  if (memoryContext.length < 3) return null;

  return {
    timestamp: now.toISOString(),
    suggestedTags,
    sessionLikeCount: sessionLikeKeys.size,
    memoryContext,
  };
}

export function parseDreamNarrativeResponse(
  raw: string,
  fallbackTags: string[],
): { title: string | null; body: string; tags: string[] } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const titleMatch = trimmed.match(/^Title:\s*(.+)$/im);
  const bodyMatch = trimmed.match(/^Body:\s*$/im);
  const tagsMatch = trimmed.match(/^Tags:\s*(.+)$/im);
  const title = titleMatch?.[1]?.trim() || null;
  const body =
    bodyMatch && bodyMatch.index !== undefined
      ? trimmed.slice(bodyMatch.index + bodyMatch[0].length).trim()
      : trimmed.replace(/^Title:.*$/im, "").replace(/^Tags:.*$/im, "").trim();
  if (body.length === 0) return null;
  const parsedTags =
    tagsMatch?.[1]
      ?.split(/\s+/)
      .map((tag) => tag.replace(/^#/, "").trim())
      .filter(Boolean) ?? [];
  return {
    title,
    body,
    tags: uniqueTags(parsedTags.length > 0 ? parsedTags : fallbackTags),
  };
}
