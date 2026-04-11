import { defineConfig } from "tsup";
import { readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

// Build all .ts files in src/ as individual entry points.
// Internal packages import specific modules directly from dist/.
const srcFiles = readdirSync(join(__dirname, "src"))
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
  .map((f) => `src/${f}`);

export default defineConfig({
  entry: srcFiles,
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  external: [
    "openclaw",
    "@lancedb/lancedb",
    "meilisearch",
    "@orama/orama",
    "@orama/plugin-data-persistence",
  ],
  async onSuccess() {
    // Copy the bundled Codex extension payload into dist/ so it is shipped
    // with the @remnic/core npm package. locatePluginCodexExtensionSource()
    // looks for dist/connectors/codex/ at runtime.
    const src = join(__dirname, "src", "connectors", "codex");
    const dest = join(__dirname, "dist", "connectors", "codex");
    mkdirSync(dest, { recursive: true });
    copyFileSync(join(src, "instructions.md"), join(dest, "instructions.md"));
  },
});
