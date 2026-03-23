/**
 * Runtime SDK capability detection.
 *
 * Probes the injected api object at registration time to determine which
 * OpenClaw SDK features are available. All hook registrations and entry-point
 * patterns branch on these flags so engram works on both old (≤2026.3.13)
 * and new (≥2026.3.22) runtimes.
 */

export interface SdkCapabilities {
  /** api.on("before_prompt_build", ...) is available */
  hasBeforePromptBuild: boolean;
  /** api.registerMemoryPromptSection() exists */
  hasRegisterMemoryPromptSection: boolean;
  /** definePluginEntry from openclaw/plugin-sdk/plugin-entry is importable */
  hasDefinePluginEntry: boolean;
  /** api.runtime.* namespace exists */
  hasRuntimeNamespace: boolean;
  /** api.registrationMode is present */
  hasRegistrationMode: boolean;
  /** Hooks receive typed event/context objects */
  hasTypedHooks: boolean;
  /** Detected SDK version string, or "legacy" */
  sdkVersion: string;
  /** api.registrationMode value when present */
  registrationMode: "full" | "setup-only" | "setup-runtime" | undefined;
}

export function detectSdkCapabilities(api: Record<string, unknown>): SdkCapabilities {
  const hasRegisterMemoryPromptSection =
    typeof (api as any).registerMemoryPromptSection === "function";
  const hasRuntimeNamespace =
    typeof (api as any).runtime === "object" && (api as any).runtime !== null;
  const hasRegistrationMode = typeof (api as any).registrationMode === "string";

  const sdkVersion: string =
    (hasRuntimeNamespace && typeof (api as any).runtime?.version === "string"
      ? (api as any).runtime.version
      : null) ??
    (typeof process?.env?.OPENCLAW_SERVICE_VERSION === "string"
      ? process.env.OPENCLAW_SERVICE_VERSION
      : null) ??
    "legacy";

  // New SDK is indicated by any of the new API surfaces being present.
  const isNewSdk =
    hasRegisterMemoryPromptSection || hasRuntimeNamespace || hasRegistrationMode;

  // New hook system requires registerMemoryPromptSection or registrationMode.
  // Just having runtime.version is NOT sufficient — some legacy builds expose it.
  const hasNewHookSystem = hasRegisterMemoryPromptSection || hasRegistrationMode;

  return {
    hasBeforePromptBuild: hasNewHookSystem,
    hasRegisterMemoryPromptSection,
    hasDefinePluginEntry: isNewSdk, // entry point is less risky, keep broad detection
    hasRuntimeNamespace,
    hasRegistrationMode,
    hasTypedHooks: hasNewHookSystem,
    sdkVersion,
    registrationMode: hasRegistrationMode
      ? ((api as any).registrationMode as SdkCapabilities["registrationMode"])
      : undefined,
  };
}
