// ---------------------------------------------------------------------------
// Import progress tracker
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportProgress {
  phase: "parsing" | "threading" | "chunking" | "extracting" | "complete";
  totalMessages: number;
  threadsFound: number;
  chunksCreated: number;
  chunksProcessed: number;
  memoriesExtracted: number;
  duplicatesSkipped: number;
  entitiesCreated: number;
  elapsed: number;
}

export type ProgressCallback = (progress: ImportProgress) => void;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function defaultProgress(): ImportProgress {
  return {
    phase: "parsing",
    totalMessages: 0,
    threadsFound: 0,
    chunksCreated: 0,
    chunksProcessed: 0,
    memoriesExtracted: 0,
    duplicatesSkipped: 0,
    entitiesCreated: 0,
    elapsed: 0,
  };
}

/**
 * Create a progress tracker that maintains state and optionally notifies
 * a callback on every update.
 */
export function createProgressTracker(callback?: ProgressCallback): {
  update(partial: Partial<ImportProgress>): void;
  snapshot(): ImportProgress;
} {
  const state: ImportProgress = defaultProgress();
  const startTime = Date.now();

  return {
    update(partial: Partial<ImportProgress>): void {
      Object.assign(state, partial);
      state.elapsed = Date.now() - startTime;
      if (callback) {
        callback({ ...state });
      }
    },

    snapshot(): ImportProgress {
      state.elapsed = Date.now() - startTime;
      return { ...state };
    },
  };
}
