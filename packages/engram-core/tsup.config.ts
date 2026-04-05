import { defineConfig } from "tsup";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Build all .ts files in src/ as individual entry points so consumers
// can import specific modules: @engram/core/orchestrator, @engram/core/types, etc.
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
});
