import test from "node:test";
import assert from "node:assert/strict";
import { EngramAccessInputError, EngramAccessService } from "../src/access-service.js";

function createService() {
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async () => "ctx",
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  };
  return new EngramAccessService(orchestrator as any);
}

test("access service rejects empty recall queries as input errors", async () => {
  const service = createService();
  await assert.rejects(
    () => service.recall({ query: "   " }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      err.message === "query is required",
  );
});

test("access service rejects unsupported namespace-scoped recall", async () => {
  const service = createService();
  await assert.rejects(
    () => service.recall({ query: "hello", namespace: "project-x" }),
    (err: unknown) =>
      err instanceof EngramAccessInputError &&
      /namespace-scoped recall is not implemented/.test(err.message),
  );
});
