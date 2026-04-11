/**
 * Pure CLI argument helpers.
 *
 * Extracted from index.ts so tests can import them without triggering the
 * CLI entry's transitive dependency on `@remnic/core/dist/index.js`, which
 * may not be built when running root-level `tsx --test` in CI.
 *
 * No external dependencies — safe to import anywhere.
 */

/**
 * Returns the trailing value after `flag` in `args`, or `undefined` if the
 * flag is absent or appears as the last token (no trailing value).
 */
export function resolveFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/**
 * Returns true if `flag` appears anywhere in `args`, regardless of whether
 * it has a trailing value.
 */
export function hasFlag(args: string[], flag: string): boolean {
  return args.indexOf(flag) !== -1;
}
