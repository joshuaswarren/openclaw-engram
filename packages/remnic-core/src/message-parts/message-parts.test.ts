import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseAnthropicMessageParts,
  parseMessageParts,
  parseOpenAiMessageParts,
} from "./index.js";

describe("message-parts parsers", () => {
  it("extracts OpenAI Responses function calls and file paths", () => {
    const parts = parseOpenAiMessageParts({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Updated src/auth.ts" }],
        },
        {
          type: "function_call",
          name: "apply_patch",
          arguments: JSON.stringify({
            patch: "*** Begin Patch\n*** Update File: src/auth.ts\n*** End Patch",
          }),
        },
      ],
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/auth.ts");
    assert.equal(parts[1]!.kind, "patch");
    assert.equal(parts[1]!.toolName, "apply_patch");
    assert.equal(parts[1]!.filePath, "src/auth.ts");
  });

  it("infers OpenAI single message objects before generic content arrays", () => {
    const parts = parseMessageParts({
      type: "message",
      content: [{ type: "output_text", text: "Read src/config.ts" }],
    });

    assert.equal(parts.length, 1);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/config.ts");
  });

  it("infers top-level OpenAI response item arrays before Anthropic arrays", () => {
    const parts = parseMessageParts([
      {
        type: "message",
        content: [{ type: "output_text", text: "Updated src/router.ts" }],
      },
      {
        type: "function_call",
        name: "apply_patch",
        arguments: JSON.stringify({
          patch: "*** Begin Patch\n*** Update File: src/router.ts\n*** End Patch",
        }),
      },
    ]);

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/router.ts");
    assert.equal(parts[1]!.kind, "patch");
    assert.equal(parts[1]!.toolName, "apply_patch");
  });

  it("parses top-level OpenAI content-block arrays", () => {
    const parts = parseMessageParts(
      [
        { type: "output_text", text: "Updated src/auth.ts." },
        { type: "output_text", text: "Read src/session.ts" },
      ],
      { sourceFormat: "openai" },
    );

    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, "text");
    assert.equal(parts[0]!.filePath, "src/auth.ts");
    assert.equal(parts[1]!.filePath, "src/session.ts");
  });

  it("extracts Anthropic tool_use blocks as structured file writes", () => {
    const parts = parseAnthropicMessageParts({
      content: [
        { type: "text", text: "I will edit packages/core/src/config.ts" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Edit",
          input: { path: "packages/core/src/config.ts", old_string: "a", new_string: "b" },
        },
      ],
    });

    assert.equal(parts.length, 2);
    assert.equal(parts[1]!.kind, "file_write");
    assert.equal(parts[1]!.filePath, "packages/core/src/config.ts");
  });

  it("normalizes explicit Remnic parts and redacts secrets", () => {
    const parts = parseMessageParts({
      parts: [
        {
          kind: "tool_call",
          tool_name: "fetch",
          payload: { authorization: "Bearer abc", url: "https://example.test" },
        },
      ],
    });

    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0]!.payload, {
      authorization: "[redacted]",
      url: "https://example.test",
    });
  });
});
