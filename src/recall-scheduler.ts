export type RecallSectionPriority = "core" | "enrichment";
export type RecallSectionSource = "fresh" | "stale" | "skip";
export type RecallSectionCompletion = "completed" | "timed_out" | "failed" | "aborted";

export interface RecallSectionSpec<T> {
  id: string;
  priority: RecallSectionPriority;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
  fallback?: (reason: Exclude<RecallSectionCompletion, "completed">) => T | null | undefined | Promise<T | null | undefined>;
}

export interface RecallSectionResult<T> {
  id: string;
  priority: RecallSectionPriority;
  value: T | null;
  source: RecallSectionSource;
  completion: RecallSectionCompletion;
  durationMs: number;
}

export async function runRecallSections<T>(
  specs: RecallSectionSpec<T>[],
  abortSignal?: AbortSignal,
): Promise<RecallSectionResult<T>[]> {
  const results: RecallSectionResult<T>[] = [];
  const ordered = [...specs].sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));

  for (const spec of ordered) {
    if (abortSignal?.aborted) {
      results.push({
        id: spec.id,
        priority: spec.priority,
        value: null,
        source: "skip",
        completion: "aborted",
        durationMs: 0,
      });
      continue;
    }

    results.push(await runRecallSection(spec, abortSignal));
  }

  return results;
}

async function runRecallSection<T>(
  spec: RecallSectionSpec<T>,
  outerSignal?: AbortSignal,
): Promise<RecallSectionResult<T>> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const cleanup = forwardAbort(outerSignal, controller);
  const timeout = setTimeout(() => controller.abort(createAbortReason("timed_out")), spec.timeoutMs);

  try {
    const value = await spec.run(controller.signal);
    return {
      id: spec.id,
      priority: spec.priority,
      value,
      source: "fresh",
      completion: "completed",
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const completion = classifyCompletion(error, outerSignal, controller.signal);
    const fallback = await spec.fallback?.(completion);

    return {
      id: spec.id,
      priority: spec.priority,
      value: fallback ?? null,
      source: fallback == null ? "skip" : "stale",
      completion,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
    cleanup();
  }
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }

  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function classifyCompletion(
  error: unknown,
  outerSignal: AbortSignal | undefined,
  signal: AbortSignal,
): Exclude<RecallSectionCompletion, "completed"> {
  if (outerSignal?.aborted) return "aborted";
  if (signal.aborted && isTimeoutAbort(error, signal.reason)) return "timed_out";
  if (signal.aborted) return "aborted";
  return "failed";
}

function isTimeoutAbort(error: unknown, reason: unknown): boolean {
  if (reason && typeof reason === "object" && (reason as { code?: string }).code === "timed_out") {
    return true;
  }
  if (error && typeof error === "object" && (error as { code?: string }).code === "timed_out") {
    return true;
  }
  return false;
}

function createAbortReason(code: "timed_out") {
  return { code };
}

function priorityRank(priority: RecallSectionPriority): number {
  return priority === "core" ? 0 : 1;
}
