import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("ingestReplayBatch enqueues replay slices without clearing shared buffer", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  assert.match(
    source,
    /skipDedupeCheck:\s*true,\s*clearBufferAfterExtraction:\s*false,\s*skipCharThreshold:\s*true,/m,
    "replay ingestion should bypass dedupe/minimum thresholds and preserve the live smart buffer",
  );
  assert.match(
    source,
    /const settled = await Promise\.allSettled\(replayTasks\);[\s\S]*firstRejected[\s\S]*throw firstRejected\.reason;/m,
    "replay ingestion should drain all per-session tasks before surfacing a batch failure",
  );
});

test("queueBufferedExtraction preserves explicit false clearBufferAfterExtraction", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  assert.match(
    source,
    /clearBufferAfterExtraction:\s*options\.clearBufferAfterExtraction \?\? true,/m,
    "queue options should preserve explicit false clearBufferAfterExtraction values",
  );
});

test("runExtraction bypass only skips char threshold and still enforces user-turn threshold", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  assert.match(
    source,
    /const skipCharThreshold = options\.skipCharThreshold \?\? false;/m,
    "runExtraction should support explicit char-threshold bypass",
  );
  assert.match(
    source,
    /const belowCharThreshold = totalChars < this\.config\.extractionMinChars;\s*const belowUserTurnThreshold = userTurns\.length < this\.config\.extractionMinUserTurns;/m,
    "runExtraction should compute char and user-turn minimums independently",
  );
  assert.match(
    source,
    /if \(\(!skipCharThreshold && belowCharThreshold\) \|\| belowUserTurnThreshold\)/m,
    "user-turn threshold should always be enforced, even when char threshold bypass is enabled",
  );
});

test("queueBufferedExtraction settles task callbacks on dedupe skip", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  assert.match(
    source,
    /if \(!options\.skipDedupeCheck && !this\.shouldQueueExtraction\(turnsToExtract\)\) \{[\s\S]*options\.onTaskSettled\?\.\(\);[\s\S]*return;/m,
    "dedupe skip path should settle any task callback to avoid hanging replay promises",
  );
});
