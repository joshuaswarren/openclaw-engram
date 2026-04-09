#!/usr/bin/env node
/**
 * remnic-server binary entry point.
 * Delegates to @remnic/server CLI main.
 */
import { cliMain } from "../src/index.js";

cliMain().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
