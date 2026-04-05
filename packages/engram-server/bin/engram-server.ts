#!/usr/bin/env node
/**
 * engram-server binary entry point.
 * Delegates to @engram/server CLI main.
 */
import { cliMain } from "../src/index.js";

cliMain().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
