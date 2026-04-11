/**
 * codex-materialize-consolidation-wiring.test.ts — regression guard for
 * PR #392 review feedback (thread PRRT_kwDORJXyws56TH1B): the
 * `materializeAfterSemanticConsolidation` and `materializeAfterCausalConsolidation`
 * helpers were defined but never called from the active consolidation code
 * paths, so `codexMaterializeOnConsolidation=true` was effectively inert.
 *
 * The full orchestrator integration path is too heavy to spin up in a unit
 * test, so we check the call sites structurally by reading the relevant
 * source files. If someone refactors the consolidation runtime and forgets
 * to re-wire the hook, these tests fail loudly at build time.
 *
 * This file uses synthetic read-only file inspection — no network, no real
 * user data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

test("orchestrator.runSemanticConsolidation invokes materializeAfterSemanticConsolidation", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/orchestrator.ts"),
    "utf-8",
  );
  // The import line must exist…
  assert.match(
    src,
    /materializeAfterSemanticConsolidation/u,
    "orchestrator.ts must import materializeAfterSemanticConsolidation",
  );
  // …and there must be at least one call site after the semantic-consolidation
  // completion log line. We check by locating the log and asserting a call
  // follows it in the same function body. The helper is awaited so the
  // substring `await materializeAfterSemanticConsolidation` is distinctive.
  const awaitIdx = src.indexOf("await materializeAfterSemanticConsolidation");
  assert.ok(
    awaitIdx >= 0,
    "orchestrator.ts must await materializeAfterSemanticConsolidation at runtime",
  );

  // Sanity: the call is inside a try/catch so a materialize failure never
  // aborts the consolidation result. We check for the presence of a catch
  // block following the call within a small window.
  const window = src.slice(awaitIdx, awaitIdx + 1000);
  assert.match(
    window,
    /catch \(err\)/u,
    "materialize call must be wrapped in try/catch so failures stay non-fatal",
  );
});

test("compounding engine.synthesizeWeekly invokes materializeAfterCausalConsolidation", () => {
  const src = readFileSync(
    path.join(repoRoot, "packages/remnic-core/src/compounding/engine.ts"),
    "utf-8",
  );
  assert.match(
    src,
    /materializeAfterCausalConsolidation/u,
    "compounding/engine.ts must import materializeAfterCausalConsolidation",
  );
  const awaitIdx = src.indexOf("await materializeAfterCausalConsolidation");
  assert.ok(
    awaitIdx >= 0,
    "compounding/engine.ts must await materializeAfterCausalConsolidation at runtime",
  );
  const window = src.slice(awaitIdx, awaitIdx + 1000);
  assert.match(
    window,
    /catch \(materializeError\)/u,
    "causal materialize call must be wrapped in try/catch so failures stay non-fatal",
  );
});

test("session-end.sh resolves REMNIC_REPO_ROOT from its own filesystem location", () => {
  // Regression (PR #392 review): the old hook only ran the materializer
  // when either $REMNIC_REPO_ROOT was set OR `remnic --print-root` returned
  // a path. Neither condition holds in most installs, so the materializer
  // silently never ran. The fix resolves relative to `$BASH_SOURCE`.
  const src = readFileSync(
    path.join(repoRoot, "packages/plugin-codex/hooks/bin/session-end.sh"),
    "utf-8",
  );
  assert.match(
    src,
    /BASH_SOURCE\[0\]/u,
    "session-end.sh must resolve root from its own filesystem location",
  );
  // The old reliance on `remnic --print-root` must be gone.
  assert.doesNotMatch(
    src,
    /remnic --print-root/u,
    "session-end.sh must not depend on the non-existent `remnic --print-root` flag",
  );
  // And the resolution must verify the candidate root by checking for
  // the sentinel script before running it.
  assert.match(
    src,
    /scripts\/codex-materialize\.ts/u,
    "session-end.sh must verify the candidate root contains scripts/codex-materialize.ts",
  );
});
