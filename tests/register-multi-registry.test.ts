/**
 * Tests that register() calls registerTools() and registerCli() on every api
 * object it receives, not just the first one.
 *
 * Regression test for: isFirstRegistration guard prevents tool registration in
 * secondary plugin registries (issue #282).
 *
 * When the gateway creates multiple plugin registries with different cache keys
 * (e.g. cron vs. reply contexts), each registry gets a distinct `api` object
 * and calls `register()` independently. Without the fix, only the first api
 * object receives tool registrations; subsequent ones have hooks but zero
 * tools, making memory_summarize_hourly (and all other Engram tools)
 * invisible to the LLM.
 */
import test from "node:test";
import assert from "node:assert/strict";

// Minimal api stub that only tracks registerTool calls.
function buildApi(label: string) {
  const registeredToolNames: string[] = [];
  let registeredCliCount = 0;
  const registeredHooks: string[] = [];

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
    registerService(_spec: unknown) {
      // no-op: only called on first registration
    },
    on(_event: string, _handler: unknown) {
      registeredHooks.push(typeof _event === "string" ? _event : "unknown");
    },
    registerHook(_events: unknown, _handler: unknown, _opts?: unknown) {
      // legacy heartbeat path — no-op
    },
    runtime: { version: "0.0.0" },
  };

  return {
    api,
    getToolNames: () => [...registeredToolNames],
    getCliCount: () => registeredCliCount,
    getHookNames: () => [...registeredHooks],
  };
}

test("register() registers tools on every api object, not just the first one", async () => {
  // Clean up globalThis state from any prior test runs so this test is isolated.
  const GUARD_KEY = "__openclawEngramRegistered";
  const HOOK_APIS_KEY = "__openclawEngramHookApis";
  const ORCH_KEY = "__openclawEngramOrchestrator";
  const ACCESS_SVC_KEY = "__openclawEngramAccessService";
  const ACCESS_HTTP_KEY = "__openclawEngramAccessHttpServer";

  const savedGuard = (globalThis as any)[GUARD_KEY];
  const savedHookApis = (globalThis as any)[HOOK_APIS_KEY];
  const savedOrch = (globalThis as any)[ORCH_KEY];
  const savedAccessSvc = (globalThis as any)[ACCESS_SVC_KEY];
  const savedAccessHttp = (globalThis as any)[ACCESS_HTTP_KEY];

  // Reset all state so we get a clean first registration
  delete (globalThis as any)[GUARD_KEY];
  delete (globalThis as any)[HOOK_APIS_KEY];
  delete (globalThis as any)[ORCH_KEY];
  delete (globalThis as any)[ACCESS_SVC_KEY];
  delete (globalThis as any)[ACCESS_HTTP_KEY];

  try {
    // Dynamically import so we pick up any module-level state freshly.
    const { default: plugin } = await import("../src/index.js");

    const first = buildApi("first-registry");
    const second = buildApi("second-registry");

    // Simulate two separate plugin registries calling register() sequentially,
    // as the gateway does when different cache keys produce different registries.
    plugin.register(first.api as any);
    plugin.register(second.api as any);

    const firstTools = first.getToolNames();
    const secondTools = second.getToolNames();

    // Both registries must have at least one tool registered.
    assert.ok(
      firstTools.length > 0,
      `first registry should have tools registered, got ${firstTools.length}`,
    );
    assert.ok(
      secondTools.length > 0,
      `second registry should have tools registered (was 0 before fix), got ${secondTools.length}`,
    );

    // Both registries should have the same tool set (same orchestrator, different api).
    assert.deepEqual(
      firstTools,
      secondTools,
      "both registries should receive identical tool registrations",
    );

    // memory_summarize_hourly is the specific tool cited in issue #282.
    assert.ok(
      firstTools.includes("memory_summarize_hourly"),
      "first registry must include memory_summarize_hourly",
    );
    assert.ok(
      secondTools.includes("memory_summarize_hourly"),
      "second registry must include memory_summarize_hourly (regression: was missing before fix)",
    );
  } finally {
    // Restore globalThis to avoid polluting other tests.
    if (savedGuard !== undefined) (globalThis as any)[GUARD_KEY] = savedGuard;
    else delete (globalThis as any)[GUARD_KEY];

    if (savedHookApis !== undefined) (globalThis as any)[HOOK_APIS_KEY] = savedHookApis;
    else delete (globalThis as any)[HOOK_APIS_KEY];

    if (savedOrch !== undefined) (globalThis as any)[ORCH_KEY] = savedOrch;
    else delete (globalThis as any)[ORCH_KEY];

    if (savedAccessSvc !== undefined) (globalThis as any)[ACCESS_SVC_KEY] = savedAccessSvc;
    else delete (globalThis as any)[ACCESS_SVC_KEY];

    if (savedAccessHttp !== undefined) (globalThis as any)[ACCESS_HTTP_KEY] = savedAccessHttp;
    else delete (globalThis as any)[ACCESS_HTTP_KEY];
  }
});

test("register() registers CLI on every api object (not just first)", async () => {
  // This test verifies registerCli is also called per-registration, not guarded.
  const GUARD_KEY = "__openclawEngramRegistered";
  const HOOK_APIS_KEY = "__openclawEngramHookApis";
  const ORCH_KEY = "__openclawEngramOrchestrator";
  const ACCESS_SVC_KEY = "__openclawEngramAccessService";
  const ACCESS_HTTP_KEY = "__openclawEngramAccessHttpServer";

  const savedGuard = (globalThis as any)[GUARD_KEY];
  const savedHookApis = (globalThis as any)[HOOK_APIS_KEY];
  const savedOrch = (globalThis as any)[ORCH_KEY];
  const savedAccessSvc = (globalThis as any)[ACCESS_SVC_KEY];
  const savedAccessHttp = (globalThis as any)[ACCESS_HTTP_KEY];

  delete (globalThis as any)[GUARD_KEY];
  delete (globalThis as any)[HOOK_APIS_KEY];
  delete (globalThis as any)[ORCH_KEY];
  delete (globalThis as any)[ACCESS_SVC_KEY];
  delete (globalThis as any)[ACCESS_HTTP_KEY];

  try {
    const { default: plugin } = await import("../src/index.js");

    const first = buildApi("first-cli");
    const second = buildApi("second-cli");

    plugin.register(first.api as any);
    plugin.register(second.api as any);

    assert.ok(
      first.getCliCount() > 0,
      "first registry should have CLI registered",
    );
    assert.ok(
      second.getCliCount() > 0,
      "second registry should have CLI registered (regression: was missing before fix)",
    );
  } finally {
    if (savedGuard !== undefined) (globalThis as any)[GUARD_KEY] = savedGuard;
    else delete (globalThis as any)[GUARD_KEY];

    if (savedHookApis !== undefined) (globalThis as any)[HOOK_APIS_KEY] = savedHookApis;
    else delete (globalThis as any)[HOOK_APIS_KEY];

    if (savedOrch !== undefined) (globalThis as any)[ORCH_KEY] = savedOrch;
    else delete (globalThis as any)[ORCH_KEY];

    if (savedAccessSvc !== undefined) (globalThis as any)[ACCESS_SVC_KEY] = savedAccessSvc;
    else delete (globalThis as any)[ACCESS_SVC_KEY];

    if (savedAccessHttp !== undefined) (globalThis as any)[ACCESS_HTTP_KEY] = savedAccessHttp;
    else delete (globalThis as any)[ACCESS_HTTP_KEY];
  }
});
