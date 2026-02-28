export type RecallPromptShape = "standard" | "instruction_heavy";
export type CronConversationRecallMode = "auto" | "always" | "never";
export type RecallBudgetMode = "full" | "minimal";

export interface RecallQueryPolicyConfig {
  cronRecallPolicyEnabled: boolean;
  cronRecallNormalizedQueryMaxChars: number;
  cronRecallInstructionHeavyTokenCap: number;
  cronConversationRecallMode: CronConversationRecallMode;
}

export interface RecallQueryPolicyResult {
  promptShape: RecallPromptShape;
  retrievalQuery: string;
  skipConversationRecall: boolean;
  retrievalBudgetMode: RecallBudgetMode;
}

const DEFAULT_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "you",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "not",
  "but",
  "its",
  "into",
  "only",
  "use",
  "run",
  "then",
  "when",
  "what",
  "where",
  "which",
  "will",
  "would",
  "should",
  "could",
  "goal",
  "output",
  "format",
  "rules",
  "section",
  "sections",
  "skip",
  "today",
  "yesterday",
  "return",
  "summary",
  "plain",
  "text",
  "before",
  "after",
  "time",
  "date",
  "daily",
  "cron",
  "agent",
  "mode",
  "data",
  "gathering",
  "context",
]);

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripFilesystemLikePaths(text: string): string {
  return text
    .replace(/(?:^|\s)(~\/[^\s)]+)(?=\s|$)/g, " ")
    .replace(/(?:^|\s)(\/[A-Za-z0-9._\-\/]+)(?=\s|$)/g, " ")
    .replace(/(?:^|\s)([A-Za-z]:\\[^\s)]+)(?=\s|$)/g, " ");
}

function isBulletOrNumberedLine(line: string): boolean {
  if (line.startsWith("-") || line.startsWith("*")) {
    return true;
  }

  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code < 48 || code > 57) {
      break;
    }
    i += 1;
  }
  return i > 0 && i < line.length && line.charAt(i) === ".";
}

function scoreInstructionHeavyShape(prompt: string): number {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lineCount = lines.length;
  if (lineCount === 0) return 0;

  const headingLineCount = lines.filter(
    (line) =>
      /^(goal|output format|tone rules|grounding rules|data gathering|date computation|crm context|follow-up|social|current time|return)\b/i.test(
        line,
      ) || /^[A-Z][A-Z\s/-]{4,}:$/.test(line),
  ).length;
  const bulletLineCount = lines.filter((line) => isBulletOrNumberedLine(line)).length;
  const longLineCount = lines.filter((line) => line.length >= 180).length;
  const hasPathDensity =
    (prompt.match(/(?:~\/|\/Users\/|[A-Za-z]:\\)/g)?.length ?? 0) >= 2;
  const hasImperativeDensity =
    (prompt.match(/\b(run|extract|read|parse|determine|include|omit|skip)\b/gi)?.length ?? 0) >=
    8;

  let score = 0;
  if (lineCount >= 24) score += 2;
  if (headingLineCount >= 4) score += 2;
  if (bulletLineCount >= 8) score += 1;
  if (longLineCount >= 3) score += 1;
  if (hasPathDensity) score += 1;
  if (hasImperativeDensity) score += 1;
  return score;
}

export function classifyRecallPromptShape(prompt: string): RecallPromptShape {
  const score = scoreInstructionHeavyShape(prompt);
  return score >= 5 ? "instruction_heavy" : "standard";
}

function tokenizeForCompactQuery(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9\s:_-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const token of raw) {
    if (DEFAULT_STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    deduped.push(token);
  }
  return deduped;
}

function buildInstructionHeavyQuery(
  prompt: string,
  tokenCap: number,
  maxChars: number,
): string {
  const cleaned = stripFilesystemLikePaths(prompt);
  const tokens = tokenizeForCompactQuery(cleaned).slice(0, Math.max(8, tokenCap));
  const joined = tokens.join(" ");
  const compact = collapseWhitespace(joined);
  if (compact.length <= maxChars) return compact;
  return compact.slice(0, maxChars).trim();
}

export function clampInstructionHeavyTokenCap(value: number): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(8, Math.floor(value));
}

function buildStandardQuery(prompt: string, maxChars: number): string {
  const trimmed = collapseWhitespace(prompt);
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trim();
}

export function buildRecallQueryPolicy(
  prompt: string,
  sessionKey: string | undefined,
  cfg: RecallQueryPolicyConfig,
): RecallQueryPolicyResult {
  const normalizedPrompt = collapseWhitespace(prompt);
  const isCron = (sessionKey ?? "").includes(":cron:");
  if (!cfg.cronRecallPolicyEnabled || !isCron) {
    return {
      promptShape: "standard",
      retrievalQuery: prompt,
      skipConversationRecall: false,
      retrievalBudgetMode: "full",
    };
  }

  const promptShape = classifyRecallPromptShape(prompt);
  const maxChars = Math.max(120, cfg.cronRecallNormalizedQueryMaxChars);
  const tokenCap = clampInstructionHeavyTokenCap(cfg.cronRecallInstructionHeavyTokenCap);
  const retrievalQuery =
    promptShape === "instruction_heavy"
      ? buildInstructionHeavyQuery(prompt, tokenCap, maxChars)
      : buildStandardQuery(prompt, maxChars);

  const skipConversationRecall =
    cfg.cronConversationRecallMode === "never"
      ? true
      : cfg.cronConversationRecallMode === "always"
      ? false
      : promptShape === "instruction_heavy";

  const retrievalBudgetMode = promptShape === "instruction_heavy" ? "minimal" : "full";

  return {
    promptShape,
    retrievalQuery: retrievalQuery.length > 0 ? retrievalQuery : normalizedPrompt.slice(0, maxChars),
    skipConversationRecall,
    retrievalBudgetMode,
  };
}
