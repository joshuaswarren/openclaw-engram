import { log } from "./logger.js";

/**
 * Resolve a provider API key, handling the fact that gateway config
 * may contain unresolved secret references instead of plain-text keys.
 *
 * This module does NOT reimplement OpenClaw's secret resolution system.
 * Secret resolution is the gateway's responsibility. This module only
 * distinguishes between:
 *   1. Plain-text API keys → returned as-is
 *   2. Unresolved secret references → returned as undefined (skip provider)
 *
 * When a provider's API key can't be used, FallbackLlmClient skips it
 * and moves to the next provider in the chain. Users who need secret
 * ref resolution should ensure the gateway exposes resolved keys to
 * plugins, or use plain-text keys in their models.json.
 */
export async function resolveProviderApiKey(
  providerId: string,
  apiKeyValue: unknown,
): Promise<string | undefined> {
  // No key configured at all
  if (apiKeyValue === undefined || apiKeyValue === null) {
    return undefined;
  }

  // Object → this is a SecretRef (e.g., {source: "file", provider: "op", id: "..."})
  // Engram cannot resolve these — they require the gateway's internal secret system.
  if (typeof apiKeyValue === "object") {
    log.debug(
      `provider "${providerId}": API key is a SecretRef object — cannot resolve outside gateway core, skipping`,
    );
    return undefined;
  }

  // Not a string — unexpected type
  if (typeof apiKeyValue !== "string") {
    return undefined;
  }

  // Empty string
  if (apiKeyValue.trim().length === 0) {
    return undefined;
  }

  // Known gateway-managed markers that are not usable as API keys
  if (apiKeyValue === "secretref-managed") {
    log.debug(
      `provider "${providerId}": API key is "secretref-managed" — cannot resolve outside gateway core, skipping`,
    );
    return undefined;
  }

  // Anything else is treated as a plain-text API key
  return apiKeyValue;
}

/**
 * Clear the resolution cache. Retained for API compatibility.
 */
export function clearSecretCache(): void {
  // No-op — caching removed in this simplified version
}
