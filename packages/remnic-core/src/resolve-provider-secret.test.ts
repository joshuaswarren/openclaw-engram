import assert from "node:assert/strict";
import test from "node:test";

import {
  __findExecutableOnPathForTest,
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

test("findExecutableOnPath skips directories named like the executable", () => {
  const calls: string[] = [];
  const access = (candidate: string): void => {
    calls.push(candidate);
  };
  const stat = (candidate: string): { isFile(): boolean } => ({
    isFile: () => candidate === "/bin/openclaw",
  });
  const previousPath = process.env.PATH;

  try {
    process.env.PATH = ["/tmp", "/bin"].join(":");
    const resolved = __findExecutableOnPathForTest("openclaw", access, stat, 1);
    assert.equal(resolved, "/bin/openclaw");
    assert.deepEqual(calls, ["/tmp/openclaw", "/bin/openclaw"]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
