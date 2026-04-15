import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTurnFingerprint,
  codexLogicalSessionKey,
  extractCodexThreadId,
  isCodexProvider,
  resolveCodexSessionIdentity,
} from "./codex-compat.js";
import { parseConfig } from "./config.js";

test("isCodexProvider detects bundled Codex provider metadata", () => {
  assert.equal(
    isCodexProvider({
      provider: { id: "codex", name: "codex/gpt-5.4", model: "codex/gpt-5.4" },
    }),
    true,
  );
  assert.equal(
    isCodexProvider({
      provider: { name: "openai" },
      modelId: "codex/gpt-5.4",
    }),
    true,
  );
  assert.equal(
    isCodexProvider({
      providerThreadId: "thread-codex-1",
    }),
    true,
  );
  assert.equal(
    isCodexProvider({
      provider: { id: "openai", name: "gpt-5.4" },
      modelId: "gpt-5.4",
    }),
    false,
  );
});

test("extractCodexThreadId reads direct and nested provider thread ids", () => {
  assert.equal(
    extractCodexThreadId({ providerThreadId: "thread-direct" }),
    "thread-direct",
  );
  assert.equal(
    extractCodexThreadId({ provider: { thread: { id: "thread-nested" } } }),
    "thread-nested",
  );
  assert.equal(extractCodexThreadId({ provider: { id: "codex" } }), null);
});

test("resolveCodexSessionIdentity keeps non-Codex providers on raw session keys", () => {
  const cfg = parseConfig({});
  const identity = resolveCodexSessionIdentity({
    sessionKey: "session-a",
    ctx: {
      provider: { id: "openai", name: "gpt-5.4" },
      modelId: "gpt-5.4",
    },
    codexCompat: cfg.codexCompat,
  });

  assert.equal(identity.isCodex, false);
  assert.equal(identity.providerThreadId, null);
  assert.equal(identity.logicalSessionKey, "session-a");
});

test("resolveCodexSessionIdentity collapses Codex sessions onto provider thread ids", () => {
  const cfg = parseConfig({});
  const identity = resolveCodexSessionIdentity({
    sessionKey: "session-b",
    ctx: {
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-42",
      messageCount: 17,
    },
    codexCompat: cfg.codexCompat,
  });

  assert.equal(identity.isCodex, true);
  assert.equal(identity.providerThreadId, "thread-42");
  assert.equal(identity.logicalSessionKey, codexLogicalSessionKey("thread-42"));
  assert.equal(identity.messageCount, 17);
});

test("buildTurnFingerprint is stable for the same logical turn", () => {
  const left = buildTurnFingerprint({
    role: "assistant",
    content: "Memory saved.",
    logicalSessionKey: codexLogicalSessionKey("thread-9"),
    providerThreadId: "thread-9",
    messageCount: 12,
    turnIndex: 1,
  });
  const right = buildTurnFingerprint({
    role: "assistant",
    content: "Memory   saved.\n",
    logicalSessionKey: codexLogicalSessionKey("thread-9"),
    providerThreadId: "thread-9",
    messageCount: 12,
    turnIndex: 1,
  });

  assert.equal(left, right);
});
