import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("runLifecyclePolicyPass uses path-based frontmatter writes (no per-item corpus rescans)", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "orchestrator.ts"), "utf-8");
  const runLifecycleMatch = source.match(
    /private async runLifecyclePolicyPass\(allMemories: MemoryFile\[\]\): Promise<void> \{[\s\S]*?\n  \}\n\n  \/\*\*/m,
  );
  assert.ok(runLifecycleMatch, "expected runLifecyclePolicyPass helper");
  const block = runLifecycleMatch[0];

  assert.match(
    block,
    /await this\.storage\.writeMemoryFrontmatter\(memory,\s*\{/,
    "lifecycle pass should write by in-memory MemoryFile/path",
  );
  assert.doesNotMatch(
    block,
    /updateMemoryFrontmatter\(/,
    "lifecycle pass should avoid ID-based frontmatter updates that rescan corpus",
  );
});
