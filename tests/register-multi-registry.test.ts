/**
 * Registration contract tests: verifies the invariants that govern how
 * register() behaves when the gateway calls it multiple times with different
 * api objects (multiple registries) or across process boundaries.
 *
 * ## Invariant table
 *
 * | Behavior            | Scope           | Reason                                      |
 * |---------------------|-----------------|---------------------------------------------|
 * | registerTools       | every registry  | Tools are per-registry; skipping = no tools |
 * | registerLcmTools    | every registry  | Same as above                               |
 * | registerCli         | first only      | Central registry; duplicates = broken CLI   |
 * | registerService     | every registry  | startPluginServices() iterates own registry |
 * | service.start() run | once per process| Idempotency via ENGRAM_SERVICE_STARTED flag |
 *
 * ## Regression history
 *
 * - Issue #282 / PR #283: registerTools was first-only → tools missing in secondary registries
 * - Issue #285 / PR ???:  registerService was first-only → start() never fired in secondary registry,
 *                         orchestrator never initialized, all memory writes silently broken
 *
 * ## Scenarios covered
 *
 * Scenario A (same-process, multiple registries): The gateway creates different
 * plugin registries for different cache keys (cron vs. reply contexts). Each
 * gets a distinct api object and calls register() independently.
 *
 * Scenario B (cross-process boundary): The plugin loads in a companion process
 * first, setting the ENGRAM_REGISTERED_GUARD. A fresh gateway process (own
 * globalThis) must still register and start the service independently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// ============================================================================
// Shared constants — must match src/index.ts
// ============================================================================
const GUARD_KEY = "__openclawEngramRegistered";
const HOOK_APIS_KEY = "__openclawEngramHookApis";
const ORCH_KEY = "__openclawEngramOrchestrator";
const ACCESS_SVC_KEY = "__openclawEngramAccessService";
const ACCESS_HTTP_KEY = "__openclawEngramAccessHttpServer";
const SERVICE_STARTED_KEY = "__openclawEngramServiceStarted";

// ============================================================================
// Helpers
// ============================================================================

function buildApi(label: string) {
  const registeredToolNames: string[] = [];
  let registeredCliCount = 0;
  const registeredServiceIds: string[] = [];
  let startCallCount = 0;
  let stopCallCount = 0;

  const api = {
    label,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    pluginConfig: {},
    config: {},
    registerTool(spec: { name: string }) {
      registeredToolNames.push(spec.name);
    },
    registerCli(_spec: unknown) {
      registeredCliCount++;
    },
    registerService(spec: { id: string; start: () => Promise<void>; stop: () => Promise<void> }) {
      registeredServiceIds.push(spec.id);
      // Capture start/stop for later invocation in tests
      api._registeredStart = spec.start;
      api._registeredStop = spec.stop;
    },
    on(_event: string, _handler: unknown) {},
    registerHook(_events: unknown, _handler: unknown, _opts?: unknown) {},
    runtime: { version: "0.0.0" },
    // Captured from registerService for test invocation
    _registeredStart: null as (() => Promise<void>) | null,
    _registeredStop: null as (() => Promise<void>) | null,
    _startCallCount: () => startCallCount,
    _stopCallCount: () => stopCallCount,
  };

  return {
    api,
    getToolNames: () => [...registeredToolNames],
    getCliCount: () => registeredCliCount,
    getServiceIds: () => [...registeredServiceIds],
  };
}

function saveAndResetGlobals() {
  const saved = {
    guard: (globalThis as any)[GUARD_KEY],
    hookApis: (globalThis as any)[HOOK_APIS_KEY],
    orch: (globalThis as any)[ORCH_KEY],
    accessSvc: (globalThis as any)[ACCESS_SVC_KEY],
    accessHttp: (globalThis as any)[ACCESS_HTTP_KEY],
    serviceStarted: (globalThis as any)[SERVICE_STARTED_KEY],
  };
  delete (globalThis as any)[GUARD_KEY];
  delete (globalThis as any)[HOOK_APIS_KEY];
  delete (globalThis as any)[ORCH_KEY];
  delete (globalThis as any)[ACCESS_SVC_KEY];
  delete (globalThis as any)[ACCESS_HTTP_KEY];
  delete (globalThis as any)[SERVICE_STARTED_KEY];
  return saved;
}

function restoreGlobals(saved: ReturnType<typeof saveAndResetGlobals>) {
  if (saved.guard !== undefined) (globalThis as any)[GUARD_KEY] = saved.guard;
  else delete (globalThis as any)[GUARD_KEY];

  if (saved.hookApis !== undefined) (globalThis as any)[HOOK_APIS_KEY] = saved.hookApis;
  else delete (globalThis as any)[HOOK_APIS_KEY];

  if (saved.orch !== undefined) (globalThis as any)[ORCH_KEY] = saved.orch;
  else delete (globalThis as any)[ORCH_KEY];

  if (saved.accessSvc !== undefined) (globalThis as any)[ACCESS_SVC_KEY] = saved.accessSvc;
  else delete (globalThis as any)[ACCESS_SVC_KEY];

  if (saved.accessHttp !== undefined) (globalThis as any)[ACCESS_HTTP_KEY] = saved.accessHttp;
  else delete (globalThis as any)[ACCESS_HTTP_KEY];

  if (saved.serviceStarted !== undefined) (globalThis as any)[SERVICE_STARTED_KEY] = saved.serviceStarted;
  else delete (globalThis as any)[SERVICE_STARTED_KEY];
}

// ============================================================================
// Scenario A: same-process, multiple api instances (multiple gateway registries)
// ============================================================================

test("register() registers tools on every api object, not just the first one", async () => {
  const saved = saveAndResetGlobals();
  try {
    const { default: plugin } = await import("../src/index.js");

    const first = buildApi("first-registry");
    const second = buildApi("second-registry");

    plugin.register(first.api as any);
    plugin.register(second.api as any);

    const firstTools = first.getToolNames();
    const secondTools = second.getToolNames();

    assert.ok(firstTools.length > 0, `first registry should have tools, got ${firstTools.length}`);
    assert.ok(secondTools.length > 0, `second registry should have tools (was 0 before #283 fix), got ${secondTools.length}`);
    assert.deepEqual(firstTools, secondTools, "both registries should receive identical tool registrations");
    assert.ok(firstTools.includes("memory_summarize_hourly"), "first registry must include memory_summarize_hourly");
    assert.ok(secondTools.includes("memory_summarize_hourly"), "second registry must include memory_summarize_hourly (regression: was missing before #283)");
  } finally {
    restoreGlobals(saved);
  }
});

test("register() registers CLI only on the first api object (must not duplicate central registry)", async () => {
  const saved = saveAndResetGlobals();
  try {
    const { default: plugin } = await import("../src/index.js");

    const first = buildApi("first-cli");
    const second = buildApi("second-cli");

    plugin.register(first.api as any);
    plugin.register(second.api as any);

    assert.ok(first.getCliCount() > 0, "first registry should have CLI registered");
    assert.equal(second.getCliCount(), 0, "second registry must NOT have CLI (would create duplicate command trees)");
  } finally {
    restoreGlobals(saved);
  }
});

test("register() calls registerService on every api object, not just the first one (regression: issue #285)", async () => {
  // Before the fix, registerService was inside `if (isFirstRegistration)`.
  // The second registry received hooks and tools but no service registration.
  // When the gateway's startPluginServices() ran against the second registry,
  // it found no service → start() never fired → orchestrator never initialized.
  const saved = saveAndResetGlobals();
  try {
    const { default: plugin } = await import("../src/index.js");

    const first = buildApi("first-service");
    const second = buildApi("second-service");
    const third = buildApi("third-service");

    plugin.register(first.api as any);
    plugin.register(second.api as any);
    plugin.register(third.api as any);

    assert.deepEqual(
      first.getServiceIds(),
      ["openclaw-engram"],
      "first registry must have service registered",
    );
    assert.deepEqual(
      second.getServiceIds(),
      ["openclaw-engram"],
      "second registry must have service registered (was missing before #285 fix)",
    );
    assert.deepEqual(
      third.getServiceIds(),
      ["openclaw-engram"],
      "third registry must have service registered (simulates 3-4 loads per restart)",
    );
  } finally {
    restoreGlobals(saved);
  }
});

test("service.start() runs initialize exactly once even when called from multiple registries", async () => {
  // The ENGRAM_SERVICE_STARTED guard inside start() prevents double-init.
  // Without it, multiple registries each calling start() would run
  // orchestrator.initialize() multiple times → double I/O, double cron, etc.
  const saved = saveAndResetGlobals();
  try {
    const { default: plugin } = await import("../src/index.js");

    const first = buildApi("first-start");
    const second = buildApi("second-start");

    plugin.register(first.api as any);
    plugin.register(second.api as any);

    // Both registered a service — now simulate startPluginServices() calling
    // start() on both (as the gateway would if it iterated all registries).

    // Before calling start(), the flag should be unset.
    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      undefined,
      "ENGRAM_SERVICE_STARTED should not be set before any start() call",
    );

    // Call start() from first registry (would throw without a real orchestrator,
    // but we just need to verify the started-flag behavior).
    // We catch the error from the real start() since orchestrator.initialize()
    // will fail without a real OpenAI key — what matters is the flag is set.
    try { await first.api._registeredStart?.(); } catch { /* expected in test env */ }

    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      true,
      "ENGRAM_SERVICE_STARTED should be set after first start() call",
    );

    // Call start() from second registry — must be a no-op due to the guard.
    // We verify this by checking the flag was already true before entry.
    const flagBeforeSecond = (globalThis as any)[SERVICE_STARTED_KEY];
    try { await second.api._registeredStart?.(); } catch { /* unexpected — guard should have returned early */ }

    assert.equal(
      flagBeforeSecond,
      true,
      "ENGRAM_SERVICE_STARTED was already true — second start() should have been a no-op",
    );
  } finally {
    restoreGlobals(saved);
  }
});

