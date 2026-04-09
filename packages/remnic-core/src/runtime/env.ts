import os from "node:os";

type EnvMap = Record<string, string | undefined>;
const REMNIC_ENGRAM_PREFIX_PAIRS: Array<[string, string]> = [
  ["REMNIC_", "ENGRAM_"],
  ["ENGRAM_", "REMNIC_"],
];

function getEnvMap(): EnvMap | undefined {
  const runtimeProcess = globalThis.process as { env?: EnvMap } | undefined;
  return runtimeProcess?.["env"];
}

function legacyEnvCandidates(name: string): string[] {
  const candidates = [name];
  for (const [primary, legacy] of REMNIC_ENGRAM_PREFIX_PAIRS) {
    if (name.startsWith(primary)) {
      candidates.push(`${legacy}${name.slice(primary.length)}`);
    }
  }
  return candidates;
}

export function readEnvVar(name: string): string | undefined {
  const env = getEnvMap();
  for (const candidate of legacyEnvCandidates(name)) {
    const value = env?.[candidate];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function resolveHomeDir(): string {
  return readEnvVar("HOME") || os.homedir();
}

function cloneEnv(): NodeJS.ProcessEnv {
  return { ...(getEnvMap() ?? {}) };
}

export function mergeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged = cloneEnv();
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") merged[key] = value;
    else delete merged[key];
  }
  return merged;
}
