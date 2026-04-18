import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, DEFAULT_CONFIG } from "./config.js";

describe("parseConfig", () => {
  const validRaw = {
    wecloneApiUrl: "http://localhost:8000/v1",
    proxyPort: 8100,
    remnicDaemonUrl: "http://localhost:4318",
  };

  it("parses a valid minimal config and applies defaults", () => {
    const config = parseConfig(validRaw);
    assert.equal(config.wecloneApiUrl, "http://localhost:8000/v1");
    assert.equal(config.proxyPort, 8100);
    assert.equal(config.remnicDaemonUrl, "http://localhost:4318");
    assert.equal(config.sessionStrategy, DEFAULT_CONFIG.sessionStrategy);
    assert.equal(config.wecloneModelName, DEFAULT_CONFIG.wecloneModelName);
    assert.deepStrictEqual(config.memoryInjection, DEFAULT_CONFIG.memoryInjection);
  });

  it("parses a fully specified config", () => {
    const full = {
      ...validRaw,
      wecloneModelName: "custom-avatar",
      sessionStrategy: "caller-id",
      memoryInjection: {
        maxTokens: 2000,
        position: "system-prepend",
        template: "MEMORIES:\n{memories}",
      },
    };
    const config = parseConfig(full);
    assert.equal(config.wecloneModelName, "custom-avatar");
    assert.equal(config.sessionStrategy, "caller-id");
    assert.equal(config.memoryInjection.maxTokens, 2000);
    assert.equal(config.memoryInjection.position, "system-prepend");
    assert.equal(config.memoryInjection.template, "MEMORIES:\n{memories}");
  });

  it("rejects null input", () => {
    assert.throws(() => parseConfig(null), /non-null object/);
  });

  it("rejects non-object input", () => {
    assert.throws(() => parseConfig("string"), /non-null object/);
  });

  it("rejects missing wecloneApiUrl", () => {
    const { wecloneApiUrl: _, ...rest } = validRaw;
    assert.throws(() => parseConfig(rest), /wecloneApiUrl/);
  });

  it("rejects empty wecloneApiUrl", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, wecloneApiUrl: "" }),
      /wecloneApiUrl/
    );
  });

  it("rejects missing proxyPort", () => {
    const { proxyPort: _, ...rest } = validRaw;
    assert.throws(() => parseConfig(rest), /proxyPort/);
  });

  it("rejects non-integer proxyPort", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, proxyPort: 3.14 }),
      /proxyPort/
    );
  });

  it("rejects zero proxyPort", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, proxyPort: 0 }),
      /proxyPort/
    );
  });

  it("rejects missing remnicDaemonUrl", () => {
    const { remnicDaemonUrl: _, ...rest } = validRaw;
    assert.throws(() => parseConfig(rest), /remnicDaemonUrl/);
  });

  it("rejects invalid sessionStrategy", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, sessionStrategy: "round-robin" }),
      /sessionStrategy.*must be one of/
    );
  });

  it("rejects invalid memoryInjection.position", () => {
    assert.throws(
      () =>
        parseConfig({
          ...validRaw,
          memoryInjection: { position: "middle" },
        }),
      /memoryInjection\.position.*must be one of/
    );
  });

  it("rejects non-object memoryInjection", () => {
    assert.throws(
      () => parseConfig({ ...validRaw, memoryInjection: "bad" }),
      /memoryInjection.*must be an object/
    );
  });

  it("rejects non-positive memoryInjection.maxTokens", () => {
    assert.throws(
      () =>
        parseConfig({
          ...validRaw,
          memoryInjection: { maxTokens: -1 },
        }),
      /maxTokens.*positive integer/
    );
  });

  it("rejects empty memoryInjection.template", () => {
    assert.throws(
      () =>
        parseConfig({
          ...validRaw,
          memoryInjection: { template: "" },
        }),
      /template.*non-empty string/
    );
  });
});
