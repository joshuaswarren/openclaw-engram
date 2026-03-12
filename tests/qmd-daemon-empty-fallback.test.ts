import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
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

test("probe attempts daemon connectivity even when CLI probe fails", async () => {
  const client = new QmdClient("openclaw-engram", 5, { daemonUrl: "http://127.0.0.1:9020" }) as any;
  let cliCalls = 0;
  let daemonCalls = 0;
  client.probeCli = async () => {
    cliCalls += 1;
    client.available = false;
    return false;
  };
  client.probeDaemon = async () => {
    daemonCalls += 1;
    client.daemonAvailable = true;
    return true;
  };

  const ok = await client.probe();

  assert.equal(ok, true);
  assert.equal(cliCalls, 1);
  assert.equal(daemonCalls, 1);
  assert.equal(client.daemonAvailable, true);
});

test("embed retries with force re-embed after vector dimension mismatch", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  const calls: string[][] = [];
  client.runQmdCommand = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "embed" && args[1] === "-c") {
      throw new Error("vector dimension mismatch: vectors_vec expects float[3072]");
    }
    return { stdout: "", stderr: "" };
  };

  await client.embed();

  assert.deepEqual(calls, [
    ["embed", "-c", "openclaw-engram"],
    ["embed", "-f", "-c", "openclaw-engram"],
  ]);
});

test("embedCollection retries with force re-embed against the same collection", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  const calls: string[][] = [];
  client.runQmdCommand = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "embed" && args[1] === "-c") {
      throw new Error("vector dimension mismatch: vectors_vec expects float[3072]");
    }
    return { stdout: "", stderr: "" };
  };

  await client.embedCollection("shared-memory");

  assert.deepEqual(calls, [
    ["embed", "-c", "shared-memory"],
    ["embed", "-f", "-c", "shared-memory"],
  ]);
});

