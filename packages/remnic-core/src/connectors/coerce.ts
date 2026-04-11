/**
 * Shared coercion helper for the `installExtension` config field.
 *
 * Extracted from connectors/index.ts so that both config.ts and
 * connectors/index.ts can import it without creating a circular dependency.
 */

/**
 * Coerce the `installExtension` config value from a string (e.g. from CLI
 * `--config installExtension=false`) to a proper boolean.  Accepts the same
 * truthy/falsy strings that common shells and env vars use.
 *
 * Returns `undefined` when the value is neither a boolean nor a recognised
 * string, so callers can fall back to a default.
 */
export function coerceInstallExtension(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["false", "0", "no", "off"].includes(v)) return false;
    if (["true", "1", "yes", "on"].includes(v)) return true;
  }
  return undefined;
}
