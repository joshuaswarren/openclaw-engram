export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateCodePointSafe(value: string, maxChars: number): string {
  const glyphs = Array.from(value);
  if (maxChars <= 0) return "";
  if (glyphs.length <= maxChars) return value;
  return glyphs.slice(0, Math.max(1, maxChars)).join("").trimEnd();
}
