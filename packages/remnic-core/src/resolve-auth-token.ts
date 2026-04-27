import { log } from "./logger.js";
import { findGatewayRuntimeModules } from "./resolve-provider-secret.js";
import type { AgentAccessAuthToken, SecretRef } from "./types.js";

/**
 * Resolve `agentAccessHttp.authToken` (issue #757).
 *
 * Two shapes are accepted:
 *
 *   1. Plain string — returned unchanged. This is the only shape supported
 *      in standalone Remnic; it preserves backward compatibility with every
 *      pre-#757 config.
 *
 *   2. OpenClaw SecretRef object (`{source, provider?, id?, command?, ...}`)
 *      — resolved by delegating to the gateway's own secret resolver, the
 *      same codepath that handles `gateway.auth.token`,
 *      `channels.telegram.accounts[*].botToken`, and `secrets.providers.*`.
 *      We never re-implement exec/file/env resolution ourselves; that's the
 *      lesson from PR #318 (the prior attempt to reinvent SecretRef
 *      resolution shipped a 1Password-specific path that broke for everyone
 *      else and had to be reverted).
 *
 * Resolution flow for SecretRef objects:
 *
 *   - Discover `runtime-secret*` and `runtime-model-auth*` modules in the
 *     OpenClaw `dist/` directory using the same install-method-agnostic
 *     discovery as `resolve-provider-secret.ts`.
 *   - Probe each module for one of the known SecretRef resolver export
 *     names. The first match wins.
 *   - If no resolver is found (e.g. running in standalone Remnic with no
 *     OpenClaw runtime present), throw a clear, actionable error rather
 *     than silently leaving the bridge open or starting with no auth.
 *
 * Lessons baked in from PRs #316–#319:
 *
 *   - Plain strings short-circuit before any filesystem scan.
 *   - The discovery scan caches its negative result with a backoff so
 *     standalone Remnic doesn't readdir the filesystem on every restart.
 *   - Successful resolutions are cached for the process lifetime; failures
 *     are not cached so transient issues (Keychain unlocked late, agent
 *     restarts) recover automatically.
 */

type ResolveSecretRefFn = (
  ref: SecretRef,
  context?: unknown,
) => Promise<string | undefined> | string | undefined;

const RESOLVER_RETRY_BACKOFF_MS = 60_000;

/** Export names probed on each runtime module, in order of preference. */
const RESOLVER_EXPORT_NAMES = [
  "resolveSecretRef",
  "resolveSecret",
  "loadSecretRef",
  "readSecretRef",
] as const;

/** Filename prefixes scanned in the gateway dist/ directory. */
const RESOLVER_MODULE_PREFIXES = [
  "runtime-secret-resolver.runtime-",
  "runtime-secrets.runtime-",
  "runtime-secret.runtime-",
  "runtime-model-auth.runtime-",
] as const;

let _resolveSecretRef: ResolveSecretRefFn | null = null;
let _resolverLoaded = false;
let _resolverNextRetryAt = 0;
const resolvedCache = new Map<string, string>();

/**
 * SecretRef objects are stable per (source, provider, id, command) tuple.
 * Sort keys before serializing so semantically-identical refs hit the same
 * cache slot regardless of authoring order (Lesson 38 in CLAUDE.md).
 */
