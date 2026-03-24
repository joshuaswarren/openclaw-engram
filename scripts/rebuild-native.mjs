#!/usr/bin/env node
/**
 * postinstall: rebuild better-sqlite3 native addon if the binary is missing.
 *
 * When Engram is installed as an OpenClaw plugin (npm install or gateway
 * plugin copy), the pre-built native binary for better-sqlite3 may not
 * match the target platform or may be absent entirely.  This script
 * detects that and runs `npm rebuild better-sqlite3` to compile it.
 *
 * Runs silently on success; logs only on rebuild or error.
 */

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// The path npm/node-gyp produces after a successful build
const nativeAddon = join(
  root,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);

if (existsSync(nativeAddon)) {
  // Already compiled — nothing to do.
  process.exit(0);
}

// Check if better-sqlite3 is even installed (it may be hoisted or absent
// in workspace setups).
const bsqlDir = join(root, "node_modules", "better-sqlite3");
if (!existsSync(bsqlDir)) {
  // Not installed locally — skip (the gateway's top-level node_modules
  // may provide it).
  process.exit(0);
}

console.log("[engram] better-sqlite3 native addon missing — rebuilding...");
try {
  execSync("npm rebuild better-sqlite3", {
    cwd: root,
    stdio: "inherit",
    timeout: 120_000,
  });
  if (existsSync(nativeAddon)) {
    console.log("[engram] better-sqlite3 rebuilt successfully.");
  } else {
    console.warn(
      "[engram] WARNING: npm rebuild completed but native addon still missing.",
    );
    console.warn(
      "[engram] Engram will fall back to non-SQLite storage paths.",
    );
  }
} catch (err) {
  // Don't fail the install — Engram can degrade gracefully without SQLite.
  console.warn("[engram] WARNING: failed to rebuild better-sqlite3:", err.message);
  console.warn("[engram] Engram will fall back to non-SQLite storage paths.");
}
