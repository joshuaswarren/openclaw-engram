/**
 * Pure helper for parsing connector --config flags.
 *
 * Extracted from index.ts so tests can import it without triggering the
 * CLI entry's transitive dependency on `@remnic/core/dist/index.js`, which
 * may not be built when running root-level `tsx --test` in CI.
 *
 * Accepts two forms:
 *   --config=key=value   (joined)
 *   --config key=value   (split)
 *
 * Values may themselves contain "=", so we split on the first "=" only.
 */
export function parseConnectorConfig(args: string[]): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--config=")) {
      // Joined form: --config=key=value  (value may itself contain "=")
      const rest = arg.slice("--config=".length);
      const eqIdx = rest.indexOf("=");
      if (eqIdx !== -1) {
        const key = rest.slice(0, eqIdx);
        const value = rest.slice(eqIdx + 1);
        if (key) config[key] = value;
      }
    } else if (arg === "--config") {
      // Split form: --config key=value
      const next = args[i + 1];
      if (next !== undefined) {
        const eqIdx = next.indexOf("=");
        if (eqIdx !== -1) {
          const key = next.slice(0, eqIdx);
          const value = next.slice(eqIdx + 1);
          if (key) {
            config[key] = value;
            i++; // consume the next token
          }
        }
      }
    }
  }
  return config;
}

/**
 * Strip the argv tokens that are consumed by `--config` flags from the given
 * args array, returning a new array with those tokens removed.
 *
 * This is used by `cmdConnectors` to compute the connector ID from the
 * remaining positional arguments without accidentally picking up the value
 * token of a split-form `--config key=value`.
 *
 * Examples (tokens removed shown with strikethrough in comments):
 *   ["--config", "installExtension=false", "codex-cli"]
 *     → ["codex-cli"]
 *   ["--config=installExtension=false", "codex-cli"]
 *     → ["codex-cli"]   (joined form: only the one token is removed)
 *   ["--force", "codex-cli"]
 *     → ["--force", "codex-cli"]   (no --config: nothing removed)
 */
export function stripConfigArgv(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--config=")) {
      // Joined form: the flag+value is a single token — skip it.
      continue;
    } else if (arg === "--config") {
      // Split form: peek at the next token. If it looks like key=value, skip
      // both the flag and its value; otherwise skip only the flag (malformed).
      const next = args[i + 1];
      if (next !== undefined && next.includes("=") && !next.startsWith("--")) {
        i++; // skip value token too
      }
      continue;
    }
    result.push(arg);
  }
  return result;
}
