import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const hookFiles = [
  "packages/plugin-claude-code/hooks/bin/user-prompt-recall.sh",
  "packages/plugin-codex/hooks/bin/user-prompt-recall.sh",
];

for (const hookFile of hookFiles) {
  test(`${hookFile} retries legacy engram tokens when remnic token parsing fails`, async () => {
    const content = await readFile(hookFile, "utf8");

    assert.match(content, /for TOKEN_FILE in "\$\{HOME\}\/\.remnic\/tokens\.json" "\$\{HOME\}\/\.engram\/tokens\.json"; do/);
    assert.match(content, /\[ ! -f "\$TOKEN_FILE" \] && continue/);
    assert.match(content, /JSON\.parse\(fs\.readFileSync\(tokenFile, 'utf8'\)\)/);
    assert.match(content, /\[ -n "\$REMNIC_TOKEN" \] && break/);
  });
}
