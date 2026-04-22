import assert from "node:assert/strict";
import test from "node:test";

import {
  createSyntheticTarget,
  SYNTHETIC_MEMORIES,
  runExtractionAttack,
  createSeededRng,
} from "./index.js";
import { createMitigatedTarget } from "./mitigated-target.js";
import { runMitigatedBaseline } from "./baseline.js";

test("createMitigatedTarget returns empty hits when budget is exceeded", async () => {
  const rawTarget = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    disclosesMemoryIds: true,
  });

  const mitigated = createMitigatedTarget({
    target: rawTarget,
    budgetHardLimit: 3,
    budgetWindowMs: 60_000,
    principalNamespace: "default",
  });

  // Same-namespace queries should not count against the budget.
  for (let i = 0; i < 5; i++) {
    const hits = await mitigated.recall("test", { namespace: "default" });
    assert.ok(Array.isArray(hits), `same-ns query ${i} should return array`);
  }

  // Cross-namespace queries should exhaust the budget.
  for (let i = 0; i < 3; i++) {
    const hits = await mitigated.recall("test", { namespace: "other" });
    assert.ok(Array.isArray(hits), `cross-ns query ${i} should return array`);
  }

  // 4th cross-namespace query should be denied (empty hits).
  const denied = await mitigated.recall("test", { namespace: "other" });
  assert.equal(denied.length, 0, "should return empty after budget exhausted");
});

test("createMitigatedTarget does not count undefined namespace against budget", async () => {
  const rawTarget = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    disclosesMemoryIds: true,
  });

  const mitigated = createMitigatedTarget({
    target: rawTarget,
    budgetHardLimit: 1,
    budgetWindowMs: 60_000,
    principalNamespace: "default",
  });

  // No namespace specified — should not count.
  for (let i = 0; i < 5; i++) {
    const hits = await mitigated.recall("test");
    assert.ok(Array.isArray(hits), `no-ns query ${i} should work`);
  }
});

test("runMitigatedBaseline returns mitigated rows", async () => {
  const rows = await runMitigatedBaseline();
  assert.ok(rows.length > 0, "should return at least one row");
  for (const row of rows) {
    assert.equal(row.mitigated, true);
    assert.ok(typeof row.asr === "number");
    assert.ok(row.asr >= 0 && row.asr <= 1);
  }
});

test("mitigated T3 ASR is lower than or equal to unmitigated T3 ASR", async () => {
  const { runBaseline, DEFAULT_BASELINE_SCENARIOS } = await import("./baseline.js");

  const baselineRows = await runBaseline(DEFAULT_BASELINE_SCENARIOS);
  const mitigatedRows = await runMitigatedBaseline();

  const t3Baseline = baselineRows.find((r) => r.scenario === "T3-cross-namespace-acl-enforced");
  const t3Mitigated = mitigatedRows.find((r) => r.scenario === "T3-cross-namespace-budget-hard30");

  assert.ok(t3Baseline, "T3 baseline should exist");
  assert.ok(t3Mitigated, "T3 mitigated should exist");

  assert.ok(
    t3Mitigated.asr <= t3Baseline.asr + 0.01,
    `mitigated ASR (${(t3Mitigated.asr * 100).toFixed(1)}%) should be <= baseline ASR (${(t3Baseline.asr * 100).toFixed(1)}%)`,
  );
});
