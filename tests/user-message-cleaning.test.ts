import test from "node:test";
import assert from "node:assert/strict";
import { cleanUserMessage } from "../src/user-message-cleaning.js";

test("cleanUserMessage removes legacy and remnic memory context headers", () => {
  const remnicPayload = [
    "Before",
    "## Memory Context (Remnic)",
    "",
    "Remember this",
    "",
    "## Next Section",
    "After",
  ].join("\n");
  const engramPayload = [
    "Before",
    "## Memory Context (Engram)",
    "",
    "Remember this",
    "",
    "## Next Section",
    "After",
  ].join("\n");

  const cleanedRemnic = cleanUserMessage(remnicPayload);
  const cleanedEngram = cleanUserMessage(engramPayload);

  assert.equal(cleanedRemnic.includes("Memory Context (Remnic)"), false);
  assert.equal(cleanedEngram.includes("Memory Context (Engram)"), false);
  assert.equal(cleanedRemnic.includes("Remember this"), false);
  assert.equal(cleanedEngram.includes("Remember this"), false);
  assert.equal(cleanedRemnic.includes("## Next Section\nAfter"), true);
  assert.equal(cleanedEngram.includes("## Next Section\nAfter"), true);
});
