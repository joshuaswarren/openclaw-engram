import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildBenchBaselineRemnicConfig } from "./adapters/remnic-adapter.ts";
import { resolveBenchRuntimeProfile } from "./runtime-profiles.ts";

test("baseline runtime profile keeps the stripped retrieval-only config", async () => {
  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "baseline",
  });

  assert.equal(resolved.profile, "baseline");
  assert.deepEqual(resolved.remnicConfig, buildBenchBaselineRemnicConfig());
  assert.deepEqual(resolved.effectiveRemnicConfig, buildBenchBaselineRemnicConfig());
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
      openaiApiKey: "super-secret",
      secretKey: "secondary-secret",
      refreshToken: "oauth-refresh-token",
      apikey: "compact-secret",
      authtoken: "compact-token",
      clientsecret: "compact-client-secret",
      sessionToken: "metadata-not-a-secret",
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
  assert.equal(resolved.remnicConfig.openaiApiKey, "[redacted]");
  assert.equal(resolved.remnicConfig.secretKey, "[redacted]");
  assert.equal(resolved.remnicConfig.refreshToken, "[redacted]");
  assert.equal(resolved.remnicConfig.apikey, "[redacted]");
  assert.equal(resolved.remnicConfig.authtoken, "[redacted]");
  assert.equal(resolved.remnicConfig.clientsecret, "[redacted]");
  assert.equal(resolved.remnicConfig.sessionToken, "metadata-not-a-secret");
  assert.equal(resolved.effectiveRemnicConfig.openaiApiKey, "super-secret");
  assert.equal(resolved.effectiveRemnicConfig.secretKey, "secondary-secret");
  assert.equal(resolved.effectiveRemnicConfig.refreshToken, "oauth-refresh-token");
  assert.equal(resolved.effectiveRemnicConfig.apikey, "compact-secret");
  assert.equal(resolved.effectiveRemnicConfig.authtoken, "compact-token");
  assert.equal(resolved.effectiveRemnicConfig.clientsecret, "compact-client-secret");
  assert.equal(resolved.effectiveRemnicConfig.sessionToken, "metadata-not-a-secret");
  assert.equal(
    (resolved.adapterOptions.configOverrides as { openaiApiKey?: string }).openaiApiKey,
    "super-secret",
  );
  assert.equal(resolved.adapterOptions.preserveRuntimeDefaults, true);
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
  assert.equal(
    (resolved.remnicConfig.gatewayConfig as {
      models?: { providers?: { openai?: { apiKey?: string } } };
    }).models?.providers?.openai?.apiKey,
    "[redacted]",
  );
  assert.equal(
    (resolved.effectiveRemnicConfig.gatewayConfig as {
      models?: { providers?: { openai?: { apiKey?: string } } };
    }).models?.providers?.openai?.apiKey,
    "test-key",
  );
  assert.equal(resolved.adapterOptions.preserveRuntimeDefaults, true);
});

test("openclaw-chain ignores direct system-provider overrides and keeps gateway routing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-openclaw-override-"));
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
      plugins: {
        slots: {
          memory: "openclaw-remnic",
        },
        entries: {
          "openclaw-remnic": {
            config: {
              qmdEnabled: true,
            },
          },
        },
      },
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "openclaw-chain",
    openclawConfigPath: configPath,
    systemProvider: "openai",
    systemModel: "gpt-5.4",
  });

  assert.equal(resolved.profile, "openclaw-chain");
  assert.equal(resolved.remnicConfig.modelSource, "gateway");
  assert.equal(resolved.systemProvider, null);
});

test("openclaw-chain does not instantiate a direct provider-backed responder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-openclaw-lazy-"));
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
      plugins: {
        slots: {
          memory: "openclaw-remnic",
        },
        entries: {
          "openclaw-remnic": {
            config: {
              qmdEnabled: true,
            },
          },
        },
      },
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "openclaw-chain",
    openclawConfigPath: configPath,
    systemProvider: "unsupported-provider" as never,
    systemModel: "ignored-model",
  });

  assert.equal(resolved.profile, "openclaw-chain");
  assert.equal(resolved.systemProvider, null);
  assert.equal(resolved.remnicConfig.modelSource, "gateway");
});

test("openclaw-chain ignores incomplete direct system-provider config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-openclaw-ignore-system-"));
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
      plugins: {
        slots: {
          memory: "openclaw-remnic",
        },
        entries: {
          "openclaw-remnic": {
            config: {
              qmdEnabled: true,
            },
          },
        },
      },
    }),
  );

  const resolved = await resolveBenchRuntimeProfile({
    runtimeProfile: "openclaw-chain",
    openclawConfigPath: configPath,
    systemProvider: "openai",
  });

  assert.equal(resolved.profile, "openclaw-chain");
  assert.equal(resolved.systemProvider, null);
  assert.equal(resolved.remnicConfig.modelSource, "gateway");
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
