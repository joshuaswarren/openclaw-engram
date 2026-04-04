#!/usr/bin/env node
/**
 * engram CLI binary entry point.
 *
 * CJS wrapper that locates tsx (from node_modules or PATH) and runs the
 * TypeScript CLI source.  Uses .cjs extension so Node always treats it as
 * CommonJS regardless of the nearest package.json "type" field.
 *
 * main() is auto-invoked by src/index.ts when it detects this wrapper
 * via the ENGRAM_CLI_BIN environment variable.
 */
const { resolve } = require("node:path");
const { existsSync } = require("node:fs");
const { execFileSync } = require("node:child_process");

const cwd = __dirname;

// Resolve tsx: check package-local, then workspace-hoisted root, then global PATH
const candidates = [
  resolve(cwd, "../node_modules/.bin/tsx"),        // package-local
  resolve(cwd, "../../../node_modules/.bin/tsx"),   // workspace root (hoisted)
];
const tsxCmd = candidates.find((c) => existsSync(c)) || "tsx";

try {
  execFileSync(
    tsxCmd,
    [resolve(cwd, "../src/index.ts"), ...process.argv.slice(2)],
    {
      stdio: "inherit",
      env: { ...process.env, ENGRAM_CLI_BIN: "1", FORCE_COLOR: "1" },
    },
  );
} catch (err) {
  // execFileSync throws on non-zero exit — propagate the child's exit code
  process.exitCode = err.status ?? 1;
}
