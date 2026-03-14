import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryFile } from "./types.js";

const PROMPT_RELATIVE_PATH = path.join("prompts", "day_summary.prompt.md");

function candidateRoots(): string[] {
  const currentFile = fileURLToPath(import.meta.url);
  const here = path.dirname(currentFile);
  const candidates = [path.resolve(here, ".."), path.resolve(here, "..", ".."), process.cwd()];

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function resolvePromptPath(): string {
  for (const root of candidateRoots()) {
    const candidate = path.join(root, PROMPT_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`day summary prompt file not found: ${PROMPT_RELATIVE_PATH}`);
}

export async function loadDaySummaryPrompt(): Promise<string> {
  const raw = await readFile(resolvePromptPath(), "utf-8");
  const match = raw.match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error("day summary prompt file does not contain a fenced prompt block");
  }
  return match[1].trim();
}

export function formatDaySummaryMemories(memories: string | MemoryFile[]): string {
  if (typeof memories === "string") {
    return memories.trim();
  }

  return memories
    .map((memory) => {
      const category = memory.frontmatter.category || "fact";
      const created = memory.frontmatter.created || "unknown";
      return `[${memory.frontmatter.id}] (${category}, ${created})\n${memory.content}`;
    })
    .join("\n\n")
    .trim();
}
