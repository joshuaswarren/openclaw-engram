import { randomUUID } from "node:crypto";
import type { Orchestrator } from "./orchestrator.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import type { CaptureMode, MemoryCategory, MemoryLifecycleEvent, PluginConfig } from "./types.js";

export type ExplicitCaptureInput = {
  content: string;
  category?: string;
  confidence?: number;
  namespace?: string;
  tags?: string[];
  entityRef?: string;
  ttl?: string;
  sourceReason?: string;
};

export type ValidExplicitCapture = {
  content: string;
  category: MemoryCategory;
  confidence: number;
  namespace?: string;
  tags: string[];
  entityRef?: string;
  ttl?: string;
  sourceReason?: string;
};

const INLINE_NOTE_RE = /<memory_note>\s*([\s\S]*?)\s*<\/memory_note>/gi;
const INLINE_ALLOWED_CATEGORIES = new Set<MemoryCategory>([
  "fact",
  "preference",
  "correction",
  "entity",
  "decision",
  "relationship",
  "principle",
  "commitment",
  "moment",
  "skill",
  "rule",
]);

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i,
  /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*[^\s]{8,}\b/i,
  /\b(?:authorization)\s*:\s*[^\s]{8,}\b/i,
];

function asTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCaptureContent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseExplicitCaptureTtl(ttl: string | undefined): string | undefined {
  const raw = asTrimmed(ttl);
  if (!raw) return undefined;

  const absoluteMs = Date.parse(raw);
  if (Number.isFinite(absoluteMs)) {
    return new Date(absoluteMs).toISOString();
  }

  const relative = raw.match(/^(\d+)\s*([mhdw])$/i);
  if (!relative) {
    throw new Error("ttl must be an ISO-8601 timestamp or relative duration like 30m, 12h, 7d, or 2w");
  }

  const amount = Number.parseInt(relative[1] ?? "", 10);
  const unit = (relative[2] ?? "").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("ttl duration must be a positive integer");
  }

  const multiplier =
    unit === "m" ? 60_000
      : unit === "h" ? 60 * 60_000
        : unit === "d" ? 24 * 60 * 60_000
          : 7 * 24 * 60 * 60_000;
  return new Date(Date.now() + amount * multiplier).toISOString();
}

function parseInlineNote(block: string): ExplicitCaptureInput | null {
  const lines = block.replace(/\r/g, "").split("\n");
  const note: Partial<ExplicitCaptureInput> = {};
  let idx = 0;

  while (idx < lines.length) {
    const rawLine = lines[idx] ?? "";
    const line = rawLine.trim();
    idx += 1;
    if (line.length === 0) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (key === "content" && value === "|") {
      const contentLines: string[] = [];
      while (idx < lines.length) {
        const next = lines[idx] ?? "";
        if (next.startsWith("  ") || next.startsWith("\t")) {
          contentLines.push(next.replace(/^(  |\t)/, ""));
          idx += 1;
          continue;
        }
        if (next.trim().length === 0) {
          contentLines.push("");
          idx += 1;
          continue;
        }
        break;
      }
      note.content = contentLines.join("\n").trim();
      continue;
    }

    switch (key) {
      case "content":
        note.content = value;
        break;
      case "category":
        note.category = value;
        break;
      case "confidence":
        note.confidence = Number.parseFloat(value);
        break;
      case "namespace":
        note.namespace = value;
        break;
      case "tags":
        note.tags = value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      case "entityRef":
        note.entityRef = value;
        break;
      case "ttl":
        note.ttl = value;
        break;
      case "sourceReason":
        note.sourceReason = value;
        break;
      default:
        break;
    }
  }

  return asTrimmed(note.content) ? (note as ExplicitCaptureInput) : null;
}

export function parseInlineExplicitCaptureNotes(text: string): ExplicitCaptureInput[] {
  const notes: ExplicitCaptureInput[] = [];
  for (const match of text.matchAll(INLINE_NOTE_RE)) {
    const parsed = parseInlineNote(match[1] ?? "");
    if (parsed) notes.push(parsed);
  }
  return notes;
}

