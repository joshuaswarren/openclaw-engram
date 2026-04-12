import assert from "node:assert/strict";
import test from "node:test";

import { buildMemoryGetTool } from "./memory-get-tool.js";

test("memory-get tool returns the active-memory bridge payload without markdown formatting", async () => {
  let sessionKeyFromTool: string | null = null;
  const tool = buildMemoryGetTool(
    {} as never,
    {
      getMemoryForActiveMemory: async (_orchestrator, _id, options) => {
        sessionKeyFromTool = options?.sessionKey ?? null;
        return {
          id: "mem-2",
          text: "stable preference",
          metadata: { type: "preference", topic: "tone" },
        };
      },
    },
  );

  const result = await tool.execute("tc-memory-get", { id: "mem-2" });
  assert.equal(sessionKeyFromTool, "default");
  const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
    id?: string;
    text?: string;
    metadata?: { topic?: string };
  };

  assert.equal(payload.id, "mem-2");
  assert.equal(payload.text, "stable preference");
  assert.equal(payload.metadata?.topic, "tone");
});

test("memory-get tool resolves session key from params and context", async () => {
  let sessionKeyFromTool: string | null = null;
  let namespaceFromTool: string | null = null;

  const tool = buildMemoryGetTool(
    {} as never,
    {
      getMemoryForActiveMemory: async (_orchestrator, id, options) => {
        sessionKeyFromTool = options?.sessionKey ?? null;
        namespaceFromTool = options?.namespace ?? null;
        return {
          id,
          text: `${id} contextual preference`,
          metadata: { type: "preference", topic: "tone" },
        };
      },
    },
  );

  const result = await tool.execute(
    "tc-memory-get",
    { id: "mem-3", namespace: "shared", sessionKey: "param-session" },
    undefined,
    { sessionKey: "ctx-session" },
  );

  assert.equal(sessionKeyFromTool, "param-session");
  assert.equal(namespaceFromTool, "shared");
  const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
    id?: string;
    text?: string;
  };
  assert.equal(payload.id, "mem-3");
  assert.equal(payload.text, "mem-3 contextual preference");

  const fallbackResult = await tool.execute(
    "tc-memory-get-ctx",
    { id: "mem-4" },
    undefined,
    { sessionKey: "ctx-session" },
  );

  assert.equal(sessionKeyFromTool, "ctx-session");
  assert.equal(namespaceFromTool, null);
  const fallbackPayload = JSON.parse(fallbackResult.content[0]?.text ?? "{}") as {
    id?: string;
    text?: string;
  };
  assert.equal(fallbackPayload.id, "mem-4");
  assert.equal(fallbackPayload.text, "mem-4 contextual preference");
});
