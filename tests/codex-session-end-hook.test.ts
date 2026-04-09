import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sessionEndHook = "packages/plugin-codex/hooks/bin/session-end.sh";

test("Codex session-end hook falls back to legacy engram cursor files", async () => {
  const content = await readFile(sessionEndHook, "utf8");

  assert.match(content, /LEGACY_CURSOR_FILE="\/tmp\/engram-cursor-\$\{SESSION_ID\}"/);
  assert.match(content, /CURSOR_FILE="\/tmp\/remnic-cursor-\$\{SESSION_ID\}"/);
  assert.match(content, /if \[ ! -f "\$CURSOR_FILE" \] && \[ -f "\$LEGACY_CURSOR_FILE" \]; then/);
  assert.match(content, /CURSOR_FILE="\$LEGACY_CURSOR_FILE"/);
});

test("Codex session-end hook retries legacy engram tokens when remnic token parsing fails", async () => {
  const content = await readFile(sessionEndHook, "utf8");

  assert.match(content, /for TOKEN_FILE in "\$\{HOME\}\/\.remnic\/tokens\.json" "\$\{HOME\}\/\.engram\/tokens\.json"; do/);
  assert.match(content, /\[ ! -f "\$TOKEN_FILE" \] && continue/);
  assert.match(content, /JSON\.parse\(fs\.readFileSync\(tokenFile, 'utf8'\)\)/);
  assert.match(content, /\[ -n "\$REMNIC_TOKEN" \] && break/);
});
