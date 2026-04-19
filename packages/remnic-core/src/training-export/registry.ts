/**
 * Training-export adapter registry.
 *
 * Maintains a name → adapter map so CLI and programmatic callers
 * can look up format-specific adapters at runtime.
 */

import type { TrainingExportAdapter } from "./types.js";

const adapters = new Map<string, TrainingExportAdapter>();

/**
 * Register a training-export adapter.
 *
 * Rejects empty names and duplicate registrations with an error
 * listing valid actions (CLAUDE.md rule #51).
 */
export function registerTrainingExportAdapter(adapter: TrainingExportAdapter): void {
  if (!adapter || typeof adapter.name !== "string" || adapter.name.trim().length === 0) {
    throw new Error(
      "registerTrainingExportAdapter: adapter.name must be a non-empty string. " +
        "Provide a unique adapter name (e.g. 'weclone', 'axolotl', 'mlx').",
    );
  }

  const key = adapter.name.trim();

  if (adapters.has(key)) {
    throw new Error(
      `registerTrainingExportAdapter: adapter "${key}" is already registered. ` +
        `Currently registered adapters: [${listTrainingExportAdapters().join(", ")}].`,
    );
  }

  adapters.set(key, adapter);
}

/**
 * Retrieve a registered adapter by name, or `undefined` if not found.
 */
export function getTrainingExportAdapter(name: string): TrainingExportAdapter | undefined {
  return adapters.get(name.trim());
}

/**
 * List the names of all registered adapters.
 */
export function listTrainingExportAdapters(): string[] {
  return [...adapters.keys()];
}

/**
 * Remove all registered adapters.  Intended for test teardown only.
 */
export function clearTrainingExportAdapters(): void {
  adapters.clear();
}
