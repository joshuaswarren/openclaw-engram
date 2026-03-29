import { log } from "./logger.js";
import path from "node:path";
import os from "node:os";

/**
 * Resolve a provider API key using OpenClaw's own auth resolution system.
 *
 * This module delegates to the gateway's `resolveApiKeyForProvider()` function,
 * which handles all secret reference formats (SecretRef objects, auth profiles,
 * "secretref-managed" markers, environment variables, etc.) using the same
 * codepath the gateway uses for its own agent sessions.
 *
 * For plain-text API keys, a fast path returns them directly without
 * involving the gateway auth system.
 *
 * Results are cached per provider for the gateway process lifetime.
 */

type ResolveApiKeyFn = (params: {
  provider: string;
  cfg?: unknown;
  agentDir?: string;
}) => Promise<{ apiKey?: string; source?: string; mode?: string } | null>;

let _resolveApiKeyForProvider: ResolveApiKeyFn | null = null;
let _resolverLoaded = false;
const resolvedCache = new Map<string, string | undefined>();

/**
 * Lazily load the gateway's resolveApiKeyForProvider function.
 * Returns null if not available (e.g., running outside the gateway process).
 */
async function getGatewayResolver(): Promise<ResolveApiKeyFn | null> {
  if (_resolverLoaded) {
    return _resolveApiKeyForProvider;
  }

  try {
    // The gateway bundles this in a runtime chunk — import it dynamically.
    // This import path is stable across gateway versions since it's a named runtime export.
    const candidates = [
      // Try glob-matching the runtime module name (hash varies per build)
      ...await findRuntimeModules(),
    ];

    for (const candidate of candidates) {
      try {
        const mod = await import(candidate);
        if (typeof mod.resolveApiKeyForProvider === "function") {
          _resolveApiKeyForProvider = mod.resolveApiKeyForProvider;
          _resolverLoaded = true;
          log.debug("loaded gateway resolveApiKeyForProvider from runtime module");
          return _resolveApiKeyForProvider;
        }
      } catch {
        // Try next candidate
      }
    }
  } catch {
    // Silent
  }

  _resolverLoaded = true;
  log.debug("gateway resolveApiKeyForProvider not available — falling back to plain-text only");
  return null;
}

/**
 * Find the gateway's model-auth runtime module by scanning the dist directory.
 */
async function findRuntimeModules(): Promise<string[]> {
  const { readdirSync } = await import("node:fs");
  const candidates: string[] = [];

  // The gateway is installed globally via npm/homebrew
  const distDirs = [
    "/opt/homebrew/lib/node_modules/openclaw/dist",
    path.join(os.homedir(), ".openclaw", "node_modules", "openclaw", "dist"),
    path.join(os.homedir(), "node_modules", "openclaw", "dist"),
  ];

  for (const dir of distDirs) {
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        if (f.startsWith("runtime-model-auth.runtime-") && f.endsWith(".js")) {
          candidates.push(path.join(dir, f));
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return candidates;
}

/**
 * Resolve a provider API key from various OpenClaw formats.
 *
 * Resolution order:
 * 1. Plain-text string → returned immediately
 * 2. Gateway's resolveApiKeyForProvider → handles all secret ref formats
 * 3. Environment variable fallback (PROVIDER_NAME_API_KEY)
 * 4. undefined → provider is skipped in the fallback chain
 */
export async function resolveProviderApiKey(
  providerId: string,
  apiKeyValue: unknown,
  gatewayConfig?: unknown,
): Promise<string | undefined> {
  // Check cache first
  const cacheKey = `provider:${providerId}`;
  if (resolvedCache.has(cacheKey)) {
    return resolvedCache.get(cacheKey);
  }

  let resolved: string | undefined;

  // Fast path: plain-text string that looks like an actual API key
  if (typeof apiKeyValue === "string" && apiKeyValue.trim().length > 0) {
    // Skip known non-API-key markers used by the gateway for auth modes
    // that don't use bearer tokens (OAuth, local endpoints, GCP credentials)
    if (
      apiKeyValue === "secretref-managed" ||
      apiKeyValue.endsWith("-oauth") ||
      apiKeyValue.endsWith("-local") ||
      apiKeyValue === "lm-studio" ||
      apiKeyValue.startsWith("gcp-")
    ) {
      // Fall through to gateway resolver / env var fallback
    } else {
      resolved = apiKeyValue;
      resolvedCache.set(cacheKey, resolved);
      return resolved;
    }
  }

  // The API key is either a SecretRef object, "secretref-managed", or empty.
  // Try the gateway's own auth resolution system first.
  const resolver = await getGatewayResolver();
  if (resolver) {
    try {
      const agentDir = path.join(os.homedir(), ".openclaw", "agents", "main", "agent");
      const auth = await resolver({ provider: providerId, cfg: gatewayConfig, agentDir });
      if (auth?.apiKey) {
        resolved = auth.apiKey;
        log.debug(`resolved API key for provider "${providerId}" via gateway auth (source: ${auth.source ?? "unknown"}, mode: ${auth.mode ?? "unknown"})`);
        resolvedCache.set(cacheKey, resolved);
        return resolved;
      }
    } catch (err) {
      log.debug(
        `gateway auth resolution failed for provider "${providerId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Environment variable fallback
  resolved = resolveFromEnv(providerId);
  if (resolved) {
    log.debug(`resolved API key for provider "${providerId}" from environment variable`);
  } else {
    log.debug(`could not resolve API key for provider "${providerId}" — skipping`);
  }

  // Only cache successful resolutions — failures are retried on next call
  // so providers can recover after transient issues (e.g., 1Password agent restart)
  if (resolved) {
    resolvedCache.set(cacheKey, resolved);
  }
  return resolved;
}

/**
 * Try to resolve an API key from environment variables.
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
 * Clear the resolution cache (useful for testing or key rotation).
 */
export function clearSecretCache(): void {
  resolvedCache.clear();
  _resolveApiKeyForProvider = null;
  _resolverLoaded = false;
}
