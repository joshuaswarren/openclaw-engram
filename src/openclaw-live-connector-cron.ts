import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const LIVE_CONNECTOR_CRON_ID = "engram-live-connectors-sync";

type CronJobsShape =
  | Array<Record<string, unknown>>
  | {
      jobs: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };

async function acquireCronJobsLock(jobsPath: string): Promise<() => Promise<void>> {
  const lockPath = `${jobsPath}.lock`;
  const start = Date.now();
  const staleMs = 30_000;
  const timeoutMs = 5_000;
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (Date.now() - start < timeoutMs) {
    try {
      await mkdir(lockPath);
      return async () => {
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch {
          // Lock cleanup should not fail cron registration.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock may have been released between stat/rm attempts.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`cron jobs lock acquisition timed out after ${timeoutMs}ms`);
}

function parseCronJobsShape(raw: string): {
  parsed: CronJobsShape;
  jobs: Array<Record<string, unknown>>;
} {
  const parsed = JSON.parse(raw) as CronJobsShape;
  const jobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : null;
  if (!jobs) throw new Error("jobs.json has unexpected structure");
  return { parsed, jobs };
}

async function writeCronJobsAtomic(jobsPath: string, value: CronJobsShape): Promise<void> {
  const tempPath = `${jobsPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await rename(tempPath, jobsPath);
}

async function ensureCronJob(
  jobsPath: string,
  jobId: string,
  buildJob: () => Record<string, unknown>,
): Promise<{ created: boolean; jobId: string }> {
  const releaseLock = await acquireCronJobsLock(jobsPath);
  try {
    const raw = await readFile(jobsPath, "utf-8");
    const { parsed, jobs } = parseCronJobsShape(raw);

    if (jobs.some((job) => job.id === jobId)) {
      return { created: false, jobId };
    }

    jobs.push(buildJob());
    const output = Array.isArray(parsed) ? jobs : { ...parsed, jobs };
    await writeCronJobsAtomic(jobsPath, output);
    return { created: true, jobId };
  } finally {
    await releaseLock();
  }
}

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
