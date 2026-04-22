import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { parseRetryAfterMs, retryFetch } from "./retry-fetch.ts";

function mockFetchSequence(responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  const calls: Array<{ url: string; attempt: number }> = [];

  globalThis.fetch = async (_url, _init) => {
    const resp = responses[Math.min(callIndex, responses.length - 1)];
    calls.push({ url: String(_url), attempt: callIndex + 1 });
    callIndex += 1;
    return new Response(resp.body ?? "ok", {
      status: resp.status,
      headers: resp.headers ?? {},
    });
  };

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("parseRetryAfterMs parses integer seconds", () => {
  assert.equal(parseRetryAfterMs("30"), 30_000);
  assert.equal(parseRetryAfterMs("0"), 0);
  assert.equal(parseRetryAfterMs("-5"), undefined);
});

test("parseRetryAfterMs caps at MAX_RETRY_AFTER_S", () => {
  assert.equal(parseRetryAfterMs("9999"), 600_000);
});

test("parseRetryAfterMs returns undefined for null/empty", () => {
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs(""), undefined);
});

test("parseRetryAfterMs returns undefined for garbage", () => {
  assert.equal(parseRetryAfterMs("not-a-date"), undefined);
});

test("retryFetch retries on 429 with Retry-After header", async () => {
  const mock = mockFetchSequence([
    { status: 429, headers: { "retry-after": "0" } },
    { status: 200, body: "success" },
  ]);
  try {
    const response = await retryFetch(
      "https://example.com/api",
      { method: "GET" },
      { maxAttempts: 3, baseBackoffMs: 1, timeoutMs: 5000 },
    );
    assert.equal(response.status, 200);
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test("retryFetch retries on 429 without Retry-After using exponential backoff", async () => {
  const mock = mockFetchSequence([
    { status: 429 },
    { status: 200, body: "ok" },
  ]);
  try {
    const response = await retryFetch(
      "https://example.com/api",
      { method: "GET" },
      { maxAttempts: 3, baseBackoffMs: 1, timeoutMs: 5000 },
    );
    assert.equal(response.status, 200);
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test("retryFetch returns 429 response when all retries exhausted", async () => {
  const mock = mockFetchSequence([
    { status: 429 },
    { status: 429 },
    { status: 429 },
  ]);
  try {
    const response = await retryFetch(
      "https://example.com/api",
      { method: "GET" },
      { maxAttempts: 3, baseBackoffMs: 1, timeoutMs: 5000 },
    );
    assert.equal(response.status, 429);
    assert.equal(mock.calls.length, 3);
  } finally {
    mock.restore();
  }
});

test("retryFetch does not retry on 401", async () => {
  const mock = mockFetchSequence([
    { status: 401 },
  ]);
  try {
    const response = await retryFetch(
      "https://example.com/api",
      { method: "GET" },
      { maxAttempts: 3, baseBackoffMs: 1, timeoutMs: 5000 },
    );
    assert.equal(response.status, 401);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("retryFetch does not retry on 400", async () => {
  const mock = mockFetchSequence([{ status: 400 }]);
  try {
    const response = await retryFetch(
      "https://example.com/api",
      { method: "GET" },
      { maxAttempts: 3, baseBackoffMs: 1, timeoutMs: 5000 },
    );
    assert.equal(response.status, 400);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("retryFetch does not retry on 3xx redirect", async () => {
  const mock = mockFetchSequence([{ status: 302 }]);
  try {
    const response = await retryFetch(
      "https://example.com/api",
      { method: "GET" },
      { maxAttempts: 3, baseBackoffMs: 1, timeoutMs: 5000 },
    );
    assert.equal(response.status, 302);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});
