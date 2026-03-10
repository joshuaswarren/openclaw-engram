import { compareVersions, type VersionTriple } from "./version-utils.js";

const FIRST_PUBLISHED_RUNTIME_WITHOUT_AGENT_HEARTBEAT = [2026, 1, 29] as const;
const OPENCLAW_VERSION_PREFIX = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

type ParsedOpenClawVersion = {
  triple: VersionTriple;
  prerelease: boolean;
};

function parseOpenClawVersion(
  value: string | undefined,
): ParsedOpenClawVersion | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(OPENCLAW_VERSION_PREFIX);
  if (!match) return null;
  return {
    triple: [
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10),
      Number.parseInt(match[3], 10),
    ],
    prerelease: typeof match[4] === "string" && match[4].length > 0,
  };
}

export function parseOpenClawVersionTriple(
  value: string | undefined,
): VersionTriple | null {
  return parseOpenClawVersion(value)?.triple ?? null;
}

export function shouldRegisterTypedAgentHeartbeat(
  runtimeVersion: string | undefined,
): boolean {
  const parsed = parseOpenClawVersion(runtimeVersion);
  if (!parsed) return false;
  const comparison = compareVersions(
    parsed.triple,
    FIRST_PUBLISHED_RUNTIME_WITHOUT_AGENT_HEARTBEAT,
  );
  if (comparison < 0) return true;
  if (comparison > 0) return false;
  return parsed.prerelease;
}
