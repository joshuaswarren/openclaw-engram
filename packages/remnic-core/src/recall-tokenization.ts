export function normalizeRecallTokens(value: string, extraStopWords: string[] = []): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "that",
    "this",
    "why",
    "did",
    ...extraStopWords,
  ]);

  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token));
}

export function countRecallTokenOverlap(
  queryTokens: Set<string>,
  value: string | undefined,
  extraStopWords: string[] = [],
): number {
  if (!value) return 0;
  const tokens = new Set(normalizeRecallTokens(value, extraStopWords));
  let matches = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) matches += 1;
  }
  return matches;
}
