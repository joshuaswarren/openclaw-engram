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
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ImportTurnValidationIssue {
  code: string;
  message: string;
  index?: number;
}

function normalizeIsoForComparison(value: string): string {
  return value.includes(".") ? value : value.replace("Z", ".000Z");
}

/**
 * Validate the date/time components of an ISO timestamp string.
 * Catches overflowed dates like Feb 31 that Date.parse silently normalizes.
 */
function validateDateComponents(isoString: string): boolean {
  const match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return false;
  const [, yStr, mStr, dStr, hStr, minStr, sStr] = match;
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const h = Number(hStr);
  const min = Number(minStr);
  const s = Number(sStr);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  if (h > 23 || min > 59 || s > 59) return false;
  // Validate day for the specific month (using Date(y, m, 0) to get days in month)
  const daysInMonth = new Date(y, m, 0).getDate();
  if (d > daysInMonth) return false;
  return true;
}

/**
 * Validate the timezone offset range if present.
 * Max offset is +/-14:00 per ISO 8601; minute part must be 0-59.
 */
function validateOffset(isoString: string): boolean {
  const offsetMatch = isoString.match(/([+-])(\d{2}):(\d{2})$/);
  if (!offsetMatch) return true; // Z format, no offset to validate
  const oh = Number(offsetMatch[2]);
  const om = Number(offsetMatch[3]);
  if (oh > 14 || om > 59) return false;
  // +14:00 is max; offsets like +14:30 are invalid
  if (oh === 14 && om > 0) return false;
  return true;
}

export function isImportRole(value: unknown): value is ImportSourceRole {
  return typeof value === "string" && VALID_ROLES.has(value);
}

export function parseIsoTimestamp(value: string): number | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value)) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;

  // Validate date/time components to catch overflowed dates (e.g., Feb 31)
  if (!validateDateComponents(value)) return null;

  // Validate offset range if present (e.g., reject +25:00)
  if (!validateOffset(value)) return null;

  // For UTC timestamps (ending in Z), also verify with round-trip
  if (value.endsWith("Z")) {
    const roundTrip = new Date(ts).toISOString();
    if (roundTrip !== normalizeIsoForComparison(value)) return null;
  }
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
