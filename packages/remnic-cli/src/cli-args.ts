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

/**
 * Set of flags for `taxonomy resolve` that are boolean (no trailing value).
 * Key-value flags (like `--category`) consume the next token as their value.
 */
export const TAXONOMY_RESOLVE_BOOLEAN_FLAGS = new Set(["--json"]);

/**
 * Strip CLI flags from `taxonomy resolve` argument tokens, returning only
 * the text parts. Boolean flags (e.g. `--json`) skip only the flag itself;
 * key-value flags (e.g. `--category preference`) skip the flag and its
 * following value token.
 */
export function stripResolveFlags(
  args: string[],
  booleanFlags: ReadonlySet<string> = TAXONOMY_RESOLVE_BOOLEAN_FLAGS,
): string[] {
  const textParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // Boolean flags have no trailing value — skip only the flag itself
      if (!booleanFlags.has(args[i])) {
        // Key-value flag: skip the flag and its value (next token)
        i++;
      }
      continue;
    }
    textParts.push(args[i]);
  }
  return textParts;
}
