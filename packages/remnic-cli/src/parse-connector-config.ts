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
