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
});
