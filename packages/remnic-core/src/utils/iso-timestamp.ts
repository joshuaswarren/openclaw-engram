// ---------------------------------------------------------------------------
// Shared ISO-8601 / RFC 3339 timestamp validation helpers.
//
// Two public entry points — a strict UTC-only parser used by the replay
// pipeline, and a more permissive parser used by bulk-import adapters that
// need to preserve source timezone offsets. Both share date-component,
// offset-range, and round-trip validation so they cannot silently diverge.
// ---------------------------------------------------------------------------

// UTC-only: `...Z`, 0 or 3 fractional digits (replay canonical form).
const ISO_UTC_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// Lenient: variable-precision fractional seconds and `Z` or `[+-]HH:MM` offset.
const ISO_OFFSET_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate the date/time components of an ISO timestamp string.
 * Catches overflowed dates like Feb 31 that `Date.parse` silently normalizes.
 */
function validateDateComponents(isoString: string): boolean {
  const match = isoString.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
  );
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
  // Validate day for the specific month (using Date(y, m, 0) to get days).
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
  if (!offsetMatch) return true; // `Z` form, no offset to validate.
  const oh = Number(offsetMatch[2]);
  const om = Number(offsetMatch[3]);
  if (oh > 14 || om > 59) return false;
  // +14:00 is max; offsets like +14:30 are invalid.
  if (oh === 14 && om > 0) return false;
  return true;
}

/**
 * Normalize a `Z`-suffixed ISO timestamp to exactly three fractional digits so
 * the round-trip comparison against `Date.prototype.toISOString()` succeeds
 * regardless of input precision (or absence of a fractional part).
 */
function normalizeUtcForComparison(value: string): string {
  const fracMatch = value.match(/\.(\d+)Z$/);
  if (fracMatch) {
    const ms = (fracMatch[1] + "000").slice(0, 3);
    return value.replace(/\.\d+Z$/, `.${ms}Z`);
  }
  return value.replace(/Z$/, ".000Z");
}

/**
 * Strict UTC-only parser — accepts `YYYY-MM-DDTHH:MM:SS[.sss]Z`.
 * Returns milliseconds since epoch, or `null` if invalid.
 */
export function parseIsoUtcTimestamp(value: string): number | null {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP_RE.test(value)) {
    return null;
  }
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  if (!validateDateComponents(value)) return null;
  const roundTrip = new Date(ts).toISOString();
  if (roundTrip !== normalizeUtcForComparison(value)) return null;
  return ts;
}

/**
 * Lenient parser — accepts variable-precision fractional seconds and either
 * a `Z` suffix or a `[+-]HH:MM` offset. Returns milliseconds since epoch, or
 * `null` if the string is not a well-formed RFC 3339 timestamp.
 */
export function parseIsoOffsetTimestamp(value: string): number | null {
  if (typeof value !== "string" || !ISO_OFFSET_TIMESTAMP_RE.test(value)) {
    return null;
  }
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  if (!validateDateComponents(value)) return null;
  if (!validateOffset(value)) return null;
  // For UTC timestamps (ending in `Z`), verify with a round-trip so that
  // overflowed UTC calendar dates cannot slip through.
  if (value.endsWith("Z")) {
    const roundTrip = new Date(ts).toISOString();
    if (roundTrip !== normalizeUtcForComparison(value)) return null;
  }
  return ts;
}
