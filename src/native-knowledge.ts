import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { NativeKnowledgeConfig } from "./types.js";

export type NativeKnowledgeChunk = {
  chunkId: string;
  sourcePath: string;
  title: string;
  sourceKind: "identity" | "memory" | "workspace_doc";
  startLine: number;
  endLine: number;
  content: string;
};

export type NativeKnowledgeSearchResult = NativeKnowledgeChunk & {
  score: number;
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value).split(/\s+/).filter((token) => token.length >= 2);
}

function detectSourceKind(filePath: string): NativeKnowledgeChunk["sourceKind"] {
  const base = path.basename(filePath).toLowerCase();
  if (base.startsWith("identity")) return "identity";
  if (base === "memory.md") return "memory";
  return "workspace_doc";
}

function chunkHeadingAware(options: {
  sourcePath: string;
  content: string;
  maxChunkChars: number;
}): NativeKnowledgeChunk[] {
  const lines = options.content.replace(/\r\n/g, "\n").split("\n");
  const chunks: NativeKnowledgeChunk[] = [];
  let currentTitle = path.basename(options.sourcePath);
  let currentLines: string[] = [];
  let startLine = 1;

  const flush = () => {
    const paragraphs: Array<{
      content: string;
      startLine: number;
      endLine: number;
    }> = [];
    let paragraphLines: string[] = [];
    let paragraphStartOffset: number | null = null;

    const pushParagraph = (lineOffsetExclusive: number) => {
      if (paragraphLines.length === 0 || paragraphStartOffset === null) return;
      paragraphs.push({
        content: paragraphLines.join("\n").trim(),
        startLine: startLine + paragraphStartOffset,
        endLine: startLine + lineOffsetExclusive - 1,
      });
      paragraphLines = [];
      paragraphStartOffset = null;
    };

    for (let index = 0; index < currentLines.length; index += 1) {
      const line = currentLines[index] ?? "";
      if (line.trim().length === 0) {
        pushParagraph(index);
        continue;
      }
      if (paragraphStartOffset === null) paragraphStartOffset = index;
      paragraphLines.push(line);
    }
    pushParagraph(currentLines.length);

    if (paragraphs.length === 0) return;

    const body = paragraphs.map((paragraph) => paragraph.content).join("\n\n");

    if (body.length <= options.maxChunkChars) {
      chunks.push({
        chunkId: `${options.sourcePath}:${paragraphs[0]!.startLine}-${paragraphs[paragraphs.length - 1]!.endLine}`,
        sourcePath: options.sourcePath,
        title: currentTitle,
        sourceKind: detectSourceKind(options.sourcePath),
        startLine: paragraphs[0]!.startLine,
        endLine: paragraphs[paragraphs.length - 1]!.endLine,
        content: body,
      });
      return;
    }

    let buffer = "";
    let bufferStartLine = paragraphs[0]!.startLine;
    let bufferEndLine = paragraphs[0]!.endLine;

    for (const paragraph of paragraphs) {
      const next = buffer.length > 0 ? `${buffer}\n\n${paragraph.content}` : paragraph.content;
      if (next.length > options.maxChunkChars && buffer.length > 0) {
        chunks.push({
          chunkId: `${options.sourcePath}:${bufferStartLine}-${bufferEndLine}`,
          sourcePath: options.sourcePath,
          title: currentTitle,
          sourceKind: detectSourceKind(options.sourcePath),
          startLine: bufferStartLine,
          endLine: bufferEndLine,
          content: buffer,
        });
        buffer = paragraph.content;
        bufferStartLine = paragraph.startLine;
        bufferEndLine = paragraph.endLine;
      } else {
        buffer = next;
        bufferEndLine = paragraph.endLine;
      }
    }

    if (buffer.length > 0) {
      chunks.push({
        chunkId: `${options.sourcePath}:${bufferStartLine}-${bufferEndLine}`,
        sourcePath: options.sourcePath,
        title: currentTitle,
        sourceKind: detectSourceKind(options.sourcePath),
        startLine: bufferStartLine,
        endLine: bufferEndLine,
        content: buffer,
      });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s+/.test(line) && currentLines.length > 0) {
      flush();
      currentLines = [];
      currentTitle = line.replace(/^#{1,6}\s+/, "").trim() || currentTitle;
      startLine = index + 2;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      currentTitle = line.replace(/^#{1,6}\s+/, "").trim() || currentTitle;
      startLine = index + 2;
      continue;
    }
    currentLines.push(line);
  }

  flush();
  return chunks;
}

async function readableFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

function resolveCandidatePaths(options: {
  workspaceDir: string;
  includeFiles: string[];
  recallNamespaces?: string[];
  defaultNamespace: string;
}): string[] {
  const out = new Set<string>();
  for (const rel of options.includeFiles) {
    const trimmed = rel.trim();
    if (!trimmed) continue;
    out.add(path.join(options.workspaceDir, trimmed));
    if (
      path.basename(trimmed).toLowerCase() === "identity.md" &&
      Array.isArray(options.recallNamespaces)
    ) {
      const relativeDir = path.dirname(trimmed);
      for (const namespace of options.recallNamespaces) {
        if (!namespace || namespace === options.defaultNamespace) continue;
        out.add(
          path.join(
            options.workspaceDir,
            relativeDir,
            `IDENTITY.${namespace}.md`,
          ),
        );
      }
    }
  }
  return Array.from(out);
}

export async function collectNativeKnowledgeChunks(options: {
  workspaceDir: string;
  config: NativeKnowledgeConfig;
  recallNamespaces?: string[];
  defaultNamespace: string;
}): Promise<NativeKnowledgeChunk[]> {
  if (!options.config.enabled) return [];

  const chunks: NativeKnowledgeChunk[] = [];
  const candidatePaths = resolveCandidatePaths({
    workspaceDir: options.workspaceDir,
    includeFiles: options.config.includeFiles,
    recallNamespaces: options.recallNamespaces,
    defaultNamespace: options.defaultNamespace,
  });
  for (const filePath of candidatePaths) {
    if (!(await readableFile(filePath))) continue;
    const content = await readFile(filePath, "utf-8").catch(() => null);
    if (!content) continue;
    chunks.push(
      ...chunkHeadingAware({
        sourcePath: path.relative(options.workspaceDir, filePath),
        content,
        maxChunkChars: options.config.maxChunkChars,
      }),
    );
  }
  return chunks;
}

export function searchNativeKnowledge(options: {
  query: string;
  chunks: NativeKnowledgeChunk[];
  maxResults: number;
}): NativeKnowledgeSearchResult[] {
  const normalizedQuery = normalizeText(options.query);
  const queryTokens = new Set(tokenize(options.query));
  if (!normalizedQuery || queryTokens.size === 0 || options.maxResults <= 0) return [];

  return options.chunks
    .map((chunk) => {
      const normalizedContent = normalizeText(`${chunk.title}\n${chunk.content}`);
      const contentTokens = new Set(tokenize(normalizedContent));
      let overlap = 0;
      for (const token of queryTokens) {
        if (contentTokens.has(token)) overlap += 1;
      }
      if (overlap === 0 && !normalizedContent.includes(normalizedQuery)) return null;
      const kindBoost =
        chunk.sourceKind === "identity" ? 0.15 : chunk.sourceKind === "memory" ? 0.1 : 0.05;
      const phraseBoost = normalizedContent.includes(normalizedQuery) ? 0.35 : 0;
      return {
        ...chunk,
        score: overlap / Math.max(queryTokens.size, 1) + kindBoost + phraseBoost,
      };
    })
    .filter((chunk): chunk is NativeKnowledgeSearchResult => chunk !== null)
    .sort((a, b) => b.score - a.score || a.sourcePath.localeCompare(b.sourcePath) || a.startLine - b.startLine)
    .slice(0, options.maxResults);
}

export function formatNativeKnowledgeSection(options: {
  results: NativeKnowledgeSearchResult[];
  maxChars: number;
}): string | null {
  if (options.results.length === 0 || options.maxChars <= 0) return null;
  const lines = ["## Curated Workspace Knowledge", ""];
  let used = lines.join("\n").length;

  for (const result of options.results) {
    const snippet = result.content.length > 500 ? `${result.content.slice(0, 497)}...` : result.content;
    const block =
      `- ${result.sourcePath}:${result.startLine}-${result.endLine} [${result.title}] ` +
      `(score: ${result.score.toFixed(3)})\n  ${snippet.replace(/\n/g, "\n  ")}`;
    if (used + block.length > options.maxChars && lines.length > 2) break;
    if (used + block.length > options.maxChars) return null;
    lines.push(block);
    used += block.length + 1;
  }

  return lines.length > 2 ? lines.join("\n") : null;
}
