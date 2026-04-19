import assert from "node:assert/strict";
import test from "node:test";

import { parseBenchArgs } from "./bench-args.js";

test("parseBenchArgs keeps validated matrix profiles typed and ordered", () => {
  const parsed = parseBenchArgs([
    "run",
    "assistant-morning-brief",
    "--matrix",
    "baseline,real,openclaw-chain",
  ]);

  assert.deepEqual(parsed.matrixProfiles, [
    "baseline",
    "real",
    "openclaw-chain",
  ]);
});
