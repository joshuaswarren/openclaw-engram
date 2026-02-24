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
