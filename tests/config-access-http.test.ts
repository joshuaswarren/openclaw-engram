import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets local HTTP access defaults", () => {
  const original = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  try {
    const cfg = parseConfig({ openaiApiKey: "sk-test" });
    assert.deepEqual(cfg.agentAccessHttp, {
      enabled: false,
      host: "127.0.0.1",
      port: 4318,
      authToken: undefined,
      maxBodyBytes: 131072,
    });
  } finally {
    if (original === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = original;
    }
  }
});

test("parseConfig supports explicit local HTTP access config and env fallback", () => {
  const original = process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
  process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = "env-token";
  process.env.ENGRAM_ACCESS_TEST_TOKEN = "config-token";
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
        host: "localhost",
        port: 0,
        authToken: "${ENGRAM_ACCESS_TEST_TOKEN}",
        maxBodyBytes: 2048,
      },
    });
    assert.deepEqual(cfg.agentAccessHttp, {
      enabled: true,
      host: "localhost",
      port: 0,
      authToken: "config-token",
      maxBodyBytes: 2048,
    });

    const envCfg = parseConfig({
      openaiApiKey: "sk-test",
      agentAccessHttp: {
        enabled: true,
      },
    });
    assert.equal(envCfg.agentAccessHttp.authToken, "env-token");
  } finally {
    delete process.env.ENGRAM_ACCESS_TEST_TOKEN;
    if (original === undefined) {
      delete process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN;
    } else {
      process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN = original;
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