test("daemon request success removes abort listeners from the caller signal", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-daemon-cleanup-"));
  const daemonScriptPath = path.join(tmpDir, "fake-qmd-daemon.js");
  const scriptPath = path.join(tmpDir, "fake-qmd-daemon");
  await writeFile(
    daemonScriptPath,
    `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "fake-qmd", version: "1.0.0" }
      }
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { structuredContent: { results: [] } }
    }) + "\\n");
  }
});
`,
    "utf8",
  );
  await writeFile(
    scriptPath,
    `#!/bin/sh
exec "${process.execPath}" "${daemonScriptPath}" "$@"
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);

  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  const ok = await client.probeDaemon();
  assert.equal(ok, true);

  const controller = new AbortController();
  const daemonSession = client.daemonSession as any;
  const originalWrite = daemonSession.child.stdin.write.bind(daemonSession.child.stdin);
  daemonSession.child.stdin.write = (chunk: string, callback?: (err?: Error | null) => void) => {
    const message = JSON.parse(chunk.trim());
    if (message.method === "tools/call" && message.id) {
      setImmediate(() => {
        daemonSession.handleMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: { structuredContent: { results: [] } },
        });
      });
      callback?.(null);
      return true;
    }
    return originalWrite(chunk, callback);
  };
  const result = await daemonSession.callTool("query", { query: "cleanup", limit: 1 }, 1_000, controller.signal);

  assert.deepEqual(result, { structuredContent: { results: [] } });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  daemonSession.invalidate();
});

test("search aborts while waiting on the QMD mutex", { concurrency: false }, async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-abort-wait-"));
  const scriptPath = path.join(tmpDir, "fake-qmd");
  await writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
if [ "$1" = "query" ]; then
  sleep 2
  printf '[]'
  exit 0
fi
printf '[]'
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);

  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  client.available = true;
  client.daemonAvailable = false;
  client.maybeProbeDaemon = async () => {};

  const firstSearch = client.search("first", undefined, 3);
  const abortController = new AbortController();
  const startedAt = Date.now();
  const secondSearch = client.search("second", undefined, 3, undefined, { signal: abortController.signal });
  setTimeout(() => abortController.abort(), 50);

  await expectAbortError(
    () => secondSearch,
    "operation aborted while waiting for qmd mutex",
  );
  const elapsedMs = Date.now() - startedAt;
  await firstSearch;

  assert.ok(elapsedMs < 1000, `expected aborted search to resolve quickly, saw ${elapsedMs}ms`);
});

async function createSlowQmdScript(prefix: string): Promise<string> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const scriptPath = path.join(tmpDir, "fake-qmd");
  await writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
sleep 2
printf '[]'
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function expectAbortError(
  fn: () => Promise<unknown>,
  message?: string,
): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    return (
      err instanceof Error &&
      err.name === "AbortError" &&
      (typeof message !== "string" || err.message.includes(message))
    );
  });
}

test("search aborts during subprocess execution instead of returning an empty result", { concurrency: false }, async () => {
  const scriptPath = await createSlowQmdScript("engram-qmd-subprocess-search-abort-");
  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  client.available = true;
  client.daemonAvailable = false;
  client.maybeProbeDaemon = async () => {};

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await expectAbortError(
    () => client.search("search abort", undefined, 3, undefined, { signal: controller.signal }),
  );
});

test("searchGlobal aborts during subprocess execution instead of returning an empty result", { concurrency: false }, async () => {
  const scriptPath = await createSlowQmdScript("engram-qmd-subprocess-global-abort-");
  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  client.available = true;
  client.daemonAvailable = false;
  client.maybeProbeDaemon = async () => {};

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await expectAbortError(
    () => client.searchGlobal("global abort", 3, { signal: controller.signal }),
  );
});

test("bm25Search aborts during subprocess execution instead of returning an empty result", { concurrency: false }, async () => {
  const scriptPath = await createSlowQmdScript("engram-qmd-subprocess-bm25-abort-");
  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  client.available = true;
  client.daemonAvailable = false;
  client.maybeProbeDaemon = async () => {};

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await expectAbortError(
    () => client.bm25Search("bm25 abort", undefined, 3, { signal: controller.signal }),
  );
});

test("vectorSearch aborts during subprocess execution instead of returning an empty result", { concurrency: false }, async () => {
  const scriptPath = await createSlowQmdScript("engram-qmd-subprocess-vsearch-abort-");
  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  client.available = true;
  client.daemonAvailable = false;
  client.maybeProbeDaemon = async () => {};

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await expectAbortError(
    () => client.vectorSearch("vector abort", undefined, 3, { signal: controller.signal }),
  );
});

test("searchViaDaemon keeps daemon session active on AbortError", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  let invalidated = 0;
  const abortErr = new Error("request aborted by caller");
  Object.defineProperty(abortErr, "name", { value: "AbortError" });

  client.daemonAvailable = true;
  client.daemonSession = {
    callTool: async () => {
      throw abortErr;
    },
    invalidate: () => {
      invalidated += 1;
    },
  };

  await assert.rejects(
    client.searchViaDaemon("needle", "openclaw-engram", 3),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(invalidated, 0);
  assert.equal(client.daemonAvailable, true);
});

test("bm25SearchViaDaemon keeps daemon session active on caller cancellation", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  let invalidated = 0;
  const controller = new AbortController();
  controller.abort();

  client.daemonAvailable = true;
  client.daemonSession = {
    callTool: async () => {
      throw new Error("socket write failed");
    },
    invalidate: () => {
      invalidated += 1;
    },
  };

  await assert.rejects(
    client.bm25SearchViaDaemon("needle", "openclaw-engram", 3, controller.signal),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(invalidated, 0);
  assert.equal(client.daemonAvailable, true);
});

test("vsearchViaDaemon tolerates transient failures before invalidating daemon session", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  let invalidated = 0;

  client.daemonAvailable = true;
  client.daemonSession = {
    callTool: async () => {
      throw new Error("broken pipe");
    },
    invalidate: () => {
      invalidated += 1;
    },
  };

  // First failure is transient — daemon stays available
  const out1 = await client.vsearchViaDaemon("needle", "openclaw-engram", 3);
  assert.equal(out1, null);
  assert.equal(invalidated, 0);
  assert.equal(client.daemonAvailable, true);

  // Second consecutive failure triggers invalidation
  const out2 = await client.vsearchViaDaemon("needle", "openclaw-engram", 3);
  assert.equal(out2, null);
  assert.equal(invalidated, 1);
  assert.equal(client.daemonAvailable, false);
});

test("search rethrows daemon cancellation without subprocess fallback", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  const controller = new AbortController();
  controller.abort();
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.searchViaDaemon = async () => {
    throw new Error("daemon search cancelled");
  };
  client.searchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "unexpected", path: "/tmp/unexpected.md", snippet: "unexpected", score: 0.1 }];
  };

  await expectAbortError(
    () => client.search("cancelled", undefined, 3, undefined, { signal: controller.signal }),
    "QMD daemon search aborted",
  );
  assert.equal(subprocessCalls, 0);
});

test("bm25Search rethrows daemon cancellation without subprocess fallback", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  const controller = new AbortController();
  controller.abort();
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.bm25SearchViaDaemon = async () => {
    throw new Error("daemon bm25 cancelled");
  };
  client.bm25SearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "unexpected", path: "/tmp/unexpected.md", snippet: "unexpected", score: 0.1 }];
  };

  await expectAbortError(
    () => client.bm25Search("cancelled", undefined, 3, { signal: controller.signal }),
    "QMD daemon bm25 aborted",
  );
  assert.equal(subprocessCalls, 0);
});

test("vectorSearch rethrows daemon cancellation without subprocess fallback", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  const controller = new AbortController();
  controller.abort();
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.vsearchViaDaemon = async () => {
    throw new Error("daemon vsearch cancelled");
  };
  client.vsearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "unexpected", path: "/tmp/unexpected.md", snippet: "unexpected", score: 0.1 }];
  };

  await expectAbortError(
    () => client.vectorSearch("cancelled", undefined, 3, { signal: controller.signal }),
    "QMD daemon vsearch aborted",
  );
  assert.equal(subprocessCalls, 0);
});

test("search falls back when daemon reports cancelled text without caller abort", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  let invalidated = 0;
  client.daemonSession = {
    callTool: async () => {
      throw new Error("daemon search cancelled by internal restart");
    },
    invalidate: () => {
      invalidated += 1;
    },
  };
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.searchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "fallback", path: "/tmp/fallback.md", snippet: "fallback", score: 0.4 }];
  };

  const out = await client.search("cancelled", undefined, 3);
  assert.deepEqual(out, [{ docid: "fallback", path: "/tmp/fallback.md", snippet: "fallback", score: 0.4 }]);
  assert.equal(subprocessCalls, 1);
  // First transient failure doesn't invalidate — daemon stays available for retry
  assert.equal(invalidated, 0);
});

test("bm25Search falls back when daemon reports cancelled text without caller abort", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  let invalidated = 0;
  client.daemonSession = {
    callTool: async () => {
      throw new Error("daemon bm25 cancelled by internal restart");
    },
    invalidate: () => {
      invalidated += 1;
    },
  };
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.bm25SearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "fallback", path: "/tmp/fallback.md", snippet: "fallback", score: 0.4 }];
  };

  const out = await client.bm25Search("cancelled", undefined, 3);
  assert.deepEqual(out, [{ docid: "fallback", path: "/tmp/fallback.md", snippet: "fallback", score: 0.4 }]);
  assert.equal(subprocessCalls, 1);
  // First transient failure doesn't invalidate — daemon stays available for retry
  assert.equal(invalidated, 0);
});

test("vectorSearch falls back when daemon reports cancelled text without caller abort", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  let invalidated = 0;
  client.daemonSession = {
    callTool: async () => {
      throw new Error("daemon vsearch cancelled by internal restart");
    },
    invalidate: () => {
      invalidated += 1;
    },
  };
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.vsearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "fallback", path: "/tmp/fallback.md", snippet: "fallback", score: 0.4 }];
  };

  const out = await client.vectorSearch("cancelled", undefined, 3);
  assert.deepEqual(out, [{ docid: "fallback", path: "/tmp/fallback.md", snippet: "fallback", score: 0.4 }]);
  assert.equal(subprocessCalls, 1);
  // First transient failure doesn't invalidate — daemon stays available for retry
  assert.equal(invalidated, 0);
});
