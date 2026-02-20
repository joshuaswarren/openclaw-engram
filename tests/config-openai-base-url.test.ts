import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { initLogger, type LoggerBackend } from "../src/logger.js";

function withLoggerWarnings(): { warnings: string[] } {
  const warnings: string[] = [];
  const backend: LoggerBackend = {
    info() {},
    warn(msg: string) {
      warnings.push(msg);
    },
    error() {},
    debug() {},
  };
  initLogger(backend, false);
  return { warnings };
}

test("openaiBaseUrl supports ${ENV_VAR} expansion from config", () => {
  const original = process.env.TEST_OPENAI_BASE_URL;
  process.env.TEST_OPENAI_BASE_URL = "https://api.example.test/v1";
  const { warnings } = withLoggerWarnings();

  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    openaiBaseUrl: "${TEST_OPENAI_BASE_URL}",
  });

  assert.equal(cfg.openaiBaseUrl, "https://api.example.test/v1");
  assert.equal(warnings.length, 0);

  if (original === undefined) delete process.env.TEST_OPENAI_BASE_URL;
  else process.env.TEST_OPENAI_BASE_URL = original;
});

test("openaiBaseUrl falls back to OPENAI_BASE_URL when not set in config", () => {
  const original = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://fallback.example.test/v1";
  const { warnings } = withLoggerWarnings();

  const cfg = parseConfig({
    openaiApiKey: "sk-test",
  });

  assert.equal(cfg.openaiBaseUrl, "https://fallback.example.test/v1");
  assert.equal(warnings.length, 0);

  if (original === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = original;
});

test("openaiBaseUrl rejects unsupported schemes", () => {
  const { warnings } = withLoggerWarnings();
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    openaiBaseUrl: "ftp://provider.example.test/v1",
  });

  assert.equal(cfg.openaiBaseUrl, undefined);
  assert.ok(warnings.some((w) => w.includes("unsupported URL scheme")));
});

test("openaiBaseUrl warns when using insecure http", () => {
  const { warnings } = withLoggerWarnings();
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    openaiBaseUrl: "http://localhost:1234/v1",
  });

  assert.equal(cfg.openaiBaseUrl, "http://localhost:1234/v1");
  assert.ok(warnings.some((w) => w.includes("insecure http")));
});
