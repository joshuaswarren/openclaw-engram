import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchAllMem0Memories } from "./client.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

interface RecordedPage {
  request: { method: string; url: string };
  results?: unknown[];
  next?: string | null;
}

function loadRecording(name: string): RecordedPage[] {
  const raw = JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf-8"));
  return raw.pages as RecordedPage[];
}

function makeReplayFetch(pages: RecordedPage[]): typeof fetch {
  const byUrl = new Map<string, RecordedPage>();
  for (const p of pages) byUrl.set(p.request.url, p);
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const match = byUrl.get(url);
    if (!match) {
      return new Response(`no recording for ${url}`, { status: 404 });
    }
    return new Response(
      JSON.stringify({ results: match.results ?? [], next: match.next ?? null }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    // init parameter intentionally ignored in replay mode
    void init;
  }) as typeof fetch;
}

describe("fetchAllMem0Memories (record/replay)", () => {
  it("walks paginated responses until next is null", async () => {
    const pages = loadRecording("two-page-recording.json");
    const memories = await fetchAllMem0Memories({
      apiKey: "synthetic-key",
      baseUrl: "https://api.mem0.test",
      fetchImpl: makeReplayFetch(pages),
    });
    assert.equal(memories.length, 3);
    assert.equal(memories[0]?.id, "mem-syn-0001");
    assert.equal(memories[2]?.id, "mem-syn-0003");
  });

  it("throws a helpful error when apiKey is missing", async () => {
    await assert.rejects(
      () =>
        fetchAllMem0Memories({
          apiKey: "",
          fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
        }),
      /non-empty apiKey/,
    );
  });

  it("propagates HTTP error responses", async () => {
    const failingFetch = (async () =>
      new Response("unauthorized", { status: 401 })) as typeof fetch;
    await assert.rejects(
      () =>
        fetchAllMem0Memories({
          apiKey: "bad-key",
          baseUrl: "https://api.mem0.test",
          fetchImpl: failingFetch,
        }),
      /failed with 401/,
    );
  });

  it("honors rateLimit by sleeping between pages", async () => {
    const pages = loadRecording("two-page-recording.json");
    const sleeps: number[] = [];
    await fetchAllMem0Memories({
      apiKey: "synthetic-key",
      baseUrl: "https://api.mem0.test",
      fetchImpl: makeReplayFetch(pages),
      rateLimit: 2, // 500ms interval
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    // Two pages fetched → exactly one sleep between them.
    assert.equal(sleeps.length, 1);
    assert.equal(sleeps[0], 500);
  });

  it("does not sleep when rateLimit is unset", async () => {
    const pages = loadRecording("two-page-recording.json");
    const sleeps: number[] = [];
    await fetchAllMem0Memories({
      apiKey: "synthetic-key",
      baseUrl: "https://api.mem0.test",
      fetchImpl: makeReplayFetch(pages),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(sleeps.length, 0);
  });

  it("aborts when the signal fires", async () => {
    const pages = loadRecording("two-page-recording.json");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        fetchAllMem0Memories({
          apiKey: "synthetic-key",
          baseUrl: "https://api.mem0.test",
          fetchImpl: makeReplayFetch(pages),
          signal: controller.signal,
        }),
      /aborted/,
    );
  });

  // Cursor review on PR #602 — pagination must keep walking when the
  // server returns numeric page metadata without a `next` cursor.
  it("falls back to page-number pagination when next cursor is absent", async () => {
    let called = 0;
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      called += 1;
      if (!url.includes("page=")) {
        // Page 1: returns `page`+`total`+`per_page`, no `next`.
        return new Response(
          JSON.stringify({
            results: [
              { id: "p1-a", memory: "page 1 item a" },
              { id: "p1-b", memory: "page 1 item b" },
            ],
            page: 1,
            per_page: 2,
            total: 3,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Page 2: reaches the end.
      return new Response(
        JSON.stringify({
          results: [{ id: "p2-a", memory: "page 2 item" }],
          page: 2,
          per_page: 2,
          total: 3,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const memories = await fetchAllMem0Memories({
      apiKey: "synthetic-key",
      baseUrl: "https://api.mem0.test",
      fetchImpl,
    });
    assert.equal(called, 2);
    assert.equal(memories.length, 3);
    assert.deepEqual(
      memories.map((m) => m.id),
      ["p1-a", "p1-b", "p2-a"],
    );
  });

  it("does not infinite-loop when page metadata is missing entirely", async () => {
    // No `next`, no `total` → must stop after the first page.
    const fetchImpl = (async (): Promise<Response> =>
      new Response(JSON.stringify({ results: [{ id: "only", memory: "x" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const memories = await fetchAllMem0Memories({
      apiKey: "synthetic-key",
      baseUrl: "https://api.mem0.test",
      fetchImpl,
    });
    assert.equal(memories.length, 1);
  });

  // Cursor review on PR #602 — explicit `next: null` must stop pagination
  // even when numeric pagination fields are present. The original code
  // fell through to the numeric-fallback path because it only checked for
  // `typeof next === "string"`, conflating null with undefined.
  it("treats explicit next:null as authoritative stop even with numeric fields", async () => {
    let called = 0;
    const fetchImpl = (async (): Promise<Response> => {
      called += 1;
      return new Response(
        JSON.stringify({
          results: [{ id: "only", memory: "hello" }],
          next: null,
          // Numeric fields that would normally trigger the fallback:
          page: 1,
          per_page: 1,
          total: 9999,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const memories = await fetchAllMem0Memories({
      apiKey: "synthetic-key",
      baseUrl: "https://api.mem0.test",
      fetchImpl,
    });
    // Exactly one request — we must NOT follow numeric pagination when
    // next is explicitly null.
    assert.equal(called, 1);
    assert.equal(memories.length, 1);
  });

  // Codex review on PR #602 — cross-origin cursors must not be followed
  // because the loop would forward the mem0 API key to that host.
  it("rejects cross-origin pagination cursors without leaking the API key", async () => {
    const seenRequests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      seenRequests.push(url);
      if (seenRequests.length === 1) {
        return new Response(
          JSON.stringify({
            results: [{ id: "p1", memory: "page 1" }],
            next: "https://attacker.example/steal?token=1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error("request after cross-origin cursor must not happen");
    }) as typeof fetch;
    await assert.rejects(
      () =>
        fetchAllMem0Memories({
          apiKey: "synthetic-key",
          baseUrl: "https://api.mem0.test",
          fetchImpl,
        }),
      /cross-origin/,
    );
    assert.equal(seenRequests.length, 1, "must not fetch the cross-origin cursor");
  });

  it("follows relative pagination cursors by resolving them against the base URL", async () => {
    let called = 0;
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      called += 1;
      if (called === 1) {
        return new Response(
          JSON.stringify({
            results: [{ id: "p1", memory: "first" }],
            next: "/v1/memories/?cursor=xyz", // relative!
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      assert.ok(
        url.startsWith("https://api.mem0.test/v1/memories/?cursor=xyz"),
        `expected resolved URL, got: ${url}`,
      );
      return new Response(
        JSON.stringify({ results: [{ id: "p2", memory: "second" }], next: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const memories = await fetchAllMem0Memories({
      apiKey: "synthetic-key",
      baseUrl: "https://api.mem0.test",
      fetchImpl,
    });
    assert.equal(memories.length, 2);
  });

  // Codex review on PR #602 — self-hosted mem0-oss exposes `/memories/`
  // without the `/v1` prefix. Let operators override via listPath.
  it("honors a custom listPath for self-hosted deployments", async () => {
    let firstRequestUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      if (!firstRequestUrl) firstRequestUrl = url;
      return new Response(JSON.stringify({ results: [], next: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await fetchAllMem0Memories({
      apiKey: "synthetic-key",
      baseUrl: "https://self-hosted.mem0.test",
      listPath: "/memories/",
      fetchImpl,
    });
    assert.equal(firstRequestUrl, "https://self-hosted.mem0.test/memories/");
  });
});
