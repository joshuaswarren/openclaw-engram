import assert from "node:assert/strict";
import test from "node:test";

import { buildEvidencePack } from "./evidence-pack.js";

test("buildEvidencePack deduplicates evidence and stays within budget", () => {
  const pack = buildEvidencePack(
    [
      {
        sessionId: "s1",
        turnIndex: 1,
        role: "assistant",
        content: "The project deadline is Friday.",
      },
      {
        sessionId: "s1",
        turnIndex: 1,
        role: "assistant",
        content: "The project deadline is Friday.",
      },
      {
        sessionId: "s1",
        turnIndex: 2,
        role: "user",
        content: "Please remind me about the Friday deadline.",
      },
    ],
    { title: "Search evidence", maxChars: 180, maxItemChars: 80 },
  );

  assert.ok(pack.length <= 180);
  assert.match(pack, /^## Search evidence/);
  assert.equal(
    pack.match(/The project deadline is Friday\./g)?.length,
    1,
  );
  assert.match(pack, /\[s1, turn 2, user\]/);
});

test("buildEvidencePack returns empty text when no useful evidence fits", () => {
  assert.equal(
    buildEvidencePack(
      [{ sessionId: "s1", turnIndex: 1, role: "user", content: "   " }],
      { maxChars: 100 },
    ),
    "",
  );
  assert.equal(
    buildEvidencePack(
      [{ sessionId: "s1", turnIndex: 1, role: "user", content: "hello" }],
      { maxChars: 0 },
    ),
    "",
  );
});
