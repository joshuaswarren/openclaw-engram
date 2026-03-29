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
  // Fall through to env var check below.
  const isUnresolvableRef =
    (typeof apiKeyValue === "object") ||
    (typeof apiKeyValue === "string" && apiKeyValue === "secretref-managed");

  if (isUnresolvableRef) {
    // Try environment variable fallback before giving up.
    // This is a safe, portable mechanism that works regardless of secret provider.
    const envKey = resolveFromEnv(providerId);
    if (envKey) {
      log.debug(`provider "${providerId}": resolved API key from environment variable`);
      return envKey;
    }
    log.debug(
      `provider "${providerId}": API key is an unresolved secret ref and no env var fallback found, skipping`,
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

  // Anything else is treated as a plain-text API key
  return apiKeyValue;
}

/**
 * Try to resolve an API key from environment variables.
 * Checks PROVIDER_NAME_API_KEY and PROVIDER_NAME_TOKEN patterns.
 */
function resolveFromEnv(providerId: string): string | undefined {
  const normalized = providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const candidates = [
    `${normalized}_API_KEY`,
    `${normalized}_TOKEN`,
  ];
  for (const envVar of candidates) {
    const value = process.env[envVar];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Clear the resolution cache. Retained for API compatibility.
 */
export function clearSecretCache(): void {
  // No-op — caching removed in this simplified version
}
