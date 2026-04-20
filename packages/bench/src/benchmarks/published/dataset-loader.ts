/**
 * Shared dataset loader helpers for the published LongMemEval + LoCoMo
 * benchmark runners. Wraps the fs probe + JSON parse + fallback logic
 * previously duplicated inside each runner's `loadDataset` function.
 *
 * Contract:
 *
 *   - When `datasetDir` is defined, loaders probe the known canonical
 *     filenames in order. The first readable file wins. If none are
 *     readable, the result is `{ source: "missing", errors }`.
 *   - When `datasetDir` is undefined (or resolves to `missing`) and
 *     `mode === "quick"`, loaders return the bundled smoke fixture with
 *     source `"smoke"` so the caller can surface a clear log message.
 *   - When `mode === "full"` and no dataset is found, loaders return
 *     `{ source: "missing", errors }` and callers must throw — full mode
 *     never silently falls back to the smoke fixture.
 *
 * `scripts/bench/fetch-datasets.sh` documents the expected filenames; keep
 * them in sync when adding new variants.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { BenchmarkMode } from "../../types.js";
import {
  LONG_MEM_EVAL_SMOKE_FIXTURE,
  type LongMemEvalItem,
} from "./longmemeval/fixture.js";
import {
  LOCOMO_SMOKE_FIXTURE,
  type LoCoMoConversation,
} from "./locomo/fixture.js";

/** Canonical LongMemEval-S filenames probed by the loader, in priority order. */
export const LONG_MEM_EVAL_DATASET_FILENAMES = Object.freeze([
  "longmemeval_oracle.json",
  "longmemeval_s_cleaned.json",
  "longmemeval_s.json",
  "longmemeval.json",
]);

/** Canonical LoCoMo-10 filenames probed by the loader, in priority order. */
export const LOCOMO_DATASET_FILENAMES = Object.freeze([
  "locomo10.json",
  "locomo.json",
]);

export type DatasetSource = "dataset" | "smoke" | "missing";

export interface LoadedDataset<T> {
  source: DatasetSource;
  /** Filename relative to `datasetDir` when source === "dataset". */
  filename?: string;
  items: T[];
  /** Parse/read errors encountered while probing candidate filenames. */
  errors: string[];
}

export interface LoadDatasetOptions {
  mode: BenchmarkMode;
  datasetDir?: string;
  limit?: number;
}

/** Load LongMemEval-S from disk, falling back to the smoke fixture in quick mode. */
export async function loadLongMemEvalS(
  options: LoadDatasetOptions,
): Promise<LoadedDataset<LongMemEvalItem>> {
  return loadDataset<LongMemEvalItem>({
    ...options,
    filenames: LONG_MEM_EVAL_DATASET_FILENAMES,
    smokeFixture: LONG_MEM_EVAL_SMOKE_FIXTURE,
    parseFile: parseLongMemEvalFile,
  });
}

/**
 * Load LoCoMo-10 from disk, falling back to the smoke fixture in quick mode.
 *
 * `parseFile` is optional — callers that need richer structural
 * normalization (e.g. the LoCoMo runner's QA answer coercion) can pass
 * their own parser. When omitted, a minimal parser is used that only
 * asserts the top-level array + sample_id shape.
 */
export async function loadLoCoMo10(
  options: LoadDatasetOptions & {
    parseFile?: (raw: string, filename: string) => LoCoMoConversation[];
  },
): Promise<LoadedDataset<LoCoMoConversation>> {
  return loadDataset<LoCoMoConversation>({
    ...options,
    filenames: LOCOMO_DATASET_FILENAMES,
    smokeFixture: LOCOMO_SMOKE_FIXTURE,
    parseFile: options.parseFile ?? parseLoCoMoFile,
  });
}

interface InternalLoadOptions<T> extends LoadDatasetOptions {
  filenames: readonly string[];
  smokeFixture: readonly T[];
  parseFile: (raw: string, filename: string) => T[];
}

