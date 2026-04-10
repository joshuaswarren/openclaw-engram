export function cleanUserMessage(content: string): string {
  let cleaned = content;
  // Remove memory context blocks
  cleaned = cleaned.replace(
    /<supermemory-context[^>]*>[\s\S]*?<\/supermemory-context>\s*/gi,
    "",
  );
  cleaned = cleaned.replace(
    /## Memory Context \((?:Engram|Remnic)\)[\s\S]*?(?=\n## |\n$)/gi,
    "",
  );
  // Remove platform headers
  cleaned = cleaned.replace(/^\[\w+\s+.+?\s+id:\d+\s+[^\]]+\]\s*/, "");
  // Remove trailing message IDs
  cleaned = cleaned.replace(/\s*\[message_id:\s*[^\]]+\]\s*$/, "");
  return cleaned.trim();
}
