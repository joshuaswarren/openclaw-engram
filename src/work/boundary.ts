export const WORK_LAYER_CONTEXT_OPEN = "[WORK_LAYER_CONTEXT";
export const WORK_LAYER_CONTEXT_CLOSE = "[/WORK_LAYER_CONTEXT]";

export function wrapWorkLayerContext(content: string, options?: { linkToMemory?: boolean }): string {
  const linkToMemory = options?.linkToMemory === true;
  const header = `${WORK_LAYER_CONTEXT_OPEN} link_to_memory=${linkToMemory ? "true" : "false"} encoding=base64]`;
  const payload = Buffer.from(content.trim(), "utf8").toString("base64");
  return `${header}\n${payload}\n${WORK_LAYER_CONTEXT_CLOSE}`;
}

export function applyWorkExtractionBoundary(conversation: string): string {
  if (conversation.trim().length === 0) return "";

  const blockPattern =
    /\[WORK_LAYER_CONTEXT(?:\s+link_to_memory=(true|false))?(?:\s+encoding=(base64))?\]\s*([\s\S]*?)\s*\[\/WORK_LAYER_CONTEXT\]/g;

  const bounded = conversation.replace(
    blockPattern,
    (_full, flag: string | undefined, encoding: string | undefined, body: string) => {
    const shouldLink = typeof flag === "string" && flag.toLowerCase() === "true";
    if (!shouldLink) return "";

    if (typeof encoding === "string" && encoding.toLowerCase() === "base64") {
      try {
        return Buffer.from(body.trim(), "base64").toString("utf8").trim();
      } catch {
        return "";
      }
    }

    // Backward compatibility for legacy non-encoded wrappers.
    return body.trim();
  });

  const cleanedLines = bounded
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !/^\[(user|assistant)\]\s*$/.test(line));

  return cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
