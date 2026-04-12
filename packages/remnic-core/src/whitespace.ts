export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
