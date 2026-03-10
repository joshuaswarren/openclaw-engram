import assert from "node:assert/strict";
import test from "node:test";

import {
  parseOpenClawVersionTriple,
  shouldRegisterTypedAgentHeartbeat,
} from "./legacy-hook-compat.js";

test("parseOpenClawVersionTriple parses release and prerelease versions", () => {
  assert.deepEqual(parseOpenClawVersionTriple("2026.1.28"), [2026, 1, 28]);
  assert.deepEqual(parseOpenClawVersionTriple("2026.1.29-beta.1"), [2026, 1, 29]);
  assert.deepEqual(parseOpenClawVersionTriple("2026.3.8"), [2026, 3, 8]);
});

test("parseOpenClawVersionTriple rejects missing or malformed versions", () => {
  assert.equal(parseOpenClawVersionTriple(undefined), null);
  assert.equal(parseOpenClawVersionTriple("dev-build"), null);
  assert.equal(parseOpenClawVersionTriple(""), null);
});

test("shouldRegisterTypedAgentHeartbeat keeps prerelease cutoffs on the legacy hook", () => {
  assert.equal(shouldRegisterTypedAgentHeartbeat("2026.1.28"), true);
  assert.equal(shouldRegisterTypedAgentHeartbeat("2026.1.29-beta.1"), true);
  assert.equal(shouldRegisterTypedAgentHeartbeat("2026.1.29-rc.1"), true);
  assert.equal(shouldRegisterTypedAgentHeartbeat("2026.1.29"), false);
  assert.equal(shouldRegisterTypedAgentHeartbeat("2026.3.8"), false);
  assert.equal(shouldRegisterTypedAgentHeartbeat("dev-build"), false);
});
