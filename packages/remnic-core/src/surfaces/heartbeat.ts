import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";

export interface HeartbeatEntry {
  id: string;
  slug: string;
  title: string;
  body: string;
  schedule: string | null;
  tags: string[];
  sourceOffset: number;
}

export interface HeartbeatSurface {
  read(path: string): Promise<HeartbeatEntry[]>;
  watch(path: string, onChange: (entries: HeartbeatEntry[]) => void): () => void;
  findBySlug(entries: HeartbeatEntry[], slug: string): HeartbeatEntry | null;
}

function stableHeartbeatId(entry: Omit<HeartbeatEntry, "id" | "sourceOffset">): string {
  const digest = createHash("sha1")
    .update(
      JSON.stringify({
        slug: entry.slug,
        title: entry.title,
        body: entry.body,
        schedule: entry.schedule,
        tags: entry.tags,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return `heartbeat-${digest}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseTags(line: string): string[] {
  const match = /^Tags:\s*(.*)$/i.exec(line.trim());
  if (!match) return [];
  return match[1]
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.replace(/^#/, ""));
}

function buildEntry(params: {
  slug: string;
  title: string;
  body: string;
  schedule: string | null;
  tags: string[];
  sourceOffset: number;
}): HeartbeatEntry {
  const normalized: Omit<HeartbeatEntry, "id" | "sourceOffset"> = {
    slug: params.slug,
    title: params.title.trim(),
    body: params.body.trim(),
    schedule: params.schedule?.trim() || null,
    tags: params.tags,
  };
  return {
    id: stableHeartbeatId(normalized),
    ...normalized,
    sourceOffset: params.sourceOffset,
  };
}

function parseSectionEntries(content: string): HeartbeatEntry[] {
  const entries: HeartbeatEntry[] = [];
  const regex = /^##\s+(.+)$/gm;
  const matches = [...content.matchAll(regex)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1]?.index ?? content.length) : content.length;
    const rawTitle = match[1]?.trim() ?? "";
    const chunk = content.slice(start + match[0].length, end).replace(/^\s+/, "");
    const trimmed = chunk.replace(/\n---\s*$/m, "").trim();
    const lines = trimmed.split("\n");
    const tags = lines.length > 0 ? parseTags(lines[lines.length - 1] ?? "") : [];
    const withoutTags =
      tags.length > 0
        ? lines.slice(0, Math.max(0, lines.length - 1))
        : lines;
    let schedule: string | null = null;
    const bodyLines: string[] = [];
    for (const line of withoutTags) {
      const scheduleMatch = /^Schedule:\s*(.+)$/i.exec(line.trim());
      if (scheduleMatch) {
        schedule = scheduleMatch[1]?.trim() || null;
        continue;
      }
      bodyLines.push(line);
    }
    entries.push(
      buildEntry({
        slug: slugify(rawTitle),
        title: rawTitle,
        body: bodyLines.join("\n"),
        schedule,
        tags,
        sourceOffset: start,
      }),
    );
  }
  return entries;
}

function parseTaskBlock(content: string): HeartbeatEntry[] {
  const lines = content.split("\n");
  const entries: HeartbeatEntry[] = [];
  let inTasks = false;
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineOffset = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed === "tasks:") {
      inTasks = true;
      continue;
    }
    if (!inTasks) continue;
    if (trimmed.startsWith("- name:")) {
      const title = trimmed.replace(/^- name:\s*/, "").replace(/^["']|["']$/g, "").trim();
      let schedule: string | null = null;
      let body = "";
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = lines[cursor] ?? "";
        const nextTrimmed = next.trim();
        if (nextTrimmed.startsWith("- name:")) break;
        if (!next.startsWith(" ") && nextTrimmed) break;
        if (nextTrimmed.startsWith("interval:")) {
          schedule = nextTrimmed.replace(/^interval:\s*/, "").replace(/^["']|["']$/g, "").trim();
          continue;
        }
        if (nextTrimmed.startsWith("prompt:")) {
          body = nextTrimmed.replace(/^prompt:\s*/, "").replace(/^["']|["']$/g, "").trim();
        }
      }
      entries.push(
        buildEntry({
          slug: slugify(title),
          title,
          body,
          schedule,
          tags: [],
          sourceOffset: lineOffset,
        }),
      );
    }
  }
  return entries;
}

function parseHeartbeatEntries(content: string): HeartbeatEntry[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const sectionEntries = parseSectionEntries(normalized);
  if (sectionEntries.length > 0) return sectionEntries;
  return parseTaskBlock(normalized);
}

export function createHeartbeatSurface(): HeartbeatSurface {
  return {
    async read(filePath: string): Promise<HeartbeatEntry[]> {
      try {
        const content = await readFile(filePath, "utf8");
        return parseHeartbeatEntries(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },

    watch(filePath: string, onChange: (entries: HeartbeatEntry[]) => void): () => void {
      let watcher: FSWatcher | null = null;
      let timer: NodeJS.Timeout | null = null;
      const emit = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          timer = null;
          onChange(await this.read(filePath));
        }, 25);
      };
      try {
        watcher = watch(filePath, { persistent: false }, emit);
      } catch {
        watcher = null;
      }
      return () => {
        if (timer) clearTimeout(timer);
        watcher?.close();
      };
    },

    findBySlug(entries: HeartbeatEntry[], slug: string): HeartbeatEntry | null {
      return entries.find((entry) => entry.slug === slug) ?? null;
    },
  };
}
