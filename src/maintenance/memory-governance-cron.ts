import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const GOVERNANCE_CRON_ID = "engram-nightly-governance";

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
      if (code !== "EEXIST") {
        throw error;
      }
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

function parseCronJobsShape(raw: string): { parsed: CronJobsShape; jobs: Array<Record<string, unknown>> } {
  const parsed = JSON.parse(raw) as CronJobsShape;
  const jobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : null;
  if (!jobs) {
    throw new Error("jobs.json has unexpected structure");
  }
  return { parsed, jobs };
}

async function writeCronJobsAtomic(jobsPath: string, value: CronJobsShape): Promise<void> {
  const tempPath = `${jobsPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await rename(tempPath, jobsPath);
}

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

  const releaseLock = await acquireCronJobsLock(jobsPath);
  try {
    const raw = await readFile(jobsPath, "utf-8");
    const { parsed, jobs } = parseCronJobsShape(raw);

    if (jobs.some((job) => job.id === GOVERNANCE_CRON_ID)) {
      return { created: false, jobId: GOVERNANCE_CRON_ID };
    }

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
    await writeCronJobsAtomic(jobsPath, output);
    return { created: true, jobId: GOVERNANCE_CRON_ID };
  } finally {
    await releaseLock();
  }
}
