#!/usr/bin/env node
/**
 * engram-server binary entry point.
 * Delegates to @engram/server CLI main.
 */
import { cliMain } from "../src/index.js";

cliMain().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
