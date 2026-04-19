import assert from "node:assert/strict";
import test from "node:test";

import {
  __setGatewayResolverForTest,
  clearSecretCache,
  resolveProviderApiKey,
} from "./resolve-provider-secret.js";

test("resolveProviderApiKey scopes cached gateway secrets by agent directory", async () => {
  clearSecretCache();

  const calls: string[] = [];
  __setGatewayResolverForTest(async ({ agentDir }) => {
    calls.push(String(agentDir));
    return { apiKey: `key:${agentDir}` };
  });

  try {
    const first = await resolveProviderApiKey(
      "openai",
      "secretref-managed",
      {},
      "/tmp/openclaw-profile-a/agent",
    );
    const second = await resolveProviderApiKey(
      "openai",
      "secretref-managed",
      {},
      "/tmp/openclaw-profile-b/agent",
    );
    const repeatFirst = await resolveProviderApiKey(
      "openai",
      "secretref-managed",
      {},
      "/tmp/openclaw-profile-a/agent",
    );

    assert.equal(first, "key:/tmp/openclaw-profile-a/agent");
    assert.equal(second, "key:/tmp/openclaw-profile-b/agent");
    assert.equal(repeatFirst, first);
    assert.deepEqual(calls, [
      "/tmp/openclaw-profile-a/agent",
      "/tmp/openclaw-profile-b/agent",
    ]);
  } finally {
    clearSecretCache();
  }
});
