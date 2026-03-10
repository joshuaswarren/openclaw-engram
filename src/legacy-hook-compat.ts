const FIRST_PUBLISHED_RUNTIME_WITHOUT_AGENT_HEARTBEAT = [2026, 1, 29] as const;

type VersionTriple = readonly [number, number, number];

export function parseOpenClawVersionTriple(
  value: string | undefined,
): VersionTriple | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

function compareVersionTriples(a: VersionTriple, b: VersionTriple): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function shouldRegisterTypedAgentHeartbeat(
  runtimeVersion: string | undefined,
): boolean {
  const parsed = parseOpenClawVersionTriple(runtimeVersion);
  if (!parsed) return false;
  return (
    compareVersionTriples(
      parsed,
      FIRST_PUBLISHED_RUNTIME_WITHOUT_AGENT_HEARTBEAT,
    ) < 0
  );
}
