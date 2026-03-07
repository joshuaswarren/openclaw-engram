export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

export function assertSafePathSegment(value: string, field: string): string {
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`${field} must be a safe path segment`);
  }
  return value;
}

export function assertIsoRecordedAt(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error("recordedAt must be an ISO timestamp");
  }
  return value;
}

export function recordStoreDay(recordedAt: string): string {
  const day = recordedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("recordedAt must start with a valid YYYY-MM-DD date");
  }
  return day;
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);
  const items = value.map((item, index) => assertString(item, `${field}[${index}]`));
  return items.length > 0 ? items : undefined;
}

export function validateStringRecord(raw: unknown, field = "metadata"): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${field} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new Error(`${field} must be an object of strings`);
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
