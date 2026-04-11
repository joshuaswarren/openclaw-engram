/**
 * Canonical plugin id for @remnic/plugin-openclaw.
 *
 * This is the identifier OpenClaw uses as a lookup key in plugins.slots.memory
 * and plugins.entries.<id>. The legacy shim package @joshuaswarren/openclaw-engram
 * intentionally uses a different id ("openclaw-engram") as a backwards-compat alias.
 */
export const PLUGIN_ID = "openclaw-remnic" as const;
export const LEGACY_PLUGIN_ID = "openclaw-engram" as const;
