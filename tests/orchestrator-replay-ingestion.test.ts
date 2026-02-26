import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("ingestReplayBatch enqueues replay slices without clearing shared buffer", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  assert.match(
    source,
    /skipDedupeCheck:\s*true,\s*clearBufferAfterExtraction:\s*false,\s*skipMinimumThresholds:\s*true,/m,
    "replay ingestion should bypass dedupe/minimum thresholds and preserve the live smart buffer",
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

test("runExtraction only applies minimum thresholds when enabled", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");

  assert.match(
    source,
    /const skipMinimumThresholds = options\.skipMinimumThresholds \?\? false;/m,
    "runExtraction should support explicit minimum-threshold bypass",
  );
  assert.match(
    source,
    /if \(\s*!skipMinimumThresholds[\s\S]*totalChars < this\.config\.extractionMinChars[\s\S]*!skipMinimumThresholds[\s\S]*userTurns\.length < this\.config\.extractionMinUserTurns/m,
    "minimum thresholds should be gated by skipMinimumThresholds",
  );
});
