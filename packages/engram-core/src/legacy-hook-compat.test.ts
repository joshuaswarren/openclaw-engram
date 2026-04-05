import assert from "node:assert/strict";
import test from "node:test";

import { shouldRegisterTypedAgentHeartbeat } from "./legacy-hook-compat.js";

test("legacy-hook-compat does not export parse-only helpers", async () => {
  const moduleExports = await import("./legacy-hook-compat.js");
  assert.equal("parseOpenClawVersionTriple" in moduleExports, false);
});

test("shouldRegisterTypedAgentHeartbeat keeps prerelease cutoffs on the legacy hook", () => {
  assert.equal(shouldRegisterTypedAgentHeartbeat("2026.1.28"), true);
  assert.equal(shouldRegisterTypedAgentHeartbeat("2026.1.29-beta.1"), true);
  assert.equal(shouldRegisterTypedAgentHeartbeat("2026.1.29-rc.1"), true);
  assert.equal(shouldRegisterTypedAgentHeartbeat("2026.1.29"), false);
  assert.equal(shouldRegisterTypedAgentHeartbeat("2026.3.8"), false);
  assert.equal(shouldRegisterTypedAgentHeartbeat("dev-build"), false);
  assert.equal(shouldRegisterTypedAgentHeartbeat(undefined), false);
  assert.equal(shouldRegisterTypedAgentHeartbeat(""), false);
});
