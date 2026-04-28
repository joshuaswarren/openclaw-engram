import { ensureCronJob } from "./maintenance/memory-governance-cron.js";

const LIVE_CONNECTOR_CRON_ID = "engram-live-connectors-sync";

export async function ensureLiveConnectorCron(
  jobsPath: string,
  options: {
    timezone: string;
    agentId?: string;
    scheduleExpr?: string;
  },
): Promise<{ created: boolean; jobId: string }> {
  const scheduleExpr =
    typeof options.scheduleExpr === "string" && options.scheduleExpr.trim().length > 0
      ? options.scheduleExpr.trim()
      : "*/5 * * * *";
  const agentId =
    typeof options.agentId === "string" && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : "main";

  return ensureCronJob(jobsPath, LIVE_CONNECTOR_CRON_ID, () => ({
    id: LIVE_CONNECTOR_CRON_ID,
    agentId,
    name: "Remnic Live Connectors (poll due sources)",
    enabled: true,
    schedule: {
      kind: "cron",
      expr: scheduleExpr,
      tz: options.timezone,
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      timeoutSeconds: 900,
      thinking: "off",
      message:
        "You are OpenClaw automation. Call tool `engram.live_connectors_run` with empty params. " +
        "If successful output exactly NO_REPLY. On error output one concise line. Do NOT use message tool.",
    },
    delivery: { mode: "none" },
  }));
}
