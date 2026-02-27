import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type * as childProcess from "node:child_process";
import {
  FaissAdapterError,
  FaissConversationIndexAdapter,
  type FaissAdapterConfig,
} from "../src/conversation-index/faiss-adapter.js";
import { upsertConversationChunksFailOpen } from "../src/conversation-index/indexer.js";
import { searchConversationIndexFaissFailOpen } from "../src/conversation-index/search.js";
import type { ConversationChunk } from "../src/conversation-index/chunker.js";

class FakeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  readonly stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
      return true;
    },
    end: () => {},
  };
  killSignal: string | null = null;

  kill(signal: string) {
    this.killSignal = signal;
    this.emit("close", null, signal);
    return true;
  }
}

function baseConfig(spawnFn?: typeof childProcess.spawn): FaissAdapterConfig {
  return {
    memoryDir: "/tmp/memory",
    scriptPath: "/tmp/faiss_index.py",
    pythonBin: "python3.11",
    modelId: "text-embedding-3-small",
    indexDir: "state/conversation-index/faiss",
    upsertTimeoutMs: 500,
    searchTimeoutMs: 500,
    healthTimeoutMs: 500,
    maxBatchSize: 10,
    maxSearchK: 10,
    spawnFn,
  };
}

function sampleChunks(): ConversationChunk[] {
  return [
    {
      id: "chunk-1",
      sessionKey: "session-A",
      startTs: "2026-02-27T00:00:00.000Z",
      endTs: "2026-02-27T00:01:00.000Z",
      text: "hello world",
    },
  ];
}

test("faiss adapter upsertChunks success path parses JSON output", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stdout.emit("data", JSON.stringify({ ok: true, upserted: 1 }));
      proc.emit("close", 0);
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  const upserted = await adapter.upsertChunks(sampleChunks());
  assert.equal(upserted, 1);

  const payload = JSON.parse(proc.stdinWrites.join(""));
  assert.equal(payload.modelId, "text-embedding-3-small");
  assert.equal(payload.chunks.length, 1);
});

test("faiss adapter searchChunks returns typed results", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stdout.emit(
        "data",
        JSON.stringify({
          ok: true,
          results: [{ path: "/a.md", snippet: "hi", score: 0.9 }],
        }),
      );
      proc.emit("close", 0);
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  const results = await adapter.searchChunks("query", 3);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.path, "/a.md");
  assert.equal(results[0]?.score, 0.9);
});

test("faiss adapter throws timeout error and kills process", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => proc as unknown as childProcess.ChildProcess;

  const adapter = new FaissConversationIndexAdapter({
    ...baseConfig(spawnFn),
    healthTimeoutMs: 10,
  });

  await assert.rejects(async () => {
    await adapter.health();
  }, (err: unknown) => {
    assert.ok(err instanceof FaissAdapterError);
    assert.equal(err.code, "timeout");
    return true;
  });
  assert.equal(proc.killSignal, "SIGKILL");
});

test("faiss adapter throws non-zero exit with stderr context", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stderr.emit("data", "boom");
      proc.emit("close", 7);
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  await assert.rejects(async () => {
    await adapter.health();
  }, (err: unknown) => {
    assert.ok(err instanceof FaissAdapterError);
    assert.equal(err.code, "non_zero_exit");
    assert.match(err.message, /boom/);
    return true;
  });
});

test("faiss adapter throws malformed output when JSON parse fails", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stdout.emit("data", "not-json");
      proc.emit("close", 0);
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  await assert.rejects(async () => {
    await adapter.health();
  }, (err: unknown) => {
    assert.ok(err instanceof FaissAdapterError);
    assert.equal(err.code, "malformed_output");
    return true;
  });
});

test("fail-open wrappers return safe defaults on adapter errors", async () => {
  const throwingAdapter = {
    async upsertChunks() {
      throw new Error("upsert broke");
    },
    async searchChunks() {
      throw new Error("search broke");
    },
  } as unknown as FaissConversationIndexAdapter;

  const upsertResult = await upsertConversationChunksFailOpen(throwingAdapter, sampleChunks());
  assert.equal(upsertResult.skipped, true);
  assert.equal(upsertResult.reason, "adapter-error");

  const searchResults = await searchConversationIndexFaissFailOpen(throwingAdapter, "query", 3);
  assert.deepEqual(searchResults, []);

  const unavailable = await upsertConversationChunksFailOpen(undefined, sampleChunks());
  assert.equal(unavailable.reason, "adapter-unavailable");
});
