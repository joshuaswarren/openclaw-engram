import assert from "node:assert/strict";
import test from "node:test";

import { buildMemorySearchTool } from "./memory-search-tool.js";

test("memory-search tool uses ctx session key and returns a structured JSON payload", async () => {
  let received: Record<string, unknown> | null = null;
  const tool = buildMemorySearchTool(
    {} as never,
    {
      snippetMaxChars: 120,
      recallForActiveMemory: async (_orchestrator, params) => {
        received = params as Record<string, unknown>;
        return {
          results: [
            {
              id: "mem-1",
              score: 0.9,
              text: "preference snippet",
              metadata: { type: "preference" },
            },
          ],
          truncated: false,
        };
      },
    },
  );

  const result = await tool.execute(
    "tc-memory-search",
    { query: "preferences", limit: 3 },
    undefined,
    { sessionKey: "ctx-session" },
  );

  assert.deepEqual(received, {
    query: "preferences",
    limit: 3,
    filters: undefined,
    sessionKey: "ctx-session",
    snippetMaxChars: 120,
  });

  const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
    results: Array<{ id: string }>;
    truncated: boolean;
  };
  assert.equal(payload.results[0]?.id, "mem-1");
  assert.equal(payload.truncated, false);
});