function cacheKeyForSecretRef(ref: SecretRef): string {
  const sortedKeys = Object.keys(ref).sort();
  const stable: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    stable[key] = ref[key];
  }
  return JSON.stringify(stable);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadGatewaySecretRefResolver(): Promise<ResolveSecretRefFn | null> {
  if (_resolverLoaded) return _resolveSecretRef;
  if (_resolverNextRetryAt > 0 && Date.now() < _resolverNextRetryAt) return null;

  try {
    const { pathToFileURL } = await import("node:url");
    for (const prefix of RESOLVER_MODULE_PREFIXES) {
      const candidates = await findGatewayRuntimeModules(prefix);
      for (const candidate of candidates) {
        try {
          const importUrl = pathToFileURL(candidate).href;
          const mod = (await import(importUrl)) as Record<string, unknown>;
          for (const exportName of RESOLVER_EXPORT_NAMES) {
            const fn = mod[exportName];
            if (typeof fn === "function") {
              _resolveSecretRef = fn as ResolveSecretRefFn;
              _resolverLoaded = true;
              log.debug(
                `loaded gateway SecretRef resolver "${exportName}" from ${prefix}*.js`,
              );
              return _resolveSecretRef;
            }
          }
        } catch {
          // Try next candidate
        }
      }
    }
  } catch {
    // Silent — fall through to backoff
  }

  _resolverNextRetryAt = Date.now() + RESOLVER_RETRY_BACKOFF_MS;
  log.debug(
    `gateway SecretRef resolver not available — will retry after ${
      RESOLVER_RETRY_BACKOFF_MS / 1000
    }s`,
  );
  return null;
}

/**
 * Resolve an `agentAccessHttp.authToken` value to a literal bearer string.
 *
 * @returns the resolved string, or `undefined` if input was undefined/empty.
 * @throws if the input is a SecretRef and the gateway resolver is not
 *         available, or if the resolver returns no value, or if the input
 *         shape is malformed.
 */
export async function resolveAgentAccessAuthToken(
  value: AgentAccessAuthToken | undefined,
): Promise<string | undefined> {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!isPlainObject(value)) {
    throw new Error(
      "unsupported SecretRef shape for agentAccessHttp.authToken — " +
        "expected a string or an object with a `source` field " +
        "(see https://github.com/joshuaswarren/remnic/issues/757)",
    );
  }

  const ref = value as SecretRef;
  if (typeof ref.source !== "string" || ref.source.length === 0) {
    throw new Error(
      "unsupported SecretRef shape for agentAccessHttp.authToken — " +
        "missing required `source` field " +
        "(see https://github.com/joshuaswarren/remnic/issues/757)",
    );
  }

  const cacheKey = cacheKeyForSecretRef(ref);
  const cached = resolvedCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const resolver = await loadGatewaySecretRefResolver();
  if (!resolver) {
    throw new Error(
      `cannot resolve agentAccessHttp.authToken SecretRef (source="${ref.source}") — ` +
        "OpenClaw gateway secret resolver is not available. " +
        "If you are running standalone Remnic, use a literal string or " +
        "${ENV_VAR} expansion instead. " +
        "If you are running under OpenClaw, ensure the gateway version " +
        "exposes a SecretRef resolver runtime module " +
        "(see https://github.com/joshuaswarren/remnic/issues/757).",
    );
  }

  let resolved: string | undefined;
  try {
    const out = await resolver(ref);
    if (typeof out === "string" && out.length > 0) {
      resolved = out;
    }
  } catch (err) {
    throw new Error(
      `failed to resolve agentAccessHttp.authToken SecretRef (source="${ref.source}"): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!resolved) {
    throw new Error(
      `agentAccessHttp.authToken SecretRef resolved to empty value (source="${ref.source}", provider="${
        ref.provider ?? ""
      }") — refusing to start the HTTP bridge with an empty bearer token.`,
    );
  }

  resolvedCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Returns true if the value is a SecretRef object (issue #757). Useful for
 * surfaces (CLI flags, doctor checks) that want to render a redacted
 * placeholder instead of leaking the unresolved object shape.
 */
export function isAgentAccessSecretRef(value: unknown): value is SecretRef {
  if (!isPlainObject(value)) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.source === "string" && ref.source.length > 0;
}

/** Test-only hook: inject a synthetic resolver. */
export function __setSecretRefResolverForTest(resolver: ResolveSecretRefFn | null): void {
  _resolveSecretRef = resolver;
  _resolverLoaded = resolver !== null;
  _resolverNextRetryAt = 0;
}

/** Test/operations hook: drop the cache and force resolver rediscovery. */
export function clearAuthTokenSecretCache(): void {
  resolvedCache.clear();
  _resolveSecretRef = null;
  _resolverLoaded = false;
  _resolverNextRetryAt = 0;
}
