/**
 * @engram/adapter-openclaw
 *
 * OpenClaw adapter for Engram memory.
 *
 * This is a thin re-export layer. The full plugin implementation
 * lives in `src/index.ts` at the repo root. This adapter exists so
 * that `@engram/core` can be framework-agnostic while this package
 * carries the OpenClaw SDK dependency.
 *
 * OpenClaw loads this package via `openclaw.plugin.json` → `main` field.
 * Everything exported here is identical to the original `src/index.ts`.
 */

// Re-export the full plugin — no modifications
export * from "../../../src/index.js";
export { default } from "../../../src/index.js";
