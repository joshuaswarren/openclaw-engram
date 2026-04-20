declare module "@remnic/export-weclone" {
  export function ensureWecloneExportAdapterRegistered(): boolean;
  export function synthesizeTrainingPairs(
    records: Array<Record<string, unknown>>,
    options?: { maxPairsPerRecord?: number; styleMarkers?: unknown },
  ): Array<Record<string, unknown>>;
  export function sweepPii(
    records: Array<Record<string, unknown>>,
  ): {
    cleanRecords: Array<Record<string, unknown>>;
    redactedCount: number;
  };
}
