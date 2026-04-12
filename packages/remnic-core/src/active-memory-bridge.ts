import type { MemoryFile } from "./types.js";

export interface ActiveMemoryMetadata {
  type?: "fact" | "preference";
  topic?: string;
  updatedAt?: string;
  sourceUri?: string;
}

export interface ActiveMemorySearchResult {
  id: string;
  score: number;
  text: string;
  metadata?: ActiveMemoryMetadata;
}

export interface ActiveMemorySearchOutput {
  results: ActiveMemorySearchResult[];
  truncated: boolean;
}

export interface ActiveMemoryGetOutput {
  id?: string;
  text?: string;
  metadata?: ActiveMemoryMetadata;
  error?: "not_found";
}

export interface ActiveMemoryRecallParams {
  query: string;
  limit?: number;
  sessionKey: string;
  filters?: Record<string, unknown>;
  snippetMaxChars?: number;
}

type ActiveMemorySearchCandidate = {
  id?: string;
  score?: number;
  snippet?: string;
  text?: string;
  path?: string;
  metadata?: Record<string, unknown>;
};

function clampLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateSnippet(value: string, maxChars: number): string {
  const compact = collapseWhitespace(value);
  if (compact.length <= maxChars) return compact;
  return compact.slice(0, Math.max(1, maxChars)).trimEnd();
}

function pickMetadata(value: Record<string, unknown> | undefined): ActiveMemoryMetadata | undefined {
  if (!value) return undefined;
  const metadata: ActiveMemoryMetadata = {};
  if (typeof value.type === "string") metadata.type = value.type as ActiveMemoryMetadata["type"];
  if (typeof value.topic === "string") metadata.topic = value.topic;
  if (typeof value.updatedAt === "string") metadata.updatedAt = value.updatedAt;
  if (typeof value.sourceUri === "string") metadata.sourceUri = value.sourceUri;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export async function recallForActiveMemory(
  orchestrator: {
    searchAcrossNamespaces: (params: {
      query: string;
      maxResults?: number;
      namespaces?: string[];
      mode?: string;
    }) => Promise<ActiveMemorySearchCandidate[]>;
  },
  params: ActiveMemoryRecallParams,
): Promise<ActiveMemorySearchOutput> {
  const limit = clampLimit(params.limit);
  const snippetMaxChars =
    typeof params.snippetMaxChars === "number" && Number.isFinite(params.snippetMaxChars)
      ? Math.max(1, Math.min(4000, Math.floor(params.snippetMaxChars)))
      : 600;
  const namespace =
    typeof params.filters?.namespace === "string" && params.filters.namespace.trim().length > 0
      ? params.filters.namespace.trim()
      : undefined;

  const raw = await orchestrator.searchAcrossNamespaces({
    query: params.query,
    maxResults: limit + 1,
    namespaces: namespace ? [namespace] : undefined,
    mode: "search",
  });

  return {
    results: raw.slice(0, limit).map((candidate, index) => ({
      id: candidate.id ?? candidate.path ?? `memory-${index + 1}`,
      score: typeof candidate.score === "number" ? candidate.score : 0,
      text: truncateSnippet(candidate.snippet ?? candidate.text ?? "", snippetMaxChars),
      metadata: pickMetadata(candidate.metadata),
    })),
    truncated: raw.length > limit,
  };
}

function buildActiveMemoryMetadataFromMemory(memory: MemoryFile): ActiveMemoryMetadata | undefined {
  const metadata: ActiveMemoryMetadata = {};
  if (typeof memory.frontmatter.category === "string") {
    const category = memory.frontmatter.category;
    if (category === "fact" || category === "preference") {
      metadata.type = category;
    }
  }
  if (Array.isArray(memory.frontmatter.tags) && memory.frontmatter.tags.length > 0) {
    metadata.topic = memory.frontmatter.tags[0];
  }
  if (typeof memory.frontmatter.updated === "string") metadata.updatedAt = memory.frontmatter.updated;
  if (typeof memory.frontmatter.source === "string") metadata.sourceUri = memory.frontmatter.source;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export async function getMemoryForActiveMemory(
  orchestrator: {
    storage?: {
      getMemoryById?: (id: string) => Promise<MemoryFile | null>;
    };
  },
  id: string,
): Promise<ActiveMemoryGetOutput> {
  const memory = await orchestrator.storage?.getMemoryById?.(id);
  if (!memory) return { error: "not_found" };
  return {
    id,
    text: collapseWhitespace(memory.content),
    metadata: buildActiveMemoryMetadataFromMemory(memory),
  };
}
