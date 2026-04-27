import assert from "node:assert/strict";
import test from "node:test";

import {
  __setSecretRefResolverForTest,
  clearAuthTokenSecretCache,
  isAgentAccessSecretRef,
  resolveAgentAccessAuthToken,
} from "./resolve-auth-token.js";

test("resolveAgentAccessAuthToken passes through plain strings", async () => {
  clearAuthTokenSecretCache();
  const result = await resolveAgentAccessAuthToken("plain-bearer-token");
  assert.equal(result, "plain-bearer-token");
});

test("resolveAgentAccessAuthToken trims surrounding whitespace", async () => {
  clearAuthTokenSecretCache();
  const result = await resolveAgentAccessAuthToken("  spaced-token  ");
  assert.equal(result, "spaced-token");
});

test("resolveAgentAccessAuthToken returns undefined for empty / undefined input", async () => {
  clearAuthTokenSecretCache();
  assert.equal(await resolveAgentAccessAuthToken(undefined), undefined);
  assert.equal(await resolveAgentAccessAuthToken(""), undefined);
  assert.equal(await resolveAgentAccessAuthToken("   "), undefined);
});

test("resolveAgentAccessAuthToken delegates SecretRef objects to gateway resolver", async () => {
  clearAuthTokenSecretCache();
  const calls: unknown[] = [];
  __setSecretRefResolverForTest(async (ref) => {
    calls.push(ref);
    return "resolved-secret-value";
  });

  try {
    const result = await resolveAgentAccessAuthToken({
      source: "exec",
      provider: "kc_openclaw_remnic_token",
      id: "value",
    });
    assert.equal(result, "resolved-secret-value");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      source: "exec",
      provider: "kc_openclaw_remnic_token",
      id: "value",
    });
  } finally {
    __setSecretRefResolverForTest(null);
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken caches resolved SecretRef values", async () => {
  clearAuthTokenSecretCache();
  let callCount = 0;
  __setSecretRefResolverForTest(async () => {
    callCount += 1;
    return "cached-token";
  });

  try {
    const ref = { source: "exec", provider: "kc_x", id: "value" };
    const first = await resolveAgentAccessAuthToken(ref);
    const second = await resolveAgentAccessAuthToken(ref);
    // Same shape but different object reference — should still hit cache
    const third = await resolveAgentAccessAuthToken({ ...ref });
    assert.equal(first, "cached-token");
    assert.equal(second, "cached-token");
    assert.equal(third, "cached-token");
    assert.equal(callCount, 1);
  } finally {
    __setSecretRefResolverForTest(null);
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken cache key is order-independent", async () => {
  clearAuthTokenSecretCache();
  let callCount = 0;
  __setSecretRefResolverForTest(async () => {
    callCount += 1;
    return "stable-token";
  });

  try {
    await resolveAgentAccessAuthToken({ source: "exec", provider: "p", id: "v" });
    await resolveAgentAccessAuthToken({ id: "v", provider: "p", source: "exec" });
    assert.equal(callCount, 1, "key sort should make order-permuted refs share a cache slot");
  } finally {
    __setSecretRefResolverForTest(null);
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken throws when gateway resolver is unavailable", async () => {
  clearAuthTokenSecretCache();
  __setSecretRefResolverForTest(null);

  await assert.rejects(
    () =>
      resolveAgentAccessAuthToken({
        source: "exec",
        provider: "kc_x",
        id: "value",
      }),
    /OpenClaw gateway secret resolver is not available|cannot resolve/i,
  );
});

test("resolveAgentAccessAuthToken throws on missing source field", async () => {
  clearAuthTokenSecretCache();
  await assert.rejects(
    () =>
      resolveAgentAccessAuthToken({
        provider: "no-source-field",
      } as unknown as Parameters<typeof resolveAgentAccessAuthToken>[0]),
    /missing required `source` field/,
  );
});

test("resolveAgentAccessAuthToken throws when SecretRef resolves to empty string", async () => {
  clearAuthTokenSecretCache();
  __setSecretRefResolverForTest(async () => "");
  try {
    await assert.rejects(
      () =>
        resolveAgentAccessAuthToken({
          source: "exec",
          provider: "kc_x",
          id: "value",
        }),
      /resolved to empty value/,
    );
  } finally {
    __setSecretRefResolverForTest(null);
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken surfaces resolver errors with context", async () => {
  clearAuthTokenSecretCache();
  __setSecretRefResolverForTest(async () => {
    throw new Error("keychain locked");
  });
  try {
    await assert.rejects(
      () =>
        resolveAgentAccessAuthToken({
          source: "exec",
          provider: "kc_x",
          id: "value",
        }),
      /failed to resolve.*SecretRef.*keychain locked/,
    );
  } finally {
    __setSecretRefResolverForTest(null);
    clearAuthTokenSecretCache();
  }
});

test("resolveAgentAccessAuthToken does not cache failed resolutions", async () => {
  clearAuthTokenSecretCache();
  let callCount = 0;
  __setSecretRefResolverForTest(async () => {
    callCount += 1;
    if (callCount === 1) throw new Error("transient");
    return "second-try-success";
  });
  try {
    const ref = { source: "exec", provider: "kc_x", id: "value" };
    await assert.rejects(() => resolveAgentAccessAuthToken(ref));
    const second = await resolveAgentAccessAuthToken(ref);
    assert.equal(second, "second-try-success");
    assert.equal(callCount, 2);
  } finally {
    __setSecretRefResolverForTest(null);
    clearAuthTokenSecretCache();
  }
});

test("isAgentAccessSecretRef recognizes SecretRef shapes", () => {
  assert.equal(isAgentAccessSecretRef({ source: "exec", provider: "x" }), true);
  assert.equal(isAgentAccessSecretRef({ source: "env" }), true);
  assert.equal(isAgentAccessSecretRef("plain-string"), false);
  assert.equal(isAgentAccessSecretRef(undefined), false);
  assert.equal(isAgentAccessSecretRef(null), false);
  assert.equal(isAgentAccessSecretRef({}), false);
  assert.equal(isAgentAccessSecretRef({ source: "" }), false);
  assert.equal(isAgentAccessSecretRef([1, 2, 3]), false);
});
