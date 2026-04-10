const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i,
  /forget\s+(everything|all|previous|what)/i,
  /new\s+(system\s+)?prompt:/i,
  /\[system\]/i,
  /<\s*system\s*>/i,
  /you\s+are\s+now\s+(?!called|named)/i,
  /disregard\s+(all\s+)?(previous|prior)/i,
  /override\s+(previous\s+)?(instructions?|prompt)/i,
  /act\s+as\s+(?:an?\s+)?(?:AI|assistant|ChatGPT|GPT|Claude|LLM)\s+(?:without|that\s+ignores)/i,
  /do\s+not\s+(?:follow|obey)\s+(?:previous|prior|your)\s+instructions/i,
  /pretend\s+(?:you\s+)?(?:have\s+no|you\s+don.?t\s+have)\s+(restrictions|guidelines|rules)/i,
];

export type SanitizeResult = {
  clean: boolean;
  text: string;
  violations: string[];
};

const REDACTED_PLACEHOLDER = "[content removed: possible prompt injection]";

export function sanitizeMemoryContent(text: string): SanitizeResult {
  const source = typeof text === "string" ? text : "";
  const violations: string[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(source)) {
      violations.push(pattern.source);
    }
  }

  if (violations.length === 0) {
    return { clean: true, text: source, violations: [] };
  }

  return {
    clean: false,
    text: REDACTED_PLACEHOLDER,
    violations,
  };
}

export function isSafeMemoryContent(text: string): boolean {
  return sanitizeMemoryContent(text).clean;
}

