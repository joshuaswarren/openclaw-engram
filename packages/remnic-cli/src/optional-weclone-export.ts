// Lazy loader for the optional @remnic/export-weclone package.
//
// See optional-bench.ts for the full rationale — the CLI is installed à la
// carte, and weclone export tooling is only used by the `training:export`
// surface. Users who don't use that surface should not need the adapter
// installed.

type WecloneExportModule = typeof import("@remnic/export-weclone");

let cached: WecloneExportModule | null | undefined;

function isModuleNotFoundError(err: unknown): boolean {
  // Only swallow the "package isn't installed" codes. Any other import
  // failure (syntax error inside the weclone package, init throw, etc.)
  // must bubble up so broken releases are diagnosable — masking with
  // the install hint would send users chasing the wrong problem.
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

async function tryImportWecloneExport(): Promise<WecloneExportModule | null> {
  try {
    const specifier = "@remnic/" + "export-weclone";
    return (await import(specifier)) as WecloneExportModule;
  } catch (err) {
    if (isModuleNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

export async function loadWecloneExportModule(): Promise<WecloneExportModule> {
  if (cached === undefined) {
    cached = await tryImportWecloneExport();
  }
  if (!cached) {
    throw new Error(
      "The weclone training-export adapter requires the optional @remnic/export-weclone package.\n" +
        "\n" +
        "Install it alongside the CLI:\n" +
        "  npm install -g @remnic/export-weclone\n" +
        "\n" +
        "Or add it to a project:\n" +
        "  pnpm add @remnic/export-weclone\n",
    );
  }
  return cached;
}
