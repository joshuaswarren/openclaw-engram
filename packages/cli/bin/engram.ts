#!/usr/bin/env node
/**
 * engram CLI binary entry point.
 */
import { main } from "../src/index.js";

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
