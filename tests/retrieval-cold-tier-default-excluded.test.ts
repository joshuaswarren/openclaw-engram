/**
 * Regression tests for issue #686 PR 1/6 — verify recall path excludes cold
 * collection by default.
 *
 * Year-2 retention design intent: the cold QMD collection (default
 * "openclaw-engram-cold") is opt-in via `qmdColdTierEnabled`. Default recall
 * must hit the hot collection only. If a fresh install (no cold tier
 * configured) ever queries the cold QMD collection, the index-cost benefit of
 * the two-tier design evaporates.
 *
 * These tests pin three invariants:
 *   1. parseConfig defaults `qmdColdTierEnabled` to false.
 *   2. `applyColdFallbackPipeline` does NOT call into the cold-QMD branch when
 *      `qmdColdTierEnabled` is false (the archive-scan path is allowed; that
 *      reads `archive/`, not the cold tier).
 *   3. `applyColdFallbackPipeline` DOES call into the cold-QMD branch when
 *      `qmdColdTierEnabled` is explicitly true (the opt-in path remains wired).
 *
 * Test stubs the orchestrator's QMD adapter and `searchLongTermArchiveFallback`
 * so we can observe whether the cold collection is ever queried.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { QmdSearchResult } from "../src/types.js";

interface ColdAuditState {
  coldQmdCalls: number;
  archiveFallbackCalls: number;
  hotPrimaryCalls: number;
  observedCollections: (string | undefined)[];
}

async function buildAuditedOrchestrator(opts: {
  memoryDir: string;
  workspaceDir: string;
  qmdColdTierEnabled?: boolean;
}): Promise<{ orchestrator: any; state: ColdAuditState }> {
  const cfgInput: Record<string, unknown> = {
    openaiApiKey: "sk-test",
    memoryDir: opts.memoryDir,
    workspaceDir: opts.workspaceDir,
    qmdEnabled: true,
    qmdMaxResults: 4,
    qmdCollection: "engram-hot",
    qmdColdCollection: "engram-cold",
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: true,
  };
  if (opts.qmdColdTierEnabled !== undefined) {
    cfgInput.qmdColdTierEnabled = opts.qmdColdTierEnabled;
  }
  const config = parseConfig(cfgInput);
  const orchestrator = new Orchestrator(config) as any;

  const state: ColdAuditState = {
    coldQmdCalls: 0,
    archiveFallbackCalls: 0,
    hotPrimaryCalls: 0,
    observedCollections: [],
  };

  // Stub QMD adapter so any direct call is recorded.
  orchestrator.qmd = {
    isAvailable: () => true,
    search: async (_query: string, collection?: string) => {
      state.observedCollections.push(collection);
      if (collection === "engram-cold") {
        state.coldQmdCalls += 1;
      } else if (collection === undefined || collection === "engram-hot") {
        state.hotPrimaryCalls += 1;
      }
      return [] as QmdSearchResult[];
    },
    hybridSearch: async (_query: string, collection?: string) => {
      state.observedCollections.push(collection);
      return [] as QmdSearchResult[];
    },
  };

  // Stub the namespace-aware hot path so we can observe it without depending
  // on a live qmd binary or actual filesystem fixtures.
  orchestrator.fetchQmdMemoryResultsWithArtifactTopUp = async (
    _prompt: string,
    _qmdFetchLimit: number,
    _qmdHybridFetchLimit: number,
    o: { collection?: string },
  ): Promise<QmdSearchResult[]> => {
    state.observedCollections.push(o.collection);
    if (o.collection === "engram-cold") {
      state.coldQmdCalls += 1;
    } else {
      state.hotPrimaryCalls += 1;
    }
    return [];
  };

  // Stub archive scan so cold-fallback's archive branch is observable but
  // returns empty (so we can check whether cold-QMD is called instead).
  orchestrator.searchLongTermArchiveFallback = async (): Promise<
    QmdSearchResult[]
  > => {
    state.archiveFallbackCalls += 1;
    return [];
  };

  return { orchestrator, state };
}

test("parseConfig: qmdColdTierEnabled defaults to false (cold tier opt-in)", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(
    cfg.qmdColdTierEnabled,
    false,
    "Default qmdColdTierEnabled must be false; cold tier is opt-in",
  );
});

test("applyColdFallbackPipeline: cold QMD collection NOT queried under default config", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-default-excluded-"),
  );
  const workspaceDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-default-excluded-ws-"),
  );

  try {
    const { orchestrator, state } = await buildAuditedOrchestrator({
      memoryDir,
      workspaceDir,
      // qmdColdTierEnabled left unset → defaults to false.
    });

    // Invoke the cold-fallback pipeline directly. Under default config the
    // cold-QMD branch must be skipped entirely; archive-scan is the only
    // source consulted and returns empty per our stub.
    const results: QmdSearchResult[] = await orchestrator.applyColdFallbackPipeline(
      {
        prompt: "any query",
        recallNamespaces: ["default"],
        recallResultLimit: 4,
        recallMode: "full",
      },
    );

    assert.equal(results.length, 0);
    assert.equal(
      state.coldQmdCalls,
      0,
      "cold QMD collection must not be queried when qmdColdTierEnabled=false",
    );
    assert.equal(
      state.archiveFallbackCalls,
      1,
      "archive-scan fallback should run once when cold-QMD is disabled",
    );
    assert.ok(
      !state.observedCollections.includes("engram-cold"),
      `cold collection must not appear in observed collections, got: ${JSON.stringify(state.observedCollections)}`,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3 });
    await rm(workspaceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("applyColdFallbackPipeline: cold QMD IS queried when explicitly opted in", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-optin-"),
  );
  const workspaceDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-cold-optin-ws-"),
  );

  try {
    const { orchestrator, state } = await buildAuditedOrchestrator({
      memoryDir,
      workspaceDir,
      qmdColdTierEnabled: true,
    });

    await orchestrator.applyColdFallbackPipeline({
      prompt: "any query",
      recallNamespaces: ["default"],
      recallResultLimit: 4,
      recallMode: "full",
    });

    assert.equal(
      state.coldQmdCalls,
      1,
      "cold QMD collection MUST be queried when qmdColdTierEnabled=true",
    );
    assert.ok(
      state.observedCollections.includes("engram-cold"),
      `cold collection should appear in observed collections, got: ${JSON.stringify(state.observedCollections)}`,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true, maxRetries: 3 });
    await rm(workspaceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("primary recall path (fetchQmdMemoryResultsWithArtifactTopUp default invocation) does not target cold collection", async () => {
  // Static-call-site audit: every call to fetchQmdMemoryResultsWithArtifactTopUp
  // in orchestrator.ts that is not inside applyColdFallbackPipeline must omit
  // the `collection` option (so it falls back to the hot-collection default).
  // This reads the orchestrator source at runtime and asserts the property.
  const { readFile } = await import("node:fs/promises");
  const orchestratorPath = new URL(
    "../packages/remnic-core/src/orchestrator.ts",
    import.meta.url,
  );
  const src = await readFile(orchestratorPath, "utf-8");

  // Find every call to fetchQmdMemoryResultsWithArtifactTopUp(...).
  const callMatches = [
    ...src.matchAll(/fetchQmdMemoryResultsWithArtifactTopUp\(([\s\S]*?)\n\s*\);/g),
  ];
  assert.ok(
    callMatches.length >= 2,
    `expected to find at least 2 call sites; found ${callMatches.length}`,
  );

  // Only one call site is allowed to pass collection: coldCollection — the one
  // inside applyColdFallbackPipeline. Every other call must NOT pass any
  // `collection:` field, so it inherits the hot-collection default.
  let coldExplicitCount = 0;
  let hotImplicitCount = 0;
  for (const match of callMatches) {
    const args = match[1] ?? "";
    if (/collection:\s*coldCollection\b/.test(args)) {
      coldExplicitCount += 1;
    } else if (!/collection:/.test(args)) {
      hotImplicitCount += 1;
    } else {
      // A new explicit collection target appeared — fail loudly so the audit
      // is re-run.
      assert.fail(
        `unexpected explicit collection target in fetchQmdMemoryResultsWithArtifactTopUp call: ${args}`,
      );
    }
  }
  assert.equal(
    coldExplicitCount,
    1,
    "exactly one cold-targeted call site is allowed (inside applyColdFallbackPipeline)",
  );
  assert.ok(
    hotImplicitCount >= 1,
    "at least one hot-default call site must exist",
  );
});
