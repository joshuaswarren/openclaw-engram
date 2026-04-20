import { defineConfig } from "tsup";

// @remnic/bench, @remnic/export-weclone, and @remnic/import-weclone are
// optional à-la-carte install surfaces. They MUST stay external here so the
// CLI does not bundle them into dist/index.js — users who don't need those
// features should not pay for them at install time. See
// packages/remnic-cli/src/optional-bench.ts and optional-weclone-export.ts
// for the computed-specifier dynamic-import loaders the CLI uses to reach
// them at runtime. Adding any of these to noExternal would violate the
// à-la-carte invariant documented in AGENTS.md / CLAUDE.md.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  clean: true,
  external: [
    "yaml",
    "@remnic/bench",
    "@remnic/export-weclone",
    "@remnic/import-weclone",
    "@remnic/import-chatgpt",
    "@remnic/import-mem0",
  ],
});
