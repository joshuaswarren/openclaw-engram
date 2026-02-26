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
    /(^|\n)\[WORK_LAYER_CONTEXT(?:\s+link_to_memory=(true|false))?(?:\s+encoding=(base64))?\]\s*([\s\S]*?)\s*\[\/WORK_LAYER_CONTEXT\]/g;

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
  const strippedUnterminated = bounded.replace(
    /(^|\n)\[WORK_LAYER_CONTEXT(?=[^\]]*(?:\blink_to_memory=|\bencoding=))[^\]]*\][\s\S]*$/,
    "$1",
  );

  const restoredEscapes = strippedUnterminated
    .replaceAll(WORK_LAYER_CONTEXT_ESCAPED_OPEN, WORK_LAYER_CONTEXT_OPEN)
    .replaceAll(WORK_LAYER_CONTEXT_ESCAPED_CLOSE, WORK_LAYER_CONTEXT_CLOSE);

  const cleanedLines = restoredEscapes
    .split("\n")
    .map((line) => line.trimEnd());

  return cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
