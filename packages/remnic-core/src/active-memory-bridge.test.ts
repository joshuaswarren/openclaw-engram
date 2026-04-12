import assert from "node:assert/strict";
import test from "node:test";

import {
  getMemoryForActiveMemory,
  recallForActiveMemory,
} from "./active-memory-bridge.js";

test("recallForActiveMemory caps limit, truncates snippets, and strips internal scoring fields", async () => {
  const orchestrator = {
    resolveSelfNamespace: (_sessionKey?: string) => "resolved-namespace",
    searchAcrossNamespaces: async (_params: unknown) => [
      {
        id: "mem-1",
        score: 0.91,
        path: "/tmp/memory/default/facts/mem-1.md",
        snippet:
          "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
        raw_bm25: 9.2,
        raw_vector: 0.73,
        metadata: {
          type: "preference",
          topic: "style",
          updatedAt: "2026-04-12T10:00:00Z",
          sourceUri: "memory://mem-1",
        },
      },
    ],
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "writing style",
    limit: 1000,
    snippetMaxChars: 24,
    sessionKey: "session-a",
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.id, "mem-1");
  assert.equal(result.results[0]?.score, 0.91);
  assert.match(result.results[0]?.text ?? "", /^Alpha beta gamma delta/);
  assert.ok((result.results[0]?.text?.length ?? 0) <= 24);
  assert.deepEqual(result.results[0]?.metadata, {
    type: "preference",
    topic: "style",
    updatedAt: "2026-04-12T10:00:00Z",
    sourceUri: "memory://mem-1",
  });
  assert.ok(!("raw_bm25" in (result.results[0] as unknown as Record<string, unknown>)));
  assert.ok(!("raw_vector" in (result.results[0] as unknown as Record<string, unknown>)));
  assert.equal(result.truncated, false);
});

test("recallForActiveMemory defaults to the caller namespace derived from sessionKey", async () => {
  let receivedNamespaces: string[] | undefined;
  const orchestrator = {
    resolveSelfNamespace: (sessionKey?: string) =>
      sessionKey === "session-b" ? "session-b-namespace" : "fallback-namespace",
    searchAcrossNamespaces: async (params: { namespaces?: string[] }) => {
      receivedNamespaces = params.namespaces;
      return [];
    },
  };

  await recallForActiveMemory(orchestrator as never, {
    query: "api docs",
    sessionKey: "session-b",
  });

  assert.deepEqual(receivedNamespaces, ["session-b-namespace"]);
});

test("recallForActiveMemory prioritizes an explicit namespace filter over the session namespace", async () => {
  let receivedNamespaces: string[] | undefined;
  const orchestrator = {
    resolveSelfNamespace: () => "session-namespace",
    searchAcrossNamespaces: async (params: { namespaces?: string[] }) => {
      receivedNamespaces = params.namespaces;
      return [];
    },
  };

  await recallForActiveMemory(orchestrator as never, {
    query: "api docs",
    sessionKey: "session-b",
    filters: {
      namespace: "explicit-namespace",
    },
  });

  assert.deepEqual(receivedNamespaces, ["explicit-namespace"]);
});

test("recallForActiveMemory marks results truncated when the underlying recall exceeds the requested limit", async () => {
  const orchestrator = {
    resolveSelfNamespace: () => "session-namespace",
    searchAcrossNamespaces: async () =>
      Array.from({ length: 3 }, (_, index) => ({
        id: `mem-${index + 1}`,
        score: 0.9 - index * 0.1,
        path: `/tmp/memory/default/facts/mem-${index + 1}.md`,
        snippet: `memory ${index + 1}`,
      })),
  };

  const result = await recallForActiveMemory(orchestrator as never, {
    query: "project status",
    limit: 2,
    sessionKey: "session-b",
  });

  assert.equal(result.results.length, 2);
  assert.equal(result.truncated, true);
});

test("getMemoryForActiveMemory returns not_found instead of throwing", async () => {
  const orchestrator = {
    resolveSelfNamespace: () => "readable-session",
    getStorageForNamespace: async () => ({
      getMemoryById: async () => null,
    }),
  };

  const result = await getMemoryForActiveMemory(orchestrator as never, "missing");
  assert.deepEqual(result, { error: "not_found" });
});

test("getMemoryForActiveMemory reads via the session-derived namespace storage", async () => {
  let readNamespace: string | undefined;
  const orchestrator = {
    getStorageForNamespace: async (namespace: string) => {
      readNamespace = namespace;
      return {
        getMemoryById: async (id: string) =>
          id === "present" ? ({ content: "text", frontmatter: {} } as never) : null,
      };
    },
    resolveSelfNamespace: (sessionKey?: string) =>
      sessionKey === "session-x" ? "session-x-namespace" : "fallback-namespace",
  };

  const result = await getMemoryForActiveMemory(
    orchestrator as never,
    "present",
    { sessionKey: "session-x" },
  );

  assert.equal(readNamespace, "session-x-namespace");
  assert.equal(result.id, "present");
  assert.equal(result.text, "text");
});

test("getMemoryForActiveMemory honors an explicit namespace override", async () => {
  let readNamespace: string | undefined;
  const orchestrator = {
    getStorageForNamespace: async (namespace: string) => {
      readNamespace = namespace;
      return {
        getMemoryById: async (id: string) =>
          id === "shared-memory" ? ({ content: "shared text", frontmatter: {} } as never) : null,
      };
    },
    resolveSelfNamespace: () => "session-namespace",
  };

  const result = await getMemoryForActiveMemory(
    orchestrator as never,
    "shared-memory",
    { namespace: "shared" },
  );

  assert.equal(readNamespace, "shared");
  assert.equal(result.id, "shared-memory");
  assert.equal(result.text, "shared text");
});
