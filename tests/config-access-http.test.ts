import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets local HTTP access defaults", () => {
  const originalRemnic = process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
  const original = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  const originalPrincipal = process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
  delete process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
  delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  delete process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
  try {
    const cfg = parseConfig({ openaiApiKey: "sk-test" });
    assert.deepEqual(cfg.agentAccessHttp, {
      enabled: false,
      host: "127.0.0.1",
      port: 4318,
      authToken: undefined,
      principal: undefined,
      maxBodyBytes: 131072,
    });
  } finally {
    if (originalRemnic === undefined) {
      delete process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_REMNIC_ACCESS_TOKEN = originalRemnic;
    }
    if (original === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = original;
    }
    if (originalPrincipal === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL = originalPrincipal;
    }
  }
});

test("parseConfig supports explicit local HTTP access config and env fallback", () => {
  const originalRemnic = process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
  const original = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  const originalPrincipal = process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
  process.env.OPENCLAW_REMNIC_ACCESS_TOKEN = "remnic-env-token";
  process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = "engram-env-token";
  process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL = "env-principal";
  process.env.ENGRAM_ACCESS_TEST_TOKEN = "config-token";
  process.env.ENGRAM_ACCESS_TEST_PRINCIPAL = "config-principal";
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
        host: "localhost",
        port: 0,
        authToken: "${ENGRAM_ACCESS_TEST_TOKEN}",
        principal: "${ENGRAM_ACCESS_TEST_PRINCIPAL}",
        maxBodyBytes: 2048,
      },
    });
    assert.deepEqual(cfg.agentAccessHttp, {
      enabled: true,
      host: "localhost",
      port: 0,
      authToken: "config-token",
      principal: "config-principal",
      maxBodyBytes: 2048,
    });

    const envCfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
      },
    });
    assert.equal(envCfg.agentAccessHttp.authToken, "remnic-env-token");
    assert.equal(envCfg.agentAccessHttp.principal, "env-principal");

    delete process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
    const legacyEnvCfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
      },
    });
    assert.equal(legacyEnvCfg.agentAccessHttp.authToken, "engram-env-token");
  } finally {
    delete process.env.ENGRAM_ACCESS_TEST_TOKEN;
    delete process.env.ENGRAM_ACCESS_TEST_PRINCIPAL;
    if (originalRemnic === undefined) {
      delete process.env.OPENCLAW_REMNIC_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_REMNIC_ACCESS_TOKEN = originalRemnic;
    }
    if (original === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = original;
    }
    if (originalPrincipal === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_PRINCIPAL = originalPrincipal;
    }
  }
});

test("parseConfig preserves small explicit HTTP body limits", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    agentAccessHttp: {
      enabled: true,
      maxBodyBytes: 32,
    },
  });
  assert.equal(cfg.agentAccessHttp.maxBodyBytes, 32);
});
