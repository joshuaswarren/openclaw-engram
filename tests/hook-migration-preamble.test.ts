import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const hookFiles = [
  "packages/plugin-claude-code/hooks/bin/session-start.sh",
  "packages/plugin-codex/hooks/bin/session-start.sh",
  "packages/plugin-claude-code/hooks/bin/user-prompt-recall.sh",
  "packages/plugin-codex/hooks/bin/user-prompt-recall.sh",
  "packages/plugin-claude-code/hooks/bin/post-tool-observe.sh",
  "packages/plugin-codex/hooks/bin/post-tool-observe.sh",
  "packages/plugin-codex/hooks/bin/session-end.sh",
];

for (const hookFile of hookFiles) {
  test(`${hookFile} runs the rename migration preamble`, async () => {
    const content = await readFile(hookFile, "utf8");
    assert.match(content, /ensure_migrated\(\)/);
    assert.match(content, /\.migrated-from-engram/);
    assert.match(content, /remnic migrate/);
  });
}
