function normalizedModel(model: string): string {
  return model.trim().toLowerCase();
}

export function usesMaxCompletionTokens(model: string): boolean {
  const normalized = normalizedModel(model);
  if (normalized.startsWith("gpt-5")) return true;
  if (normalized.startsWith("gpt-4o")) return true;
  if (normalized.startsWith("gpt-4.1")) return true;
  return /^o\d/.test(normalized);
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
