import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { ensureDaySummaryCron, ensureNightlyGovernanceCron } from "../src/maintenance/memory-governance-cron.ts";

test("nightly governance cron auto-registers a bounded job once", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-governance-cron-"));
  const jobsPath = path.join(tempDir, "jobs.json");

  try {
    await writeFile(jobsPath, JSON.stringify({ version: 1, jobs: [] }, null, 2) + "\n", "utf-8");

    const first = await ensureNightlyGovernanceCron(jobsPath, {
      timezone: "America/Chicago",
    });
    assert.equal(first.created, true);

    const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as {
      jobs: Array<{
        id: string;
        schedule: { kind: string; expr: string; tz: string };
        payload: { kind: string; message: string };
      }>;
    };
    assert.equal(parsed.jobs.length, 1);
    assert.equal(parsed.jobs[0]?.id, "engram-nightly-governance");
    assert.deepEqual(parsed.jobs[0]?.schedule, {
      kind: "cron",
      expr: "23 2 * * *",
      tz: "America/Chicago",
    });
    assert.match(parsed.jobs[0]?.payload.message ?? "", /memory_governance_run/);
    assert.match(parsed.jobs[0]?.payload.message ?? "", /"recentDays": 2/);
    assert.match(parsed.jobs[0]?.payload.message ?? "", /"maxMemories": 500/);
    assert.match(parsed.jobs[0]?.payload.message ?? "", /"batchSize": 100/);

    const second = await ensureNightlyGovernanceCron(jobsPath, {
      timezone: "America/Chicago",
    });
    assert.equal(second.created, false);

    const deduped = JSON.parse(await readFile(jobsPath, "utf-8")) as { jobs: Array<{ id: string }> };
    assert.equal(deduped.jobs.filter((job) => job.id === "engram-nightly-governance").length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("day-summary and nightly governance cron registration share the same write lock", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "engram-governance-cron-lock-"));
  const jobsPath = path.join(tempDir, "jobs.json");

  try {
    await writeFile(jobsPath, JSON.stringify({ version: 1, jobs: [] }, null, 2) + "\n", "utf-8");

    const [daySummary, governance] = await Promise.all([
      ensureDaySummaryCron(jobsPath, { timezone: "America/Chicago" }),
      ensureNightlyGovernanceCron(jobsPath, { timezone: "America/Chicago" }),
    ]);

    assert.equal(daySummary.created, true);
    assert.equal(governance.created, true);

    const parsed = JSON.parse(await readFile(jobsPath, "utf-8")) as { jobs: Array<{ id: string }> };
    assert.deepEqual(
      parsed.jobs.map((job) => job.id).sort(),
      ["engram-day-summary", "engram-nightly-governance"],
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
