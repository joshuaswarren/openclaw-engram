#!/usr/bin/env tsx
/**
 * engram CLI binary entry point.
 */
import { main } from "../src/index.ts";

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
