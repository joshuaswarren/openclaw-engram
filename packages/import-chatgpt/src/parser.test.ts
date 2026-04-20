import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectUserTurnsFromConversation,
  parseChatGPTExport,
} from "./parser.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

describe("parseChatGPTExport", () => {
  it("reads the 2026 `memory` object shape", () => {
    const parsed = parseChatGPTExport(loadFixture("saved-memories-2026.json"));
    // Two active memories + one soft-deleted (skipped).
    assert.equal(parsed.savedMemories.length, 2);
    assert.equal(parsed.conversations.length, 0);
    assert.equal(parsed.savedMemories[0].id, "11111111-aaaa-4000-8000-000000000001");
    assert.equal(parsed.savedMemories[1].pinned, true);
    // Soft-deleted entry must not leak through.
    assert.ok(!parsed.savedMemories.some((m) => m.id?.endsWith("0003")));
  });

  it("reads the legacy array shape with mixed content/text fields", () => {
    const parsed = parseChatGPTExport(
      loadFixture("saved-memories-legacy-array.json"),
    );
    assert.equal(parsed.savedMemories.length, 2);
    assert.equal(
      parsed.savedMemories[1].content,
      "Fictional example: reviewed a paper on retrieval-augmented generation.",
    );
  });

  it("reads the conversations mapping shape", () => {
    const parsed = parseChatGPTExport(
      loadFixture("conversations-mapping.json"),
    );
    assert.equal(parsed.savedMemories.length, 0);
    assert.equal(parsed.conversations.length, 1);
    const [conv] = parsed.conversations;
    assert.equal(conv.id, "synthetic-conv-0001");
    const userTurns = collectUserTurnsFromConversation(conv);
    assert.equal(userTurns.length, 2);
    assert.equal(
      userTurns[0].content,
      "I want to build a synthetic weekend project.",
    );
    // createdAt is derived from the numeric create_time field → ISO.
    assert.ok(
      userTurns[0].createdAt &&
        /\d{4}-\d{2}-\d{2}T/.test(userTurns[0].createdAt),
    );
  });

  it("accepts already-parsed objects without double-parsing", () => {
    const obj = { memory: [{ id: "x", content: "hello" }] };
    const parsed = parseChatGPTExport(obj);
    assert.equal(parsed.savedMemories.length, 1);
    assert.equal(parsed.savedMemories[0].content, "hello");
  });

  it("skips entries missing content in non-strict mode", () => {
    const parsed = parseChatGPTExport({
      memory: [{ id: "x" }, { id: "y", content: "kept" }],
    });
    assert.equal(parsed.savedMemories.length, 1);
    assert.equal(parsed.savedMemories[0].content, "kept");
  });

  it("throws in strict mode on missing content", () => {
    assert.throws(() =>
      parseChatGPTExport(
        { memory: [{ id: "x" }] },
        { strict: true },
      ),
    );
  });

  it("throws on malformed JSON string input", () => {
    assert.throws(() => parseChatGPTExport("{not valid"));
  });

  it("distinguishes a top-level conversations array from a memories array", () => {
    const convArray = [
      {
        id: "c-1",
        mapping: {
          "m-1": {
            id: "m-1",
            message: {
              id: "m-1",
              author: { role: "user" },
              content: { parts: ["Hello"] },
              create_time: 1737763200,
            },
          },
        },
      },
    ];
    const parsed = parseChatGPTExport(convArray);
    assert.equal(parsed.conversations.length, 1);
    assert.equal(parsed.savedMemories.length, 0);
  });
});
