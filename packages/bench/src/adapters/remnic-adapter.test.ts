import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBenchAdapterConfig,
  buildBenchBaselineRemnicConfig,
} from "./remnic-adapter.ts";

const BASE_CONFIG = {
  memoryDir: "/tmp/remnic-bench-memory",
  workspaceDir: "/tmp/remnic-bench-workspace",
  lcmEnabled: true as const,
};

test("direct adapter keeps its recall-friendly defaults without overrides", () => {
  const config = buildBenchAdapterConfig("direct", BASE_CONFIG);

  assert.equal(config.extractionDedupeEnabled, true);
  assert.equal(config.extractionMinChars, 10);
  assert.equal(config.extractionMinUserTurns, 0);
  assert.equal(config.recallPlannerEnabled, true);
  assert.equal(config.queryExpansionEnabled, false);
});

test("persisted baseline config stays aligned with direct adapter defaults", () => {
  const { memoryDir: _memoryDir, workspaceDir: _workspaceDir, ...directConfig } =
    buildBenchAdapterConfig("direct", BASE_CONFIG);

  assert.deepEqual(buildBenchBaselineRemnicConfig(), directConfig);
});

test("adapter sandbox paths cannot be overridden by runtime config", () => {
  const overrides = {
    memoryDir: "/tmp/real-user-memory",
    workspaceDir: "/tmp/real-user-workspace",
    lcmEnabled: false,
  };

  const direct = buildBenchAdapterConfig("direct", BASE_CONFIG, overrides);
  const lightweight = buildBenchAdapterConfig("lightweight", BASE_CONFIG, overrides);

  assert.equal(direct.memoryDir, BASE_CONFIG.memoryDir);
  assert.equal(direct.workspaceDir, BASE_CONFIG.workspaceDir);
  assert.equal(direct.lcmEnabled, true);
  assert.equal(lightweight.memoryDir, BASE_CONFIG.memoryDir);
  assert.equal(lightweight.workspaceDir, BASE_CONFIG.workspaceDir);
  assert.equal(lightweight.lcmEnabled, true);
});

test("lightweight adapter keeps smoke-run guardrails even when overrides conflict", () => {
  const assistantHook = { enabled: true };
  const config = buildBenchAdapterConfig("lightweight", BASE_CONFIG, {
    extractionDedupeEnabled: true,
    extractionMinChars: 10,
    extractionMinUserTurns: 0,
    recallPlannerEnabled: true,
    assistantHook,
  });

  assert.equal(config.extractionDedupeEnabled, false);
  assert.equal(config.extractionMinChars, 1000000);
  assert.equal(config.extractionMinUserTurns, 1000000);
  assert.equal(config.recallPlannerEnabled, false);
  assert.deepEqual(config.assistantHook, assistantHook);
});

test("benchmark config builders do not share nested nativeKnowledge state", () => {
  const first = buildBenchAdapterConfig("direct", BASE_CONFIG) as {
    nativeKnowledge: { enabled: boolean };
  };
  const second = buildBenchAdapterConfig("direct", BASE_CONFIG) as {
    nativeKnowledge: { enabled: boolean };
  };
  const baseline = buildBenchBaselineRemnicConfig() as {
    nativeKnowledge: { enabled: boolean };
  };

  first.nativeKnowledge.enabled = true;

  assert.equal(second.nativeKnowledge.enabled, false);
  assert.equal(baseline.nativeKnowledge.enabled, false);
});

test("benchmark config builders preserve function-valued assistant hooks", async () => {
  const assistantAgent = {
    async respond(): Promise<string> {
      return "ok";
    },
  };
  const assistantJudge = {
    async evaluate(): Promise<{ score: number }> {
      return { score: 0.8 };
    },
  };

  const config = buildBenchAdapterConfig("direct", BASE_CONFIG, {
    assistantAgent,
    assistantJudge,
  }) as {
    assistantAgent: typeof assistantAgent;
    assistantJudge: typeof assistantJudge;
  };

  assert.equal(await config.assistantAgent.respond(), "ok");
  assert.deepEqual(await config.assistantJudge.evaluate(), { score: 0.8 });
  assert.notEqual(config.assistantAgent, assistantAgent);
  assert.notEqual(config.assistantJudge, assistantJudge);
});
