// ---------------------------------------------------------------------------
// Bulk-import batch processing pipeline
// ---------------------------------------------------------------------------

import {
  validateImportTurn,
  type BulkImportError,
  type BulkImportOptions,
  type BulkImportResult,
  type BulkImportSource,
  type ImportTurn,
} from "./types.js";

const DEFAULT_BATCH_SIZE = 20;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 1000;

export interface ProcessBatchResult {
  memoriesCreated: number;
  duplicatesSkipped: number;
}

export type ProcessBatchFn = (
  turns: ImportTurn[],
) => Promise<ProcessBatchResult>;

function clampBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value as number)) return DEFAULT_BATCH_SIZE;
  const clamped = Math.max(MIN_BATCH_SIZE, Math.floor(value as number));
  return Math.min(clamped, MAX_BATCH_SIZE);
}

/**
 * Format a batch of turns into a conversation transcript string.
 */
export function formatBatchTranscript(turns: ImportTurn[]): string {
  return turns
    .map((t) => {
      const prefix =
        t.participantName ?? t.participantId ?? t.role;
      return `[${t.timestamp}] ${prefix}: ${t.content}`;
    })
    .join("\n");
}

/**
 * Run the bulk-import pipeline over a parsed source.
 *
 * Splits turns into batches and delegates each to `processBatch`.
 * In dryRun mode, validates and counts without calling `processBatch`.
 */
export async function runBulkImportPipeline(
  source: BulkImportSource,
  options: BulkImportOptions = {},
  processBatch: ProcessBatchFn,
): Promise<BulkImportResult> {
  const batchSize = clampBatchSize(options.batchSize);
  const dryRun = options.dryRun === true;

  const result: BulkImportResult = {
    memoriesCreated: 0,
    duplicatesSkipped: 0,
    entitiesCreated: 0,
    turnsProcessed: 0,
    batchesProcessed: 0,
    errors: [],
  };

  const turns = source.turns;

  if (!turns || turns.length === 0) {
    return result;
  }

  // Validate all turns upfront; collect validation errors
  const validTurns: ImportTurn[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const issues = validateImportTurn(turns[i], i);
    if (issues.length > 0) {
      const error: BulkImportError = {
        batchIndex: -1,
        message: issues.map((iss) => iss.message).join("; "),
      };
      result.errors.push(error);
    } else {
      validTurns.push(turns[i]);
    }
  }

  if (dryRun) {
    result.turnsProcessed = validTurns.length;
    result.batchesProcessed =
      validTurns.length > 0
        ? Math.ceil(validTurns.length / batchSize)
        : 0;
    return result;
  }

  // Process in batches
  let batchIndex = 0;
  for (let i = 0; i < validTurns.length; i += batchSize) {
    const batch = validTurns.slice(i, i + batchSize);
    try {
      const batchResult = await processBatch(batch);
      result.memoriesCreated += batchResult.memoriesCreated;
      result.duplicatesSkipped += batchResult.duplicatesSkipped;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      result.errors.push({ batchIndex, message });
    }
    result.turnsProcessed += batch.length;
    result.batchesProcessed += 1;
    batchIndex += 1;
  }

  return result;
}
