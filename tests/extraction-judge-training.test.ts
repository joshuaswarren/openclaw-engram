import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  recordJudgeTrainingPair,
  readJudgeTrainingPairs,
  resolveTrainingDir,
  trainingFilePathFor,
  isValidTrainingPair,
  type JudgeTrainingPair,
} from "../packages/remnic-core/src/extraction-judge-training.ts";

async function mkdirTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "judge-training-"));
}

function basePair(overrides: Partial<JudgeTrainingPair> = {}): JudgeTrainingPair {
  return {
    version: 1,
    ts: "2026-04-10T12:00:00.000Z",
    candidateText: "Synthetic fact body",
    candidateCategory: "fact",
    candidateConfidence: 0.8,
    verdictKind: "accept",
    reason: "mock",
    ...overrides,
  };
}

test("PR 4: recordJudgeTrainingPair is a no-op when disabled", async () => {
  const dir = await mkdirTmp();
  try {
    await recordJudgeTrainingPair(basePair(), {
      enabled: false,
      directory: dir,
    });
    // Nothing should be written.
    const entries = await readdir(dir);
    assert.equal(entries.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 4: recordJudgeTrainingPair appends one row per day file", async () => {
  const dir = await mkdirTmp();
  try {
    const opts = { enabled: true, directory: dir };
    await recordJudgeTrainingPair(
      basePair({ ts: "2026-04-10T00:00:00.000Z", verdictKind: "accept" }),
      opts,
    );
    await recordJudgeTrainingPair(
      basePair({ ts: "2026-04-10T23:59:59.000Z", verdictKind: "defer" }),
      opts,
    );
    await recordJudgeTrainingPair(
      basePair({ ts: "2026-04-11T00:00:00.000Z", verdictKind: "reject" }),
      opts,
    );
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ["2026-04-10.jsonl", "2026-04-11.jsonl"]);
    const day1 = await readFile(path.join(dir, "2026-04-10.jsonl"), "utf-8");
    const day2 = await readFile(path.join(dir, "2026-04-11.jsonl"), "utf-8");
    assert.equal(day1.trim().split("\n").length, 2);
    assert.equal(day2.trim().split("\n").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 4: recordJudgeTrainingPair fails open on directory errors", async () => {
  const dir = await mkdirTmp();
  try {
    // Place a regular file at the training-dir location so mkdir fails.
    const sub = path.join(dir, "wedge");
    await writeFile(sub, "not a directory", "utf-8");
    // Must not throw; the helper swallows the error.
    await recordJudgeTrainingPair(basePair(), {
      enabled: true,
      directory: sub,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 4: resolveTrainingDir honors explicit directory override", () => {
  const p = resolveTrainingDir({ enabled: true, directory: "/tmp/foo" });
  assert.equal(p, "/tmp/foo");
});

test("PR 4: resolveTrainingDir defaults to ~/.remnic/judge-training", () => {
  const p = resolveTrainingDir({ enabled: true });
  assert.ok(
    p.endsWith(path.join(".remnic", "judge-training")),
    `default path should end with .remnic/judge-training, got ${p}`,
  );
});

test("PR 4: trainingFilePathFor uses UTC date stamp", () => {
  // 23:59 UTC → YYYY-MM-DD of same UTC day, not local.
  const p = trainingFilePathFor("/tmp/x", "2026-04-10T23:59:00.000Z");
  assert.equal(p, path.join("/tmp/x", "2026-04-10.jsonl"));
});

test("PR 4: readJudgeTrainingPairs returns empty on missing directory", async () => {
  const dir = await mkdirTmp();
  try {
    await rm(dir, { recursive: true, force: true });
    const result = await readJudgeTrainingPairs({ directory: dir });
    assert.equal(result.rows.length, 0);
    assert.equal(result.malformed, 0);
  } finally {
    // Already removed.
  }
});

test("PR 4: readJudgeTrainingPairs returns rows from all day files sorted", async () => {
  const dir = await mkdirTmp();
  try {
    const opts = { enabled: true, directory: dir };
    await recordJudgeTrainingPair(
      basePair({ ts: "2026-04-11T00:00:00.000Z", verdictKind: "reject" }),
      opts,
    );
    await recordJudgeTrainingPair(
      basePair({ ts: "2026-04-10T00:00:00.000Z", verdictKind: "accept" }),
      opts,
    );
    const result = await readJudgeTrainingPairs({ directory: dir });
    assert.equal(result.rows.length, 2);
    // Deterministic ordering: files are sorted lexicographically by name,
    // which matches chronological order for ISO date stamps.
    assert.equal(result.rows[0].verdictKind, "accept");
    assert.equal(result.rows[1].verdictKind, "reject");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 4: readJudgeTrainingPairs counts malformed rows separately", async () => {
  const dir = await mkdirTmp();
  try {
    await mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify(basePair({ verdictKind: "accept" })),
      "not-json",
      JSON.stringify({ version: 1, ts: "now", verdictKind: "bogus" }),
      JSON.stringify(basePair({ verdictKind: "defer" })),
    ];
    await writeFile(
      path.join(dir, "2026-04-10.jsonl"),
      lines.join("\n") + "\n",
      "utf-8",
    );
    const result = await readJudgeTrainingPairs({ directory: dir });
    assert.equal(result.rows.length, 2);
    assert.equal(result.malformed, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PR 4: isValidTrainingPair structural validation", () => {
  assert.equal(isValidTrainingPair(null), false);
  assert.equal(isValidTrainingPair({}), false);
  assert.equal(isValidTrainingPair(basePair()), true);
  assert.equal(
    isValidTrainingPair(basePair({ verdictKind: "bogus" as any })),
    false,
  );
  assert.equal(
    isValidTrainingPair(basePair({ groundTruthLabel: "defer" })),
    true,
  );
  assert.equal(
    isValidTrainingPair(basePair({ groundTruthLabel: "bogus" as any })),
    false,
  );
  assert.equal(isValidTrainingPair({ ...basePair(), version: 99 }), false);
  assert.equal(
    isValidTrainingPair({ ...basePair(), candidateConfidence: "hi" }),
    false,
  );
});

test("PR 4: training pair schema preserves ground truth label round-trip", async () => {
  const dir = await mkdirTmp();
  try {
    const opts = { enabled: true, directory: dir };
    const pair = basePair({ groundTruthLabel: "accept" });
    await recordJudgeTrainingPair(pair, opts);
    const result = await readJudgeTrainingPairs({ directory: dir });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].groundTruthLabel, "accept");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
