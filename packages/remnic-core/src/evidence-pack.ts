export interface EvidencePackItem {
  id?: string;
  sessionId?: string;
  turnIndex?: number;
  role?: string;
  content: string;
  score?: number;
}

export interface EvidencePackOptions {
  title?: string;
  maxChars: number;
  maxItemChars?: number;
}

const DEFAULT_MAX_ITEM_CHARS = 1_200;

export function buildEvidencePack(
  items: readonly EvidencePackItem[],
  options: EvidencePackOptions,
): string {
  const budget = normalizePositiveInteger(options.maxChars);
  if (budget <= 0 || items.length === 0) {
    return "";
  }

  const maxItemChars = normalizePositiveInteger(
    options.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS,
  );
  if (maxItemChars <= 0) {
    return "";
  }

  const title = options.title ?? "Evidence";
  const lines: string[] = [`## ${title}`];
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  let used = lines[0]!.length;

  for (const item of items) {
    const content = item.content.trim();
    if (!content) continue;

    const id = item.id ?? evidenceItemFallbackId(item);
    if (id && seenIds.has(id)) continue;

    const contentKey = normalizeEvidenceContent(content);
    if (seenContent.has(contentKey)) continue;

    const label = formatEvidenceLabel(item);
    const clipped = clipText(content, maxItemChars);
    const block = `${label}: ${clipped}`;
    const separatorLength = lines.length > 0 ? 2 : 0;
    const remaining = budget - used - separatorLength;
    if (remaining <= 0) break;

    const finalBlock =
      block.length > remaining ? clipText(block, remaining) : block;
    if (!finalBlock.trim()) break;

    lines.push(finalBlock);
    used += separatorLength + finalBlock.length;
    if (id) seenIds.add(id);
    seenContent.add(contentKey);
  }

  return lines.length === 1 ? "" : lines.join("\n\n");
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function evidenceItemFallbackId(item: EvidencePackItem): string | undefined {
  if (item.sessionId && typeof item.turnIndex === "number") {
    return `${item.sessionId}:${item.turnIndex}`;
  }
  return undefined;
}

function normalizeEvidenceContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function formatEvidenceLabel(item: EvidencePackItem): string {
  const parts: string[] = [];
  if (item.sessionId) parts.push(item.sessionId);
  if (typeof item.turnIndex === "number") parts.push(`turn ${item.turnIndex}`);
  if (item.role) parts.push(item.role);
  if (typeof item.score === "number" && Number.isFinite(item.score)) {
    parts.push(`score ${item.score.toFixed(3)}`);
  }
  return parts.length > 0 ? `[${parts.join(", ")}]` : "[evidence]";
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(0, maxChars);
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}