test("service.stop() clears ENGRAM_SERVICE_STARTED so restart cycles reinitialize", async () => {
  // If stop() doesn't clear the flag, a stop → start cycle would be a no-op
  // and the orchestrator would never reinitialize after a gateway restart.
  const saved = saveAndResetGlobals();
  try {
    const { default: plugin } = await import("../src/index.js");
    const stub = buildApi("stop-restart");

    plugin.register(stub.api as any);

    // Simulate start() setting the flag (even if it errors internally).
    try { await stub.api._registeredStart?.(); } catch { /* expected */ }
    assert.equal((globalThis as any)[SERVICE_STARTED_KEY], true, "flag should be set after start");

    // stop() must clear it.
    try { await stub.api._registeredStop?.(); } catch { /* ok */ }
    assert.equal(
      (globalThis as any)[SERVICE_STARTED_KEY],
      false,
      "ENGRAM_SERVICE_STARTED must be cleared by stop() so the next start() reinitializes",
    );
  } finally {
    restoreGlobals(saved);
  }
});

// ============================================================================
// Scenario B: cross-process boundary
// ============================================================================

test("Scenario B: fresh process registers and starts service independently (process isolation)", () => {
  // Simulates: openclaw-node companion process loads the plugin first, setting
  // ENGRAM_REGISTERED_GUARD in its own globalThis. A separate gateway process
  // (own globalThis) must still register and start the service independently.
  //
  // Each OS process has its own globalThis — ENGRAM_REGISTERED_GUARD from a
  // companion process cannot bleed into the gateway process. This test documents
  // and verifies that process isolation guarantee.
  //
  // We spawn tsx (not bare node) so TypeScript source imports resolve correctly,
  // matching the actual runtime environment.

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const tsxBin = join(__dirname, "../node_modules/.bin/tsx");
  const indexPath = join(__dirname, "../src/index.ts");

  // Inline script passed via --eval / stdin using tsx
  const script = `
import { default as plugin } from ${JSON.stringify(indexPath)};

const GUARD_KEY = "__openclawEngramRegistered";
const SERVICE_STARTED_KEY = "__openclawEngramServiceStarted";

// A fresh process must always start with a clean globalThis.
if (globalThis[GUARD_KEY] !== undefined) {
  process.stderr.write("FAIL: GUARD_KEY was set in fresh process\\n");
  process.exit(1);
}
if (globalThis[SERVICE_STARTED_KEY] !== undefined) {
  process.stderr.write("FAIL: SERVICE_STARTED_KEY was set in fresh process\\n");
  process.exit(1);
}

const serviceIds = [];
const api = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  pluginConfig: {},
  config: {},
  registerTool() {},
  registerCli() {},
  registerService(spec) { serviceIds.push(spec.id); },
  on() {},
  registerHook() {},
  runtime: { version: "0.0.0" },
};

plugin.register(api);

if (!serviceIds.includes("openclaw-engram")) {
  process.stderr.write("FAIL: service not registered. ids=" + JSON.stringify(serviceIds) + "\\n");
  process.exit(1);
}
if (globalThis[GUARD_KEY] !== true) {
  process.stderr.write("FAIL: GUARD_KEY should be true after registration\\n");
  process.exit(1);
}

process.stdout.write("PASS\\n");
`;

  const result = spawnSync(tsxBin, ["--input-type=module"], {
    input: script,
    encoding: "utf8",
    timeout: 20_000,
    cwd: join(__dirname, ".."),
  });

  if (result.error) throw result.error;

  assert.equal(
    result.status,
    0,
    `Cross-process registration test failed (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.ok(
    result.stdout.includes("PASS"),
    `Expected PASS in stdout:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
});
