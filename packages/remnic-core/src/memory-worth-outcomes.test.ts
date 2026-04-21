import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { StorageManager } from "./storage.js";
import {
  recordMemoryOutcome,
  memoryWorthOutcomeEligibleCategories,
} from "./memory-worth-outcomes.js";

/**
 * Issue #560 PR 3 — tests for the outcome signal pipeline.
 *
 * These tests pin the contract `recordMemoryOutcome` exposes to callers:
 *   - Successful increments land on the right counter and preserve
 *     unrelated frontmatter fields.
 *   - Legacy memories (no counters yet) start at 1 / 0 after the first
 *     success, not at some dedup-polluted value.
 *   - Non-eligible categories are rejected as ineligible, not silently
 *     written to.
 *   - Invalid paths / IDs / outcomes return an `{ok: false}` result, not a
 *     thrown exception, so a ledger drainer can aggregate failure reasons.
 */

async function writeFactFile(
  storage: StorageManager,
  body: string,
  extraFrontmatterLines: string[] = [],
): Promise<{ id: string; filePath: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const id = `fact-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lines = [
    "---",
    `id: ${id}`,
    "category: fact",
    `created: ${new Date().toISOString()}`,
    `updated: ${new Date().toISOString()}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    ...extraFrontmatterLines,
    "---",
  ];
  const factsDir = path.join((storage as unknown as { baseDir: string }).baseDir, "facts", today);
  await mkdir(factsDir, { recursive: true });
  const filePath = path.join(factsDir, `${id}.md`);
  await writeFile(filePath, `${lines.join("\n")}\n\n${body}\n`, "utf-8");
  return { id, filePath };
}

async function writeCorrectionFile(
  storage: StorageManager,
  body: string,
): Promise<{ id: string; filePath: string }> {
  const id = `correction-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lines = [
    "---",
    `id: ${id}`,
    "category: correction",
    `created: ${new Date().toISOString()}`,
    `updated: ${new Date().toISOString()}`,
    "source: extraction",
    "confidence: 0.8",
    "confidenceTier: high",
    "tags: []",
    "---",
  ];
  const correctionsDir = path.join(
    (storage as unknown as { baseDir: string }).baseDir,
    "corrections",
  );
  await mkdir(correctionsDir, { recursive: true });
  const filePath = path.join(correctionsDir, `${id}.md`);
  await writeFile(filePath, `${lines.join("\n")}\n\n${body}\n`, "utf-8");
  return { id, filePath };
}

test("success on a legacy memory increments mw_success from implicit 0", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-success-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id, filePath } = await writeFactFile(storage, "Legacy fact pre-dating instrumentation.");

    const result = await recordMemoryOutcome(storage, {
      memoryPath: filePath,
      outcome: "success",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.memoryId, id);
      assert.equal(result.mw_success, 1);
      assert.equal(result.mw_fail, 0);
    }

    const after = await storage.getMemoryById(id);
    assert.ok(after);
    assert.equal(after!.frontmatter.mw_success, 1);
    assert.equal(after!.frontmatter.mw_fail, 0);
    // Unrelated fields must survive the mutation.
    assert.equal(after!.frontmatter.category, "fact");
    assert.equal(after!.frontmatter.confidence, 0.8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failure on a legacy memory increments mw_fail from implicit 0", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-failure-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id, filePath } = await writeFactFile(storage, "Legacy fact destined for a failure.");

    const result = await recordMemoryOutcome(storage, {
      memoryPath: filePath,
      outcome: "failure",
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mw_success, 0);
      assert.equal(result.mw_fail, 1);
    }

    const after = await storage.getMemoryById(id);
    assert.equal(after!.frontmatter.mw_success, 0);
    assert.equal(after!.frontmatter.mw_fail, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("consecutive outcomes accumulate independently", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-accum-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id, filePath } = await writeFactFile(storage, "Accumulating outcomes.", [
      "mw_success: 2",
      "mw_fail: 0",
    ]);

    await recordMemoryOutcome(storage, { memoryPath: filePath, outcome: "success" });
    await recordMemoryOutcome(storage, { memoryPath: filePath, outcome: "failure" });
    const final = await recordMemoryOutcome(storage, {
      memoryPath: filePath,
      outcome: "failure",
    });

    assert.equal(final.ok, true);
    if (final.ok) {
      assert.equal(final.mw_success, 3);
      assert.equal(final.mw_fail, 2);
    }

    const after = await storage.getMemoryById(id);
    assert.equal(after!.frontmatter.mw_success, 3);
    assert.equal(after!.frontmatter.mw_fail, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-fact category returns ineligible_category, does NOT write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-ineligible-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { id, filePath } = await writeCorrectionFile(storage, "A correction, not a fact.");

    const result = await recordMemoryOutcome(storage, {
      memoryPath: filePath,
      outcome: "success",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "ineligible_category");
    }

    // The frontmatter must be completely untouched.
    const after = await storage.getMemoryById(id);
    assert.ok(after);
    assert.equal(after!.frontmatter.mw_success, undefined);
    assert.equal(after!.frontmatter.mw_fail, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown memory id returns not_found, does not throw", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-missing-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const result = await recordMemoryOutcome(storage, {
      memoryPath: path.join(dir, "facts", "2026-01-01", "nonexistent-id.md"),
      outcome: "success",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not_found");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid outcome string returns invalid_outcome", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-bad-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const { filePath } = await writeFactFile(storage, "Fact.");

    const result = await recordMemoryOutcome(storage, {
      memoryPath: filePath,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      outcome: "maybe" as any,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid_outcome");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("path without .md suffix returns invalid_path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mw-outcome-badpath-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const result = await recordMemoryOutcome(storage, {
      memoryPath: "not-a-memory-file",
      outcome: "success",
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "invalid_path");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eligible-category set is exactly {fact}", () => {
  // Pinning this keeps PR 3 in lockstep with the PR 1 doctor allowlist in
  // operator-toolkit.ts (MEMORY_WORTH_ELIGIBLE_CATEGORIES). If either side
  // expands, this test and the doctor test must both be updated.
  const eligible = memoryWorthOutcomeEligibleCategories();
  assert.equal(eligible.size, 1);
  assert.ok(eligible.has("fact"));
});