export function stripInlineExplicitCaptureNotes(text: string): string {
  return text.replace(INLINE_NOTE_RE, "").trim();
}

export function validateExplicitCaptureInput(input: ExplicitCaptureInput): ValidExplicitCapture {
  const content = asTrimmed(input.content);
  if (!content) throw new Error("content is required");
  if (content.length < 10) throw new Error("content must be at least 10 characters");
  if (content.length > 4000) throw new Error("content must be 4000 characters or fewer");
  if (/<memory_note>/i.test(content) || /<\/memory_note>/i.test(content)) {
    throw new Error("nested memory_note blocks are not allowed");
  }

  const category = (asTrimmed(input.category) ?? "fact") as MemoryCategory;
  if (!INLINE_ALLOWED_CATEGORIES.has(category)) {
    throw new Error(`unsupported category: ${input.category ?? category}`);
  }

  const sanitized = sanitizeMemoryContent(content);
  if (!sanitized.clean) {
    throw new Error("content failed memory sanitization");
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      throw new Error("content appears to contain a secret or credential");
    }
  }

  const confidence = Number.isFinite(input.confidence) ? Number(input.confidence) : 0.95;
  if (confidence < 0 || confidence > 1) {
    throw new Error("confidence must be between 0 and 1");
  }

  return {
    content,
    category,
    confidence,
    namespace: asTrimmed(input.namespace),
    tags: Array.from(new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))),
    entityRef: asTrimmed(input.entityRef),
    ttl: asTrimmed(input.ttl),
    sourceReason: asTrimmed(input.sourceReason),
  };
}

export async function findDuplicateExplicitCapture(
  orchestrator: Orchestrator,
  candidate: ValidExplicitCapture,
): Promise<string | null> {
  const storage = await orchestrator.getStorage(candidate.namespace);
  if (
    candidate.category === "fact"
    && typeof (storage as { hasFactContentHash?: (content: string) => Promise<boolean> }).hasFactContentHash === "function"
  ) {
    const hasHash = await (storage as { hasFactContentHash: (content: string) => Promise<boolean> }).hasFactContentHash(
      candidate.content,
    );
    if (!hasHash) return null;
  }
  const existing = await storage.readAllMemories();
  const normalizedCandidate = normalizeCaptureContent(candidate.content);
  const match = existing.find((memory) => {
    const status = memory.frontmatter.status ?? "active";
    if (status !== "active") return false;
    if (memory.frontmatter.category !== candidate.category) return false;
    return normalizeCaptureContent(memory.content) === normalizedCandidate;
  });
  return match?.frontmatter.id ?? null;
}

export async function persistExplicitCapture(
  orchestrator: Orchestrator,
  candidate: ValidExplicitCapture,
  source: "tool" | "inline",
): Promise<{ id: string; duplicateOf?: string }> {
  const duplicateOf = await findDuplicateExplicitCapture(orchestrator, candidate);
  if (duplicateOf) {
    return { id: duplicateOf, duplicateOf };
  }

  const storage = await orchestrator.getStorage(candidate.namespace);
  const id = await storage.writeMemory(candidate.category, candidate.content, {
    confidence: candidate.confidence,
    tags: candidate.tags,
    entityRef: candidate.entityRef,
    expiresAt: parseExplicitCaptureTtl(candidate.ttl),
    source: source === "tool" ? "explicit" : "explicit-inline",
  });

  const created = new Date().toISOString();
  const event: MemoryLifecycleEvent = {
    eventId: `mle-${randomUUID()}`,
    memoryId: id,
    eventType: "explicit_capture_accepted",
    timestamp: created,
    actor: source === "tool" ? "tool.memory_capture" : "inline.memory_note",
    reasonCode: candidate.sourceReason,
    ruleVersion: "explicit-capture.v1",
  };
  await storage.appendMemoryLifecycleEvents([event]);

  return { id };
}

export function shouldSkipImplicitExtraction(cfg: Pick<PluginConfig, "captureMode">): boolean {
  return cfg.captureMode === "explicit";
}

export function shouldProcessInlineExplicitCapture(cfg: Pick<PluginConfig, "captureMode">): boolean {
  return cfg.captureMode !== "implicit";
}
