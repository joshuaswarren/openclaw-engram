import { readFile, writeFile } from "node:fs/promises";

const GOVERNANCE_CRON_ID = "engram-nightly-governance";

type CronJobsShape =
  | Array<Record<string, unknown>>
  | {
      jobs: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };

export async function ensureNightlyGovernanceCron(
  jobsPath: string,
  options: {
    timezone: string;
    agentId?: string;
    recentDays?: number;
    maxMemories?: number;
    batchSize?: number;
    scheduleExpr?: string;
  },
): Promise<{ created: boolean; jobId: string }> {
  const raw = await readFile(jobsPath, "utf-8");
  const parsed = JSON.parse(raw) as CronJobsShape;
  const jobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : null;
  if (!jobs) {
    throw new Error("jobs.json has unexpected structure");
  }

  if (jobs.some((job) => job.id === GOVERNANCE_CRON_ID)) {
    return { created: false, jobId: GOVERNANCE_CRON_ID };
  }

  const recentDays =
    typeof options.recentDays === "number" && Number.isFinite(options.recentDays)
      ? Math.max(1, Math.floor(options.recentDays))
      : 2;
  const maxMemories =
    typeof options.maxMemories === "number" && Number.isFinite(options.maxMemories)
      ? Math.max(1, Math.floor(options.maxMemories))
      : 500;
  const batchSize =
    typeof options.batchSize === "number" && Number.isFinite(options.batchSize)
      ? Math.max(1, Math.floor(options.batchSize))
      : 100;
  const scheduleExpr =
    typeof options.scheduleExpr === "string" && options.scheduleExpr.trim().length > 0
      ? options.scheduleExpr.trim()
      : "23 2 * * *";
  const agentId =
    typeof options.agentId === "string" && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : "main";

  jobs.push({
    id: GOVERNANCE_CRON_ID,
    agentId,
    name: "Engram Nightly Governance (batched)",
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
        "You are OpenClaw automation. Call the tool `memory_governance_run` with params " +
        `{"recentDays": ${recentDays}, "maxMemories": ${maxMemories}, "batchSize": ${batchSize}}` +
        ". If successful output exactly NO_REPLY. On error output one concise line. Do NOT use message tool.",
    },
    delivery: { mode: "none" },
  });

  const output = Array.isArray(parsed) ? jobs : { ...parsed, jobs };
  await writeFile(jobsPath, JSON.stringify(output, null, 2) + "\n", "utf-8");
  return { created: true, jobId: GOVERNANCE_CRON_ID };
}
