import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("runExtraction establishes thread context before persistExtraction", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  const processTurnIdx = source.indexOf("await this.threading.processTurn(lastTurn");
  const persistIdx = source.indexOf("await this.persistExtraction(result, storage)");

  assert.notEqual(processTurnIdx, -1, "expected runExtraction to call threading.processTurn");
  assert.notEqual(persistIdx, -1, "expected runExtraction to call persistExtraction");
  assert.ok(
    processTurnIdx < persistIdx,
    "threading.processTurn should run before persistExtraction so graph edge construction uses current thread context",
  );
});
