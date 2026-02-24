import type {
  ContinuityIncidentCloseInput,
  ContinuityIncidentOpenInput,
  ContinuityIncidentRecord,
  ContinuityIncidentState,
} from "./types.js";

function parseFrontmatterValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    parsed[key] = parseFrontmatterValue(value);
  }
  return parsed;
}

function emitSection(lines: string[], title: string, value?: string): void {
  if (!value || value.trim().length === 0) return;
  lines.push(`## ${title}`, "", value.trim(), "");
}

function parseSection(body: string, title: string): string | undefined {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`## ${escaped}\\n\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = body.match(re);
  if (!match) return undefined;
  const value = match[1].trim();
  return value.length > 0 ? value : undefined;
}

export function serializeContinuityIncident(incident: ContinuityIncidentRecord): string {
  const lines = [
    "---",
    `id: ${JSON.stringify(incident.id)}`,
    `state: ${JSON.stringify(incident.state)}`,
    `openedAt: ${JSON.stringify(incident.openedAt)}`,
    `updatedAt: ${JSON.stringify(incident.updatedAt)}`,
  ];
  if (incident.closedAt) lines.push(`closedAt: ${JSON.stringify(incident.closedAt)}`);
  if (incident.triggerWindow) lines.push(`triggerWindow: ${JSON.stringify(incident.triggerWindow)}`);
  lines.push("---", "");

  emitSection(lines, "Symptom", incident.symptom);
  emitSection(lines, "Suspected Cause", incident.suspectedCause);
  emitSection(lines, "Fix Applied", incident.fixApplied);
  emitSection(lines, "Verification Result", incident.verificationResult);
  emitSection(lines, "Preventive Rule", incident.preventiveRule);

  return lines.join("\n").trimEnd() + "\n";
}

export function parseContinuityIncident(raw: string): ContinuityIncidentRecord | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const frontmatter = parseFrontmatter(match[1]);
  const body = match[2] ?? "";

  const id = typeof frontmatter.id === "string" ? frontmatter.id : "";
  const stateRaw = frontmatter.state;
  const state: ContinuityIncidentState =
    stateRaw === "closed" ? "closed" : stateRaw === "open" ? "open" : "open";
  const openedAt = typeof frontmatter.openedAt === "string" ? frontmatter.openedAt : "";
  const updatedAt = typeof frontmatter.updatedAt === "string" ? frontmatter.updatedAt : openedAt;
  const symptom = parseSection(body, "Symptom");

  if (!id || !openedAt || !updatedAt || !symptom) return null;

  return {
    id,
    state,
    openedAt,
    updatedAt,
    triggerWindow: typeof frontmatter.triggerWindow === "string" ? frontmatter.triggerWindow : undefined,
    symptom,
    suspectedCause: parseSection(body, "Suspected Cause"),
    fixApplied: parseSection(body, "Fix Applied"),
    verificationResult: parseSection(body, "Verification Result"),
    preventiveRule: parseSection(body, "Preventive Rule"),
    closedAt: typeof frontmatter.closedAt === "string" ? frontmatter.closedAt : undefined,
  };
}

export function createContinuityIncidentRecord(
  id: string,
  input: ContinuityIncidentOpenInput,
  nowIso: string,
): ContinuityIncidentRecord {
  return {
    id,
    state: "open",
    openedAt: nowIso,
    updatedAt: nowIso,
    triggerWindow: input.triggerWindow?.trim() || undefined,
    symptom: input.symptom.trim(),
    suspectedCause: input.suspectedCause?.trim() || undefined,
  };
}

export function closeContinuityIncidentRecord(
  incident: ContinuityIncidentRecord,
  closure: ContinuityIncidentCloseInput,
  nowIso: string,
): ContinuityIncidentRecord {
  return {
    ...incident,
    state: "closed",
    updatedAt: nowIso,
    closedAt: nowIso,
    fixApplied: closure.fixApplied.trim(),
    verificationResult: closure.verificationResult.trim(),
    preventiveRule: closure.preventiveRule?.trim() || incident.preventiveRule,
  };
}
