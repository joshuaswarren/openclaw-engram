export const WORK_LAYER_CONTEXT_OPEN = "[WORK_LAYER_CONTEXT";
export const WORK_LAYER_CONTEXT_CLOSE = "[/WORK_LAYER_CONTEXT]";

export function wrapWorkLayerContext(content: string, options?: { linkToMemory?: boolean }): string {
  const linkToMemory = options?.linkToMemory === true;
  const header = `${WORK_LAYER_CONTEXT_OPEN} link_to_memory=${linkToMemory ? "true" : "false"}]`;
  return `${header}\n${content.trim()}\n${WORK_LAYER_CONTEXT_CLOSE}`;
}

export function applyWorkExtractionBoundary(conversation: string): string {
  if (conversation.trim().length === 0) return "";

  const blockPattern =
    /\[WORK_LAYER_CONTEXT(?:\s+link_to_memory=(true|false))?\]\s*([\s\S]*?)\s*\[\/WORK_LAYER_CONTEXT\]/g;

  const bounded = conversation.replace(blockPattern, (_full, flag: string | undefined, body: string) => {
    const shouldLink = typeof flag === "string" && flag.toLowerCase() === "true";
    return shouldLink ? body.trim() : "";
  });

  const cleanedLines = bounded
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !/^\[(user|assistant)\]\s*$/.test(line));

  return cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
