export const WORK_LAYER_CONTEXT_OPEN = "[WORK_LAYER_CONTEXT";
export const WORK_LAYER_CONTEXT_CLOSE = "[/WORK_LAYER_CONTEXT]";
const WORK_LAYER_CONTEXT_ESCAPED_OPEN = "[WORK_LAYER_ESCAPED_CONTEXT";
const WORK_LAYER_CONTEXT_ESCAPED_CLOSE = "[/WORK_LAYER_CONTEXT_ESC]";

export function wrapWorkLayerContext(content: string, options?: { linkToMemory?: boolean }): string {
  const linkToMemory = options?.linkToMemory === true;
  const header = `${WORK_LAYER_CONTEXT_OPEN} link_to_memory=${linkToMemory ? "true" : "false"}]`;
  const payload = content
    .trim()
    .replaceAll(WORK_LAYER_CONTEXT_OPEN, WORK_LAYER_CONTEXT_ESCAPED_OPEN)
    .replaceAll(WORK_LAYER_CONTEXT_CLOSE, WORK_LAYER_CONTEXT_ESCAPED_CLOSE);
  return `${header}\n${payload}\n${WORK_LAYER_CONTEXT_CLOSE}`;
}

export function applyWorkExtractionBoundary(conversation: string): string {
  if (conversation.trim().length === 0) return "";

  const blockPattern =
    /(^|\n)\[WORK_LAYER_CONTEXT(?:\s+link_to_memory=(true|false))?(?:\s+encoding=(base64))?\]\n?([\s\S]*?)\n?\[\/WORK_LAYER_CONTEXT\]/g;

  const bounded = conversation.replace(
    blockPattern,
    (_full, prefix: string, flag: string | undefined, encoding: string | undefined, body: string) => {
    const shouldLink = typeof flag === "string" && flag.toLowerCase() === "true";
    if (!shouldLink) return prefix;

    if (typeof encoding === "string" && encoding.toLowerCase() === "base64") {
      try {
        return `${prefix}${Buffer.from(body.trim(), "base64").toString("utf8").trim()}`;
      } catch {
        return prefix;
      }
    }

    // Default wrapper keeps payload readable and escapes wrapper delimiters inside content.
    return `${prefix}${body.trim()}`;
  });

  // Defensive hardening: if a *real wrapper opener* survives without a closer (e.g., turn-level truncation),
  // strip everything from the opener onward to avoid leaking excluded work-layer payloads.
  // Keep literal "[WORK_LAYER_CONTEXT" text unless it contains wrapper metadata attributes.
  // Strip unterminated work-layer openers using indexOf for safety (avoids backtracking).
  let strippedUnterminated = bounded;
  const opener = "[WORK_LAYER_CONTEXT";
  const closer = "[/WORK_LAYER_CONTEXT]";
  const lastOpenerIdx = bounded.lastIndexOf(opener);
  if (lastOpenerIdx >= 0) {
    const afterOpener = bounded.indexOf("]", lastOpenerIdx);
    if (afterOpener >= 0) {
      const closerAfter = bounded.indexOf(closer, afterOpener);
      if (closerAfter < 0) {
        // Unterminated — only strip if it has real metadata attributes
        const bracketContent = bounded.substring(lastOpenerIdx, afterOpener + 1);
        if (bracketContent.includes("link_to_memory=") || bracketContent.includes("encoding=")) {
          const newlineIdx = bounded.lastIndexOf("\n", lastOpenerIdx);
          strippedUnterminated = bounded.substring(0, newlineIdx >= 0 ? newlineIdx : lastOpenerIdx);
        }
      }
    }
  }

  const restoredEscapes = strippedUnterminated
    .replaceAll(WORK_LAYER_CONTEXT_ESCAPED_OPEN, WORK_LAYER_CONTEXT_OPEN)
    .replaceAll(WORK_LAYER_CONTEXT_ESCAPED_CLOSE, WORK_LAYER_CONTEXT_CLOSE);

  const cleanedLines = restoredEscapes
    .split("\n")
    .map((line) => line.trimEnd());

  return cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
