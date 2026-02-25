export type ReplaySource = "openclaw" | "claude" | "chatgpt";
export type ReplayRole = "user" | "assistant";

export interface ReplayTurn {
  source: ReplaySource;
  sessionKey: string;
  role: ReplayRole;
  content: string;
  timestamp: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
}

export interface ReplayWarning {
  code: string;
  message: string;
  index?: number;
}

export interface ReplayValidationIssue {
  code: string;
  message: string;
  index?: number;
}

export interface ReplayParseOptions {
  from?: string;
  to?: string;
  defaultSessionKey?: string;
  strict?: boolean;
}

export interface ReplayParseResult {
  turns: ReplayTurn[];
  warnings: ReplayWarning[];
}

export interface ReplayNormalizer {
  source: ReplaySource;
  parse(input: unknown, options?: ReplayParseOptions): Promise<ReplayParseResult> | ReplayParseResult;
}

const VALID_SOURCES: ReadonlySet<string> = new Set(["openclaw", "claude", "chatgpt"]);
const VALID_ROLES: ReadonlySet<string> = new Set(["user", "assistant"]);
const ISO_UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function normalizeIsoForComparison(value: string): string {
  return value.includes(".") ? value : value.replace("Z", ".000Z");
}

export function isReplaySource(value: unknown): value is ReplaySource {
  return typeof value === "string" && VALID_SOURCES.has(value);
}

export function isReplayRole(value: unknown): value is ReplayRole {
  return typeof value === "string" && VALID_ROLES.has(value);
}

export function parseIsoTimestamp(value: string): number | null {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP_RE.test(value)) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  const roundTrip = new Date(ts).toISOString();
  if (roundTrip !== normalizeIsoForComparison(value)) return null;
  return ts;
}

export function validateReplayTurn(turn: ReplayTurn, index?: number): ReplayValidationIssue[] {
  const issues: ReplayValidationIssue[] = [];
  if (!turn || typeof turn !== "object") {
    issues.push({
      code: "turn.invalid",
      message: "Replay turn must be an object.",
      index,
    });
    return issues;
  }

  if (!isReplayRole(turn.role)) {
    issues.push({
      code: "turn.role.invalid",
      message: `Replay role must be 'user' or 'assistant', received '${String(turn.role)}'.`,
      index,
    });
  }

  if (!isReplaySource(turn.source)) {
    issues.push({
      code: "turn.source.invalid",
      message: `Replay source must be 'openclaw', 'claude', or 'chatgpt', received '${String(turn.source)}'.`,
      index,
    });
  }

  if (!turn.sessionKey || typeof turn.sessionKey !== "string" || turn.sessionKey.trim().length === 0) {
    issues.push({
      code: "turn.sessionKey.invalid",
      message: "Replay sessionKey is required.",
      index,
    });
  }

  if (!turn.content || typeof turn.content !== "string" || turn.content.trim().length === 0) {
    issues.push({
      code: "turn.content.invalid",
      message: "Replay content must be a non-empty string.",
      index,
    });
  }

  if (!turn.timestamp || typeof turn.timestamp !== "string" || parseIsoTimestamp(turn.timestamp) === null) {
    issues.push({
      code: "turn.timestamp.invalid",
      message: `Replay timestamp must be a valid ISO timestamp, received '${String(turn.timestamp)}'.`,
      index,
    });
  }

  return issues;
}
