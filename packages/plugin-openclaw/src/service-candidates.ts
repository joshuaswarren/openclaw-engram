export function firstSuccessfulResult<T>(
  candidates: readonly string[],
  attempt: (candidate: string) => T | undefined,
): T | undefined {
  for (const candidate of candidates) {
    try {
      const result = attempt(candidate);
      if (result !== undefined) return result;
    } catch {
      // Try the next candidate before giving up.
    }
  }
  return undefined;
}
