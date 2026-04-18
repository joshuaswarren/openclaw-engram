// ---------------------------------------------------------------------------
// Bulk-import pipeline types and validation
// ---------------------------------------------------------------------------

export interface BulkImportSource {
  turns: ImportTurn[];
  metadata: {
    source: string;
    exportDate: string;
    messageCount: number;
    dateRange: { from: string; to: string };
  };
}

export interface ImportTurn {
  role: "user" | "assistant" | "other";
  content: string;
  timestamp: string;
  participantId?: string;
  participantName?: string;
  replyToId?: string;
}

export interface BulkImportOptions {
  batchSize?: number;
  dryRun?: boolean;
  dedup?: boolean;
  trustLevel?: "import";
  namespace?: string;
}

export type ImportSourceRole = ImportTurn["role"];

export interface BulkImportResult {
  memoriesCreated: number;
  duplicatesSkipped: number;
  entitiesCreated: number;
  turnsProcessed: number;
  batchesProcessed: number;
  errors: BulkImportError[];
}

export interface BulkImportError {
  batchIndex: number;
  message: string;
}

export interface BulkImportSourceAdapter {
  name: string;
  parse(
    input: unknown,
    options?: { strict?: boolean },
  ): Promise<BulkImportSource> | BulkImportSource;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "other"]);
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface ImportTurnValidationIssue {
  code: string;
  message: string;
  index?: number;
}

function normalizeIsoForComparison(value: string): string {
  return value.includes(".") ? value : value.replace("Z", ".000Z");
}

export function isImportRole(value: unknown): value is ImportSourceRole {
  return typeof value === "string" && VALID_ROLES.has(value);
}

export function parseIsoTimestamp(value: string): number | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value)) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  const roundTrip = new Date(ts).toISOString();
  if (roundTrip !== normalizeIsoForComparison(value)) return null;
  return ts;
}

export function validateImportTurn(
  turn: ImportTurn,
  index?: number,
): ImportTurnValidationIssue[] {
  const issues: ImportTurnValidationIssue[] = [];

  if (!turn || typeof turn !== "object") {
    issues.push({
      code: "turn.invalid",
      message: "Import turn must be an object.",
      index,
    });
    return issues;
  }

  if (!isImportRole(turn.role)) {
    issues.push({
      code: "turn.role.invalid",
      message:
        `Import turn role must be 'user', 'assistant', or 'other', ` +
        `received '${String(turn.role)}'.`,
      index,
    });
  }

  if (
    !turn.content ||
    typeof turn.content !== "string" ||
    turn.content.trim().length === 0
  ) {
    issues.push({
      code: "turn.content.invalid",
      message: "Import turn content must be a non-empty string.",
      index,
    });
  }

  if (
    !turn.timestamp ||
    typeof turn.timestamp !== "string" ||
    parseIsoTimestamp(turn.timestamp) === null
  ) {
    issues.push({
      code: "turn.timestamp.invalid",
      message:
        `Import turn timestamp must be a valid ISO timestamp, ` +
        `received '${String(turn.timestamp)}'.`,
      index,
    });
  }

  return issues;
}
