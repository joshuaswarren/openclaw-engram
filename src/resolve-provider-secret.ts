import { log } from "./logger.js";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Secret reference object format used by OpenClaw's models.json.
 */
interface SecretRef {
  source: "exec" | "file" | "env";
  provider?: string;
  id: string;
  command?: string;
  args?: string[];
}

/**
 * Auth profile entry from agent auth-profiles.json files.
 */
interface AuthProfile {
  type?: string;
  provider?: string;
  token?: string | SecretRef;
  access?: string;
  apiKey?: string;
}

const resolvedCache = new Map<string, string | null>();

/**
 * Resolve a provider API key from various OpenClaw secret formats.
 *
 * Supported formats:
 * - Plain string (not a marker) → used as-is
 * - SecretRef object (`{ source, provider, id }`) → resolved via exec/file/env
 * - `"secretref-managed"` → looked up from auth profiles and openclaw.json auth config
 * - `"minimax-oauth"`, `"ollama-local"`, etc. → treated as non-secret markers, skipped
 *
 * Results are cached per provider to avoid repeated exec calls.
 */
export async function resolveProviderApiKey(
  providerId: string,
  apiKeyValue: unknown,
  gatewayConfig?: { auth?: { profiles?: Record<string, unknown> } },
): Promise<string | undefined> {
  // Fast path: plain string that isn't a marker
  if (typeof apiKeyValue === "string") {
    if (apiKeyValue === "secretref-managed") {
      return resolveSecretRefManaged(providerId, gatewayConfig);
    }
    // Known non-secret markers — skip
    if (
      apiKeyValue.endsWith("-oauth") ||
      apiKeyValue.endsWith("-local") ||
      apiKeyValue === "lm-studio" ||
      apiKeyValue.startsWith("gcp-")
    ) {
      return undefined;
    }
    // Looks like an actual key
    return apiKeyValue;
  }

  // SecretRef object
  if (isSecretRefObject(apiKeyValue)) {
    return resolveSecretRef(providerId, apiKeyValue as SecretRef);
  }

  return undefined;
}

function isSecretRefObject(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    "id" in value &&
    typeof (value as SecretRef).source === "string" &&
    typeof (value as SecretRef).id === "string"
  );
}

async function resolveSecretRef(
  providerId: string,
  ref: SecretRef,
): Promise<string | undefined> {
  const cacheKey = `ref:${ref.source}:${ref.provider ?? ""}:${ref.id}`;
  if (resolvedCache.has(cacheKey)) {
    return resolvedCache.get(cacheKey) ?? undefined;
  }

  let resolved: string | undefined;

  try {
    switch (ref.source) {
      case "exec":
        resolved = resolveExecSecret(ref);
        break;
      case "file":
        resolved = resolveFileSecret(ref);
        break;
      case "env":
        resolved = process.env[ref.id] ?? undefined;
        break;
    }
  } catch (err) {
    log.warn(
      `secret resolution failed for provider "${providerId}" (${ref.source}/${ref.provider}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  resolvedCache.set(cacheKey, resolved ?? null);

  if (resolved) {
    log.debug(`resolved API key for provider "${providerId}" via ${ref.source}/${ref.provider ?? "default"}`);
  }

  return resolved;
}

function resolveExecSecret(ref: SecretRef): string | undefined {
  const command = ref.command ?? (ref.provider === "op" ? "op" : undefined);
  if (!command) {
    log.warn(`exec secret ref has no command and provider "${ref.provider}" is not a known exec provider`);
    return undefined;
  }

  // Use execFileSync (not execSync) to avoid shell injection —
  // arguments are passed as an array, never interpolated into a shell string.
  const args = ref.args ?? (ref.provider === "op" ? ["read", ref.id] : [ref.id]);
  try {
    const result = execFileSync(command, args, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || undefined;
  } catch (err) {
    log.warn(`exec secret resolution failed (${command}): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function resolveFileSecret(ref: SecretRef): string | undefined {
  if (ref.provider === "op") {
    // Try reading from the OpenClaw secrets directory
    const secretsDir = path.join(os.homedir(), ".openclaw", "secrets");
    const filePath = path.join(secretsDir, ref.id.replace(/^\//, ""));
    if (existsSync(filePath)) {
      try {
        return readFileSync(filePath, "utf-8").trim() || undefined;
      } catch {
        // Fall through to op exec
      }
    }

    // Fall back to `op read` via execFileSync (no shell injection)
    try {
      const result = execFileSync("op", ["read", ref.id], {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return result || undefined;
    } catch {
      // Silent — op may not be available
    }
  }

  return undefined;
}

function resolveSecretRefManaged(
  providerId: string,
  gatewayConfig?: { auth?: { profiles?: Record<string, unknown> } },
): string | undefined {
  const cacheKey = `managed:${providerId}`;
  if (resolvedCache.has(cacheKey)) {
    return resolvedCache.get(cacheKey) ?? undefined;
  }

  let resolved: string | undefined;

  // Look up auth profiles for this provider
  const profiles = gatewayConfig?.auth?.profiles;
  if (profiles) {
    // Try provider:default, provider:manual, etc.
    const candidates = [
      `${providerId}:default`,
      `${providerId}:manual`,
      providerId,
    ];

    for (const profileKey of candidates) {
      const raw = profiles[profileKey];
      if (!raw || typeof raw !== "object") continue;
      const profile = raw as AuthProfile;

      // Token-based auth
      if (profile.token) {
        if (typeof profile.token === "string" && !profile.token.startsWith("{")) {
          resolved = profile.token;
          break;
        }
        if (isSecretRefObject(profile.token)) {
          // Synchronously resolve — this is at init time
          try {
            resolved = resolveSecretRefSync(providerId, profile.token as SecretRef);
          } catch {
            // Continue to next profile
          }
          if (resolved) break;
        }
      }

      // API key auth
      if (profile.apiKey && typeof profile.apiKey === "string") {
        resolved = profile.apiKey;
        break;
      }

      // Access token (OAuth)
      if (profile.access && typeof profile.access === "string") {
        resolved = profile.access;
        break;
      }
    }
  }

  // Fall back to environment variables
  if (!resolved) {
    const envCandidates = [
      `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`,
      `${providerId.toUpperCase().replace(/-/g, "_")}_TOKEN`,
    ];
    for (const envVar of envCandidates) {
      if (process.env[envVar]) {
        resolved = process.env[envVar];
        break;
      }
    }
  }

  resolvedCache.set(cacheKey, resolved ?? null);

  if (resolved) {
    log.debug(`resolved managed API key for provider "${providerId}" via auth profile`);
  } else {
    log.debug(`could not resolve managed API key for provider "${providerId}"`);
  }

  return resolved;
}

function resolveSecretRefSync(
  providerId: string,
  ref: SecretRef,
): string | undefined {
  const cacheKey = `ref:${ref.source}:${ref.provider ?? ""}:${ref.id}`;
  if (resolvedCache.has(cacheKey)) {
    return resolvedCache.get(cacheKey) ?? undefined;
  }

  let resolved: string | undefined;

  try {
    switch (ref.source) {
      case "exec":
        resolved = resolveExecSecret(ref);
        break;
      case "file":
        resolved = resolveFileSecret(ref);
        break;
      case "env":
        resolved = process.env[ref.id] ?? undefined;
        break;
    }
  } catch (err) {
    log.warn(
      `sync secret resolution failed for provider "${providerId}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  resolvedCache.set(cacheKey, resolved ?? null);
  return resolved;
}

/**
 * Clear the resolution cache (useful for testing or key rotation).
 */
export function clearSecretCache(): void {
  resolvedCache.clear();
}
