// Lazy loader for the optional @remnic/export-weclone package.
//
// See optional-bench.ts for the full rationale — the CLI is installed à la
// carte, and weclone export tooling is only used by the `training:export`
// surface. Users who don't use that surface should not need the adapter
// installed.

type WecloneExportModule = typeof import("@remnic/export-weclone");

let cached: WecloneExportModule | null | undefined;

async function tryImportWecloneExport(): Promise<WecloneExportModule | null> {
  try {
    const specifier = "@remnic/" + "export-weclone";
    return (await import(specifier)) as WecloneExportModule;
  } catch {
    return null;
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
