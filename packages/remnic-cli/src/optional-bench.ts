// Lazy loader for the optional @remnic/bench package.
//
// Remnic's CLI is installed à la carte: users who only need memory features
// should not have to install benchmark tooling, so @remnic/bench is an
// optional peer dependency, not a bundled dependency. Any command that
// actually needs benchmark code calls loadBenchModule() lazily; the loader
// either returns the module or throws a user-facing install hint.
//
// The specifier is computed so the bundler leaves the dynamic import as a
// runtime call (see also core/cli.ts:ensureBuiltInBulkImportAdapters for the
// same pattern). Mirrors CLAUDE.md invariant: "CLI and plugins MUST load
// optional workspace packages via computed-specifier dynamic imports."

type BenchModule = typeof import("@remnic/bench");

let cached: BenchModule | null | undefined;

async function tryImportBench(): Promise<BenchModule | null> {
  try {
    const specifier = "@remnic/" + "bench";
    return (await import(specifier)) as BenchModule;
  } catch {
    return null;
  }
}

/**
 * Load @remnic/bench if installed. Throws a user-facing install hint if the
 * package is not available. Cache the result so repeated calls in the same
 * CLI invocation do not re-import.
 */
export async function loadBenchModule(): Promise<BenchModule> {
  if (cached === undefined) {
    cached = await tryImportBench();
  }
  if (!cached) {
    throw new Error(
      "The `remnic bench` commands require the optional @remnic/bench package.\n" +
        "\n" +
        "Install it alongside the CLI:\n" +
        "  npm install -g @remnic/bench\n" +
        "\n" +
        "Or add it to a project:\n" +
        "  pnpm add @remnic/bench\n",
    );
  }
  return cached;
}

/**
 * Return @remnic/bench if present, or undefined if not installed. Use this
 * for code paths that can degrade gracefully (e.g. `remnic bench list`
 * falling back to the static catalogue when the package is absent).
 */
export async function tryLoadBenchModule(): Promise<BenchModule | undefined> {
  if (cached === undefined) {
    cached = await tryImportBench();
  }
  return cached ?? undefined;
}
