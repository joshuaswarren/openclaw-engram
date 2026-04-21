import assert from "node:assert/strict";
import test from "node:test";

import {
  createSeededRng,
  createSyntheticTarget,
  OTHER_NAMESPACE_MEMORIES,
  runExtractionAttack,
  SYNTHETIC_MEMORIES,
} from "./index.ts";
import type { ExtractionAttackTarget } from "./index.ts";

const TEST_DEADLINE_MS = 20_000;

function deadline(): number {
  return Date.now() + TEST_DEADLINE_MS;
}

test("same-namespace attacker runs end-to-end and returns an ASR number", async () => {
  const target = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    entities: ["Alex Morgan", "Priya Shah", "Aurora", "Helios"],
  });

  const result = await runExtractionAttack({
    target,
    groundTruth: SYNTHETIC_MEMORIES,
    attackerMode: "same-namespace",
    queryBudget: 80,
    rng: createSeededRng(1),
    captureTimeline: true,
    deadlineMs: deadline(),
  });

  assert.equal(typeof result.asr, "number", "asr must be a number");
  assert.ok(
    result.asr >= 0 && result.asr <= 1,
    `asr must be in [0, 1] (got ${result.asr})`,
  );
  assert.ok(
    result.queriesIssued <= 80,
    `queriesIssued (${result.queriesIssued}) must not exceed budget`,
  );
  assert.equal(result.attackerMode, "same-namespace");
  assert.ok(
    result.timeline.length === result.queriesIssued,
    "captured timeline length must equal queries issued",
  );
  assert.ok(
    result.recovered.length + result.missed.length === SYNTHETIC_MEMORIES.length,
    "recovered + missed must cover ground truth",
  );
  assert.ok(
    result.asr > 0,
    `same-namespace attacker should recover at least one memory (asr=${result.asr})`,
  );
});

test("zero-knowledge attacker has strictly lower ASR than same-namespace attacker", async () => {
  const zkTarget = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    // Zero-knowledge attacker has no side-channel access.
    entities: [],
  });
  const snTarget = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    entities: ["Alex Morgan", "Priya Shah", "Aurora", "Helios"],
  });

  const commonArgs = {
    groundTruth: SYNTHETIC_MEMORIES,
    queryBudget: 60,
    deadlineMs: deadline(),
  };

  const zkResult = await runExtractionAttack({
    ...commonArgs,
    target: zkTarget,
    attackerMode: "zero-knowledge",
    rng: createSeededRng(42),
  });
  const snResult = await runExtractionAttack({
    ...commonArgs,
    target: snTarget,
    attackerMode: "same-namespace",
    rng: createSeededRng(42),
  });

  assert.ok(
    zkResult.asr < snResult.asr,
    `zero-knowledge ASR (${zkResult.asr}) must be strictly lower than same-namespace ASR (${snResult.asr})`,
  );
});

test("deterministic RNG produces reproducible results across runs", async () => {
  const buildTarget = () =>
    createSyntheticTarget({
      memories: SYNTHETIC_MEMORIES,
      entities: ["Alex Morgan", "Aurora"],
    });

  const runOnce = async () =>
    runExtractionAttack({
      target: buildTarget(),
      groundTruth: SYNTHETIC_MEMORIES,
      attackerMode: "same-namespace",
      queryBudget: 40,
      rng: createSeededRng(7),
      captureTimeline: true,
      deadlineMs: deadline(),
    });

  const a = await runOnce();
  const b = await runOnce();

  assert.equal(a.asr, b.asr, "asr should be identical under a fixed seed");
  assert.equal(a.queriesIssued, b.queriesIssued, "queries issued should match");
  assert.equal(a.recovered.length, b.recovered.length, "recovered count should match");
  const aQueries = a.timeline.map((t) => t.query);
  const bQueries = b.timeline.map((t) => t.query);
  assert.deepEqual(aQueries, bQueries, "query sequence must be deterministic");
});

test("cross-namespace attacker is blocked when namespace ACL is enforced", async () => {
  // Target has memories in the victim namespace AND a separate one, but the
  // attacker only holds a token for 'other'. The target enforces the ACL.
  const combined = [...SYNTHETIC_MEMORIES, ...OTHER_NAMESPACE_MEMORIES];
  const target = createSyntheticTarget({
    memories: combined,
    entities: [],
    enforceNamespaceAcl: true,
    allowedNamespace: "other",
  });

  const result = await runExtractionAttack({
    target,
    groundTruth: SYNTHETIC_MEMORIES, // attacker is trying to leak VICTIM memories
    attackerMode: "cross-namespace",
    queryBudget: 50,
    rng: createSeededRng(9),
    deadlineMs: deadline(),
  });

  // The threat model §6.1 says ACLs should make direct T3 attacks fail;
  // any recovery here would indicate the harness itself is leaking by
  // mistake.
  assert.equal(
    result.asr,
    0,
    `cross-namespace attacker should recover 0 victim memories when ACLs hold (got ${result.asr})`,
  );
});

test("harness respects query budget", async () => {
  const target = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
    entities: ["Alex Morgan"],
  });

  const result = await runExtractionAttack({
    target,
    groundTruth: SYNTHETIC_MEMORIES,
    attackerMode: "same-namespace",
    queryBudget: 5,
    rng: createSeededRng(3),
    deadlineMs: deadline(),
  });

  assert.ok(
    result.queriesIssued <= 5,
    `queriesIssued (${result.queriesIssued}) must not exceed budget=5`,
  );
});

test("harness returns empty recovery when target raises on every query", async () => {
  const target: ExtractionAttackTarget = {
    async recall() {
      throw new Error("denied");
    },
  };

  const result = await runExtractionAttack({
    target,
    groundTruth: SYNTHETIC_MEMORIES,
    attackerMode: "zero-knowledge",
    queryBudget: 10,
    rng: createSeededRng(11),
    deadlineMs: deadline(),
  });

  assert.equal(result.asr, 0, "no hits means 0 ASR");
  assert.equal(result.recovered.length, 0);
  assert.equal(result.missed.length, SYNTHETIC_MEMORIES.length);
});

test("rejects invalid budget and invalid entropy threshold", async () => {
  const target = createSyntheticTarget({
    memories: SYNTHETIC_MEMORIES,
  });

  await assert.rejects(
    () =>
      runExtractionAttack({
        target,
        groundTruth: SYNTHETIC_MEMORIES,
        attackerMode: "zero-knowledge",
        queryBudget: 0,
      }),
    /queryBudget/,
  );

  await assert.rejects(
    () =>
      runExtractionAttack({
        target,
        groundTruth: SYNTHETIC_MEMORIES,
        attackerMode: "zero-knowledge",
        queryBudget: 5,
        entropyThreshold: 2,
      }),
    /entropyThreshold/,
  );
});
