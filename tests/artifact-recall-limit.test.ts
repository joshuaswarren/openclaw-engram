import test from "node:test";
import assert from "node:assert/strict";
import { computeArtifactRecallLimit } from "../src/orchestrator.ts";

test("artifact recall limit is capped in minimal mode", () => {
  assert.equal(computeArtifactRecallLimit("minimal", 1, 5), 1);
  assert.equal(computeArtifactRecallLimit("minimal", 0, 5), 0);
  assert.equal(computeArtifactRecallLimit("minimal", 3, 2), 2);
});

test("artifact recall limit is unchanged outside minimal mode", () => {
  assert.equal(computeArtifactRecallLimit("full", 1, 5), 5);
  assert.equal(computeArtifactRecallLimit("graph_mode", 2, 4), 4);
});
