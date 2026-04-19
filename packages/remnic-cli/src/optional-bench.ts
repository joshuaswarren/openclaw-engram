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

function isModuleNotFoundError(err: unknown): boolean {
  // Node's ESM loader uses ERR_MODULE_NOT_FOUND; CJS and some bundlers
  // surface the older MODULE_NOT_FOUND code. Either means "the package
  // isn't installed" — anything else (syntax error, init throw, etc.)
  // is a real bug inside @remnic/bench that we must surface, not mask
  // with an install hint.
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

async function tryImportBench(): Promise<BenchModule | null> {
  try {
    const specifier = "@remnic/" + "bench";
    return (await import(specifier)) as BenchModule;
  } catch (err) {
    if (isModuleNotFoundError(err)) {
      return null;
    }
    throw err;
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
