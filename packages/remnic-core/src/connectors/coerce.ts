/**
 * Shared boolean coercion helpers.
 *
 * Extracted from connectors/index.ts so that both config.ts and
 * connectors/index.ts can import them without creating a circular dependency.
 */

/**
 * Generic boolean coercion: converts string representations of booleans
 * (e.g. from CLI `--config someFlag=false`) to proper boolean values.
 * Accepts the same truthy/falsy strings that common shells and env vars use.
 *
 * Returns `undefined` when the value is neither a boolean nor a recognised
 * string, so callers can fall back to a default.
 *
 * CLAUDE.md gotcha #36: String "false" is truthy in JavaScript.
 * CLAUDE.md gotcha #28: Coerce CLI values to expected types at input boundaries.
 */
export function coerceBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["false", "0", "no", "off"].includes(v)) return false;
    if (["true", "1", "yes", "on"].includes(v)) return true;
  }
  return undefined;
}

/**
 * Coerce the `installExtension` config value from a string (e.g. from CLI
 * `--config installExtension=false`) to a proper boolean.
 *
 * Delegates to the generic `coerceBool` helper. Kept for backward compatibility.
 */
export function coerceInstallExtension(value: unknown): boolean | undefined {
  return coerceBool(value);
}
