import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const hookFiles = [
  "packages/plugin-claude-code/hooks/bin/post-tool-observe.sh",
  "packages/plugin-codex/hooks/bin/post-tool-observe.sh",
];

for (const hookFile of hookFiles) {
  test(`${hookFile} falls back to legacy engram cursor and lock files`, async () => {
    const content = await readFile(hookFile, "utf8");

    assert.match(content, /LEGACY_CURSOR_FILE="\/tmp\/engram-cursor-\$\{SESSION_ID\}"/);
    assert.match(content, /CURSOR_FILE="\/tmp\/remnic-cursor-\$\{SESSION_ID\}"/);
    assert.match(content, /LEGACY_LOCK_DIR="\/tmp\/engram-lock-\$\{SESSION_ID\}\.d"/);
    assert.match(content, /LOCK_DIR="\/tmp\/remnic-lock-\$\{SESSION_ID\}\.d"/);
    assert.match(content, /if \[ ! -f "\$CURSOR_FILE" \] && \{ \[ -f "\$LEGACY_CURSOR_FILE" \] \|\| \[ -d "\$LEGACY_LOCK_DIR" \]; \}; then/);
    assert.match(content, /CURSOR_FILE="\$LEGACY_CURSOR_FILE"/);
    assert.match(content, /LOCK_DIR="\$LEGACY_LOCK_DIR"/);
  });

  test(`${hookFile} retries legacy engram tokens when remnic token parsing fails`, async () => {
    const content = await readFile(hookFile, "utf8");

    assert.match(content, /for TOKEN_FILE in "\$\{HOME\}\/\.remnic\/tokens\.json" "\$\{HOME\}\/\.engram\/tokens\.json"; do/);
    assert.match(content, /\[ ! -f "\$TOKEN_FILE" \] && continue/);
    assert.match(content, /JSON\.parse\(fs\.readFileSync\(tokenFile, 'utf8'\)\)/);
    assert.match(content, /\[ -n "\$REMNIC_TOKEN" \] && break/);
  });
}
