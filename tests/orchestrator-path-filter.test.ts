import test from "node:test";
import assert from "node:assert/strict";
import { isArtifactMemoryPath } from "../src/orchestrator.ts";

test("isArtifactMemoryPath matches artifact directory paths", () => {
  assert.equal(isArtifactMemoryPath("/tmp/memory/artifacts/2026-02-21/a.md"), true);
  assert.equal(isArtifactMemoryPath("C:\\memory\\artifacts\\2026-02-21\\a.md"), true);
});

test("isArtifactMemoryPath does not match non-artifact paths", () => {
  assert.equal(isArtifactMemoryPath("/tmp/memory/facts/2026-02-21/a.md"), false);
  assert.equal(isArtifactMemoryPath("/tmp/memory/my-artifacts-note.md"), false);
});
