/**
 * Shared benchmark result config finalization.
 */

import type { BenchmarkResult, RunBenchmarkOptions } from "./types.js";

export function finalizeBenchmarkResultConfig(
  result: BenchmarkResult,
  options: Pick<RunBenchmarkOptions, "runtimeProfile">,
): BenchmarkResult {
  result.config.runtimeProfile ??= options.runtimeProfile ?? null;
  return result;
}
