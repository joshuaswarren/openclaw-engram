/**
 * Canonical plugin id for @remnic/plugin-openclaw.
 *
 * This is the identifier OpenClaw uses as a lookup key in plugins.slots.memory
 * and plugins.entries.<id>. The legacy shim package @joshuaswarren/openclaw-engram
 * intentionally uses a different id ("openclaw-engram") as a backwards-compat alias.
 */
export const PLUGIN_ID = "openclaw-remnic" as const;
export const LEGACY_PLUGIN_ID = "openclaw-engram" as const;

/** The set of plugin ids that belong to Remnic (new canonical + legacy). */
const REMNIC_PLUGIN_IDS: ReadonlySet<string> = new Set([PLUGIN_ID, LEGACY_PLUGIN_ID]);

/**
 * Resolve the Remnic plugin entry from an OpenClaw-shaped config object.
 *
 * Lookup order:
 *   1. `plugins.slots.memory` — but **only** when it resolves to a known
 *      Remnic plugin id; foreign slots are ignored so mixed-plugin installs
 *      do not accidentally apply another plugin's config to Remnic.
 *   2. `preferredId` — the caller's own plugin id (e.g. `"openclaw-engram"` for
 *      the shim package); only consulted when no active slot overrides the choice.
 *   3. `plugins.entries["openclaw-remnic"]`
 *   4. `plugins.entries["openclaw-engram"]` (legacy backward-compat)
 *
 * Returns `undefined` when no Remnic entry is found.
 *
 * All five config-loader sites (loadPluginEntryFromFile, readPluginHooksPolicy,
 * loadPluginConfig in access-cli.ts, loadCliPluginConfig in operator-toolkit.ts,
 * and unwrapOpenClawEntry in materialize.cjs) delegate here so fallback order
 * and guard logic are defined in exactly one place.
 *
 * @param raw - The raw OpenClaw config object.
 * @param preferredId - The calling plugin's own id.  When present and no
 *   `plugins.slots.memory` slot is set, this id is tried before the hardcoded
 *   `PLUGIN_ID`/`LEGACY_PLUGIN_ID` fallbacks.  Ignored if it is not a known
 *   Remnic plugin id (safety guard against unexpected values).
 */
export function resolveRemnicPluginEntry(
  raw: unknown,
  preferredId?: string,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const plugins =
    r["plugins"] && typeof r["plugins"] === "object"
      ? (r["plugins"] as Record<string, unknown>)
      : undefined;
  const entries =
    plugins && plugins["entries"] && typeof plugins["entries"] === "object"
      ? (plugins["entries"] as Record<string, unknown>)
      : undefined;
  if (!entries) return undefined;

  const rawSlot =
    plugins && plugins["slots"] && typeof plugins["slots"] === "object"
      ? ((plugins["slots"] as Record<string, unknown>)["memory"] as string | undefined)
      : undefined;
  const activeId =
    typeof rawSlot === "string" && REMNIC_PLUGIN_IDS.has(rawSlot)
      ? rawSlot
      : undefined;

  // When no slot is set, honour the caller's own plugin id so shim installs
  // (id="openclaw-engram") prefer their own entry over the canonical one.
  const ownId =
    !activeId &&
    typeof preferredId === "string" &&
    REMNIC_PLUGIN_IDS.has(preferredId)
      ? preferredId
      : undefined;

  const candidateIds = [activeId, ownId, PLUGIN_ID, LEGACY_PLUGIN_ID].filter(
    (id): id is string => typeof id === "string",
  );

  for (const id of candidateIds) {
    const entry = entries[id];
    if (entry !== undefined) {
      return entry as Record<string, unknown>;
    }
  }
  return undefined;
}
