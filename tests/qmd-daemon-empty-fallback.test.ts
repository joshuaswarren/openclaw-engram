import test from "node:test";
import assert from "node:assert/strict";
import { QmdClient } from "../src/qmd.ts";

test("search falls back to subprocess when daemon returns empty results", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.searchViaDaemon = async () => [];
  client.searchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [
      {
        docid: "fact-1",
        path: "/tmp/facts/fact-1.md",
        snippet: "hello",
        score: 0.9,
      },
    ];
  };

  const out = await client.search("heartbeat", undefined, 3);
  assert.equal(subprocessCalls, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.docid, "fact-1");
});

test("searchGlobal falls back to subprocess when daemon returns empty results", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.searchViaDaemon = async () => [];
  client.searchGlobalViaSubprocess = async () => {
    subprocessCalls += 1;
    return [
      {
        docid: "fact-2",
        path: "/tmp/facts/fact-2.md",
        snippet: "world",
        score: 0.8,
      },
    ];
  };

  const out = await client.searchGlobal("workspace context", 4);
  assert.equal(subprocessCalls, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.docid, "fact-2");
});

test("hybridSearch always runs bm25+vector merge (no daemon short-circuit)", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let bm25Calls = 0;
  let vectorCalls = 0;
  let daemonCalls = 0;
  client.searchViaDaemon = async () => {
    daemonCalls += 1;
    return [];
  };
  client.bm25Search = async () => {
    bm25Calls += 1;
    return [
      {
        docid: "fact-3",
        path: "/tmp/facts/fact-3.md",
        snippet: "bm25",
        score: 0.6,
      },
    ];
  };
  client.vectorSearch = async () => {
    vectorCalls += 1;
    return [
      {
        docid: "fact-3",
        path: "/tmp/facts/fact-3.md",
        snippet: "vector",
        score: 0.95,
      },
    ];
  };

  const out = await client.hybridSearch("query", undefined, 3);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.docid, "fact-3");
  assert.equal(out[0]?.score, 0.95);
  assert.equal(bm25Calls, 1);
  assert.equal(vectorCalls, 1);
  assert.equal(daemonCalls, 0);
});

test("bm25Search falls back to subprocess when daemon returns empty results", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let daemonCalls = 0;
  let subprocessCalls = 0;
  client.bm25SearchViaDaemon = async () => {
    daemonCalls += 1;
    return [];
  };
  client.bm25SearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [
      {
        docid: "fact-bm25-fallback",
        path: "/tmp/facts/fact-bm25-fallback.md",
        snippet: "fallback",
        score: 0.77,
      },
    ];
  };

  const out = await client.bm25Search("needle", undefined, 3);
  assert.equal(daemonCalls, 1);
  assert.equal(subprocessCalls, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.docid, "fact-bm25-fallback");
});

test("vectorSearch falls back to subprocess when daemon returns empty results", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let daemonCalls = 0;
  let subprocessCalls = 0;
  client.vsearchViaDaemon = async () => {
    daemonCalls += 1;
    return [];
  };
  client.vsearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [
      {
        docid: "fact-vsearch-fallback",
        path: "/tmp/facts/fact-vsearch-fallback.md",
        snippet: "fallback",
        score: 0.88,
      },
    ];
  };

  const out = await client.vectorSearch("needle", undefined, 3);
  assert.equal(daemonCalls, 1);
  assert.equal(subprocessCalls, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.docid, "fact-vsearch-fallback");
});

test("daemon parser uses path field when file is absent", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      structuredContent: {
        results: [
          {
            docid: "fact-daemon-path",
            path: "/tmp/facts/fact-daemon-path.md",
            snippet: "daemon path field",
            score: 0.91,
          },
        ],
      },
    }),
  };

  let subprocessCalls = 0;
  client.searchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [];
  };

  const out = await client.search("daemon parser path test", undefined, 3);
  assert.equal(subprocessCalls, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.path, "/tmp/facts/fact-daemon-path.md");
});
