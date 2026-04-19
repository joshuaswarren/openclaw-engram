/**
 * Seed-sequence generation for benchmark runs.
 *
 * Factored out of `benchmark.ts` so individual runners can reuse it without
 * triggering a circular import through `benchmark.ts -> registry.ts ->
 * runner.ts -> benchmark.ts`.
 */

export function buildBenchmarkRunSeeds(
  runCount: number,
  baseSeed?: number,
): number[] {
  if (!Number.isInteger(runCount) || runCount <= 0) {
    throw new Error("benchmark run count must be a positive integer");
  }

  const firstSeed = baseSeed ?? 0;
  if (!Number.isInteger(firstSeed) || firstSeed < 0) {
    throw new Error("benchmark seed must be a non-negative integer");
  }

  return Array.from({ length: runCount }, (_, index) => firstSeed + index);
}
