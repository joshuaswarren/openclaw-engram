// Stub re-export so tests + downstream consumers can resolve the
// secure-store surface via the conventional `src/` root used elsewhere
// in this monorepo. Mirrors the pattern in `src/cli.ts`,
// `src/access-cli.ts`, etc.
export * from "../../packages/remnic-core/src/secure-store/index.js";
// `export *` does NOT re-export namespace bindings (`export * as
// keyring from ...`). Re-export those explicitly so the test surface
// matches the package surface.
export { keyring } from "../../packages/remnic-core/src/secure-store/index.js";