async function loadDataset<T>(
  options: InternalLoadOptions<T>,
): Promise<LoadedDataset<T>> {
  const limit = normalizeLimit(options.limit);
  const errors: string[] = [];

  if (options.datasetDir) {
    for (const filename of options.filenames) {
      const abs = path.join(options.datasetDir, filename);
      let raw: string;
      try {
        raw = await readFile(abs, "utf8");
      } catch (error) {
        errors.push(
          `${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      try {
        const parsed = options.parseFile(raw, filename);
        return {
          source: "dataset",
          filename,
          items: applyLimit(parsed, limit),
          errors,
        };
      } catch (error) {
        errors.push(
          `${filename}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (options.mode === "full") {
    return { source: "missing", items: [], errors };
  }

  // Quick mode: fall back to the bundled smoke fixture. This keeps CI green
  // when `datasetDir` is absent or unreadable while still surfacing the
  // probe errors so operators can tell why the real dataset wasn't used.
  return {
    source: "smoke",
    items: applyLimit([...options.smokeFixture], limit),
    errors,
  };
}

function parseLongMemEvalFile(raw: string, filename: string): LongMemEvalItem[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${filename} must contain an array of LongMemEval items at top level.`,
    );
  }
  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `${filename} entry ${index} must be an object with question/answer fields.`,
      );
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.question !== "string") {
      throw new Error(
        `${filename} entry ${index} is missing a string question field.`,
      );
    }
    if (typeof record.answer !== "string") {
      throw new Error(
        `${filename} entry ${index} is missing a string answer field.`,
      );
    }
    // Required arrays that the runner dereferences directly. Missing any
    // of these silently would surface as a runtime error deep inside
    // `runLongMemEvalBenchmark`; catch them here so the probe error
    // message points at the dataset file.
    if (!Array.isArray(record.haystack_sessions)) {
      throw new Error(
        `${filename} entry ${index} is missing a haystack_sessions array.`,
      );
    }
    if (!Array.isArray(record.haystack_session_ids)) {
      throw new Error(
        `${filename} entry ${index} is missing a haystack_session_ids array.`,
      );
    }
    if (!Array.isArray(record.haystack_dates)) {
      throw new Error(
        `${filename} entry ${index} is missing a haystack_dates array.`,
      );
    }
    if (!Array.isArray(record.answer_session_ids)) {
      throw new Error(
        `${filename} entry ${index} is missing an answer_session_ids array.`,
      );
    }
  }
  return parsed as LongMemEvalItem[];
}

function parseLoCoMoFile(raw: string, filename: string): LoCoMoConversation[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${filename} must contain an array of LoCoMo conversations at top level.`,
    );
  }
  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `${filename} conversation ${index} must be an object with sample_id and conversation fields.`,
      );
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.sample_id !== "string") {
      throw new Error(
        `${filename} conversation ${index} is missing a string sample_id field.`,
      );
    }
    if (
      !record.conversation ||
      typeof record.conversation !== "object" ||
      Array.isArray(record.conversation)
    ) {
      throw new Error(
        `${filename} conversation ${index} is missing a conversation object field.`,
      );
    }
    if (!Array.isArray(record.qa)) {
      throw new Error(
        `${filename} conversation ${index} is missing a qa array.`,
      );
    }
  }
  return parsed as LoCoMoConversation[];
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      "Dataset limit must be a non-negative integer when provided.",
    );
  }
  // CLAUDE.md rule 27: slice(-0) returns all items. Treat `0` as "empty".
  return limit;
}

function applyLimit<T>(items: T[], limit: number | undefined): T[] {
  if (limit === undefined) {
    return items;
  }
  if (limit === 0) {
    return [];
  }
  return items.slice(0, limit);
}

/**
 * Build a friendly "dataset missing" error message that links operators to
 * the fetch script. Callers use this when `mode === "full"` and the probe
 * returned `source: "missing"`.
 */
export function formatMissingDatasetError(
  benchmark: "longmemeval" | "locomo",
  datasetDir: string | undefined,
  filenames: readonly string[],
  errors: readonly string[],
): string {
  const label =
    benchmark === "longmemeval" ? "LongMemEval" : "LoCoMo";
  const location = datasetDir ?? "<no dataset directory configured>";
  const tried = filenames.join(", ");
  const suffix = errors.length > 0 ? ` Errors: ${errors.join(" | ")}` : "";
  return (
    `${label} dataset not found under ${location}. ` +
    `Tried ${tried}. ` +
    `Run scripts/bench/fetch-datasets.sh for download instructions.${suffix}`
  );
}
