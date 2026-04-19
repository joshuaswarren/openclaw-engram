import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveBenchRuntimeProfile } from "./runtime-profiles.ts";

test("baseline runtime profile keeps the stripped retrieval-only config", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
  });

  assert.equal(resolved.profile, "baseline");
  assert.equal(resolved.remnicConfig.qmdEnabled, false);
  assert.equal(resolved.remnicConfig.queryExpansionEnabled, false);
  assert.equal(resolved.remnicConfig.rerankEnabled, false);
  assert.equal(resolved.remnicConfig.verifiedRecallEnabled, false);
  assert.equal(resolved.remnicConfig.knowledgeIndexEnabled, false);
});

test("real runtime profile preserves the configured Remnic retrieval settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-runtime-"));
  const configPath = path.join(root, "remnic.config.json");

  await writeFile(
    configPath,
    JSON.stringify({
      remnic: {
        qmdEnabled: true,
        queryExpansionEnabled: true,
        rerankEnabled: true,
        verifiedRecallEnabled: true,
      },
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "real",
    remnicConfigPath: configPath,
  });

  assert.equal(resolved.profile, "real");
  assert.equal(resolved.remnicConfig.qmdEnabled, true);
  assert.equal(resolved.remnicConfig.queryExpansionEnabled, true);
  assert.equal(resolved.remnicConfig.rerankEnabled, true);
  assert.equal(resolved.remnicConfig.verifiedRecallEnabled, true);
  assert.equal(resolved.systemProvider, null);
  assert.equal(resolved.judgeProvider, null);
});

test("openclaw-chain runtime profile loads OpenClaw config and forces gateway routing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-openclaw-"));
  const configPath = path.join(root, "openclaw.json");

  await writeFile(
    configPath,
    JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4-mini",
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
          },
        },
      },
      plugins: {
        slots: {
          memory: "openclaw-remnic",
        },
        entries: {
          "openclaw-remnic": {
            config: {
              qmdEnabled: true,
              queryExpansionEnabled: true,
            },
          },
        },
      },
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "openclaw-chain",
    openclawConfigPath: configPath,
    gatewayAgentId: "memory-primary",
    fastGatewayAgentId: "memory-fast",
  });

  assert.equal(resolved.profile, "openclaw-chain");
  assert.equal(resolved.remnicConfig.qmdEnabled, true);
  assert.equal(resolved.remnicConfig.queryExpansionEnabled, true);
  assert.equal(resolved.remnicConfig.modelSource, "gateway");
  assert.equal(resolved.remnicConfig.gatewayAgentId, "memory-primary");
  assert.equal(resolved.remnicConfig.fastGatewayAgentId, "memory-fast");
  assert.deepEqual(
    (resolved.remnicConfig.gatewayConfig as { agents?: { defaults?: { model?: { primary?: string } } } }).agents?.defaults?.model,
    {
      primary: "openai/gpt-5.4-mini",
    },
  );
});

test("provider-backed runtime resolution rejects incomplete provider configuration", async () => {
  await assert.rejects(
    () =>
      resolveBenchRuntimeProfile({
        runtimeProfile: "real",
        systemProvider: "openai",
      }),
    /system provider requires both provider and model/i,
  );

  await assert.rejects(
    () =>
      resolveBenchRuntimeProfile({
        runtimeProfile: "real",
        judgeModel: "gpt-5.4-mini",
      }),
    /judge provider requires both provider and model/i,
  );
});
