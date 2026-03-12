function normalizedModel(model: string): string {
  return model.trim().toLowerCase();
}

function matchesModelFamily(normalized: string, familyPattern: RegExp): boolean {
  return familyPattern.test(normalized);
}

export function usesMaxCompletionTokens(model: string): boolean {
  const normalized = normalizedModel(model);
  if (matchesModelFamily(normalized, /^gpt-5(?:$|[-.])/)) return true;
  if (matchesModelFamily(normalized, /^gpt-4o(?:$|[-.])/)) return true;
  if (matchesModelFamily(normalized, /^gpt-4\.1(?:$|[-.])/)) return true;
  return matchesModelFamily(normalized, /^o\d+(?:$|[-.])/);
}

export function buildChatCompletionTokenLimit(
  model: string,
  maxTokens: number,
): { max_tokens: number } | { max_completion_tokens: number } {
  const safeMaxTokens = Math.max(0, Math.floor(maxTokens));
  if (usesMaxCompletionTokens(model)) {
    return { max_completion_tokens: safeMaxTokens };
  }
  return { max_tokens: safeMaxTokens };
}
