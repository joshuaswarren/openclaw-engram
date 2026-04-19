// ---------------------------------------------------------------------------
// Bulk-import source adapter registry
// ---------------------------------------------------------------------------

import type { BulkImportSourceAdapter } from "./types.js";

const adapters = new Map<string, BulkImportSourceAdapter>();

/**
 * Register a source adapter. Rejects duplicate names and empty names.
 */
export function registerBulkImportSource(
  adapter: BulkImportSourceAdapter,
): void {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("bulk-import adapter must be an object");
  }
  if (
    !adapter.name ||
    typeof adapter.name !== "string" ||
    adapter.name.trim().length === 0
  ) {
    throw new Error("bulk-import adapter name must be a non-empty string");
  }
  if (typeof adapter.parse !== "function") {
    throw new Error(
      `bulk-import adapter '${adapter.name}' must have a parse function`,
    );
  }
  const key = adapter.name.trim();
  if (adapters.has(key)) {
    throw new Error(
      `bulk-import source adapter '${key}' is already registered`,
    );
  }
  // Store the adapter under the trimmed key so `adapter.name` stays
  // consistent with the registry key returned by `listBulkImportSources()`.
  // When the name already matches the trimmed key, keep the original object
  // as-is. When we need to rewrite `name`, build a proxy whose prototype is
  // the original adapter's prototype so class-based adapters keep their
  // prototype-defined methods (e.g. `parse`) intact — a plain object spread
  // would only copy own enumerable properties and would break those cases.
  let normalized: BulkImportSourceAdapter;
  if (adapter.name === key) {
    normalized = adapter;
  } else {
    const proto = Object.getPrototypeOf(adapter) as object | null;
    const clone = Object.create(proto) as Record<string, unknown>;
    // Copy own (enumerable) properties from the original adapter.
    for (const prop of Object.keys(adapter)) {
      clone[prop] = (adapter as unknown as Record<string, unknown>)[prop];
    }
    clone.name = key;
    normalized = clone as unknown as BulkImportSourceAdapter;
  }
  adapters.set(key, normalized);
}

/**
 * Retrieve a registered adapter by name.
 */
export function getBulkImportSource(
  name: string,
): BulkImportSourceAdapter | undefined {
  return adapters.get(name.trim());
}

/**
 * List all registered adapter names.
 */
export function listBulkImportSources(): string[] {
  return [...adapters.keys()];
}

/**
 * Clear all registered adapters (for testing).
 */
export function clearBulkImportSources(): void {
  adapters.clear();
}
