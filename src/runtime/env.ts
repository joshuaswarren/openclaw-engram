import os from "node:os";

type EnvMap = Record<string, string | undefined>;

function getEnvMap(): EnvMap | undefined {
  const runtimeProcess = globalThis.process as { env?: EnvMap } | undefined;
  return runtimeProcess?.["env"];
}

export function readEnvVar(name: string): string | undefined {
  const value = getEnvMap()?.[name];
  return typeof value === "string" ? value : undefined;
}

export function resolveHomeDir(): string {
  return readEnvVar("HOME") ?? os.homedir();
}

export function cloneEnv(): NodeJS.ProcessEnv {
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
