import assert from "node:assert/strict";
import test from "node:test";

import { buildMemoryGetTool } from "./memory-get-tool.js";

test("memory-get tool returns the active-memory bridge payload without markdown formatting", async () => {
  const tool = buildMemoryGetTool(
    {} as never,
    {
      getMemoryForActiveMemory: async () => ({
        id: "mem-2",
        text: "stable preference",
        metadata: { type: "preference", topic: "tone" },
      }),
    },
  );

  const result = await tool.execute("tc-memory-get", { id: "mem-2" });
  const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
    id?: string;
    text?: string;
    metadata?: { topic?: string };
  };

  assert.equal(payload.id, "mem-2");
  assert.equal(payload.text, "stable preference");
  assert.equal(payload.metadata?.topic, "tone");
});
