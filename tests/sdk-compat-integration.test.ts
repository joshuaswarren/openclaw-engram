/**
 * SDK compatibility integration tests.
 *
 * Verifies that register() correctly routes hook registration based on SDK
 * capabilities detected at runtime:
 *
 * - New SDK api: gets before_prompt_build, session/tool/llm/subagent hooks,
 *   registerMemoryPromptSection, and service registration.
 * - Legacy SDK api: gets before_agent_start and core hooks only.
 * - Setup-only mode: skips all registration entirely.
 */
import test from "node:test";
import assert from "node:assert/strict";

// ============================================================================
// Shared constants — must match src/index.ts
// ============================================================================
const GUARD_KEY = "__openclawEngramRegistered";
const HOOK_APIS_KEY = "__openclawEngramHookApis";
const ORCH_KEY = "__openclawEngramOrchestrator";
const ACCESS_SVC_KEY = "__openclawEngramAccessService";
const ACCESS_HTTP_KEY = "__openclawEngramAccessHttpServer";
const SERVICE_STARTED_KEY = "__openclawEngramServiceStarted";
const INIT_PROMISE_KEY = "__openclawEngramInitPromise";

// ============================================================================
// Helpers
// ============================================================================

function resetGlobals() {
  for (const key of [
    GUARD_KEY,
    HOOK_APIS_KEY,
    ORCH_KEY,
    ACCESS_SVC_KEY,
    ACCESS_HTTP_KEY,
    SERVICE_STARTED_KEY,
    INIT_PROMISE_KEY,
  ]) {
    delete (globalThis as any)[key];
  }
}

interface MockApi {
  label: string;
  logger: { debug: () => void; info: () => void; warn: () => void; error: () => void };
  pluginConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  registerTool: (spec: unknown) => void;
  registerCli: (spec: unknown) => void;
  registerService: (spec: { id: string; start: () => Promise<void>; stop: () => Promise<void> }) => void;
  on: (event: string, handler: unknown) => void;
  registerHook?: (events: unknown, handler: unknown, opts?: unknown) => void;
  runtime?: { version: string };
  registrationMode?: string;
  registerMemoryPromptSection?: (spec: unknown) => void;
  _registeredHooks: string[];
  _registeredToolCount: number;
  _registeredServiceIds: string[];
  _memoryPromptSectionRegistered: boolean;
}

function buildNewSdkApi(label: string): MockApi {
  const api: MockApi = {
    label,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {},
    config: {},
    _registeredHooks: [],
    _registeredToolCount: 0,
    _registeredServiceIds: [],
    _memoryPromptSectionRegistered: false,
    registerTool(_spec: unknown) {
      api._registeredToolCount++;
    },
    registerCli(_spec: unknown) {},
    registerService(spec) {
      api._registeredServiceIds.push(spec.id);
    },
    on(event: string, _handler: unknown) {
      api._registeredHooks.push(event);
    },
    registerHook(_events: unknown, _handler: unknown, _opts?: unknown) {},
    runtime: { version: "2026.3.22" },
    registrationMode: "full",
    registerMemoryPromptSection(_spec: unknown) {
      api._memoryPromptSectionRegistered = true;
    },
  };
  return api;
}

function buildLegacySdkApi(label: string): MockApi {
  const api: MockApi = {
    label,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {},
    config: {},
    _registeredHooks: [],
    _registeredToolCount: 0,
    _registeredServiceIds: [],
    _memoryPromptSectionRegistered: false,
    registerTool(_spec: unknown) {
      api._registeredToolCount++;
    },
    registerCli(_spec: unknown) {},
    registerService(spec) {
      api._registeredServiceIds.push(spec.id);
    },
    on(event: string, _handler: unknown) {
      api._registeredHooks.push(event);
    },
    // No runtime, no registrationMode, no registerMemoryPromptSection
  };
  return api;
}

// ============================================================================
// Test 1: New SDK api gets all new hooks + memory section
// ============================================================================
test("new SDK api gets all new hooks + memory section", async () => {
  resetGlobals();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("new-sdk-test");
    plugin.register(api as any);

    // before_prompt_build should be registered (new SDK path)
    assert.ok(
      api._registeredHooks.includes("before_prompt_build"),
      `expected before_prompt_build in hooks, got: ${api._registeredHooks.join(", ")}`,
    );

    // before_agent_start should NOT be registered (legacy path)
    assert.ok(
      !api._registeredHooks.includes("before_agent_start"),
      "before_agent_start should NOT be registered on new SDK",
    );

    // Core hooks present on both paths
    assert.ok(
      api._registeredHooks.includes("agent_end"),
      "agent_end should be registered",
    );
    assert.ok(
      api._registeredHooks.includes("before_compaction"),
      "before_compaction should be registered",
    );
    assert.ok(
      api._registeredHooks.includes("after_compaction"),
      "after_compaction should be registered",
    );

    // New SDK-only hooks
    assert.ok(
      api._registeredHooks.includes("session_start"),
      "session_start should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("session_end"),
      "session_end should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("before_tool_call"),
      "before_tool_call should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("after_tool_call"),
      "after_tool_call should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("llm_output"),
      "llm_output should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("subagent_spawning"),
      "subagent_spawning should be registered on new SDK",
    );
    assert.ok(
      api._registeredHooks.includes("subagent_ended"),
      "subagent_ended should be registered on new SDK",
    );

    // registerMemoryPromptSection was called
    assert.ok(
      api._memoryPromptSectionRegistered,
      "registerMemoryPromptSection should have been called on new SDK",
    );

    // Service was registered
    assert.ok(
      api._registeredServiceIds.includes("openclaw-engram"),
      "service should be registered",
    );
  } finally {
    resetGlobals();
  }
});

// ============================================================================
// Test 2: Legacy SDK api gets legacy hooks only
// ============================================================================
test("legacy SDK api gets legacy hooks only", async () => {
  resetGlobals();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildLegacySdkApi("legacy-sdk-test");
    plugin.register(api as any);

    // before_agent_start should be registered (legacy path)
    assert.ok(
      api._registeredHooks.includes("before_agent_start"),
      `expected before_agent_start in hooks, got: ${api._registeredHooks.join(", ")}`,
    );

    // before_prompt_build should NOT be registered (new SDK path)
    assert.ok(
      !api._registeredHooks.includes("before_prompt_build"),
      "before_prompt_build should NOT be registered on legacy SDK",
    );

    // Core hooks still present
    assert.ok(
      api._registeredHooks.includes("agent_end"),
      "agent_end should be registered on legacy SDK",
    );
    assert.ok(
      api._registeredHooks.includes("before_compaction"),
      "before_compaction should be registered on legacy SDK",
    );
    assert.ok(
      api._registeredHooks.includes("after_compaction"),
      "after_compaction should be registered on legacy SDK",
    );

    // New SDK-only hooks should NOT be present
    assert.ok(
      !api._registeredHooks.includes("session_start"),
      "session_start should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("session_end"),
      "session_end should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("before_tool_call"),
      "before_tool_call should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("after_tool_call"),
      "after_tool_call should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("llm_output"),
      "llm_output should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("subagent_spawning"),
      "subagent_spawning should NOT be registered on legacy SDK",
    );
    assert.ok(
      !api._registeredHooks.includes("subagent_ended"),
      "subagent_ended should NOT be registered on legacy SDK",
    );

    // registerMemoryPromptSection should not have been called (not available)
    assert.ok(
      !api._memoryPromptSectionRegistered,
      "registerMemoryPromptSection should NOT be called on legacy SDK",
    );

    // Service still registered
    assert.ok(
      api._registeredServiceIds.includes("openclaw-engram"),
      "service should still be registered on legacy SDK",
    );
  } finally {
    resetGlobals();
  }
});

// ============================================================================
// Test 3: tryDefinePluginEntry fallback produces correct plugin shape
// ============================================================================
test("tryDefinePluginEntry: fallback produces correct plugin shape when SDK module unavailable", async () => {
  const mod = await import("../src/index.js");
  const plugin = mod.default;
  assert.equal(plugin.id, "openclaw-engram");
  assert.equal(plugin.name, "Engram (Local Memory)");
  assert.equal(plugin.kind, "memory");
  assert.equal(typeof plugin.register, "function");
});

// ============================================================================
// Test 4: Setup-only mode skips all registration
// ============================================================================
test("setup-only mode skips all registration", async () => {
  resetGlobals();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("setup-only-test");
    api.registrationMode = "setup-only";
    plugin.register(api as any);

    // No hooks should be registered
    assert.equal(
      api._registeredHooks.length,
      0,
      `expected zero hooks in setup-only mode, got: ${api._registeredHooks.join(", ")}`,
    );

    // No tools registered
    assert.equal(
      api._registeredToolCount,
      0,
      "expected zero tools in setup-only mode",
    );

    // No services registered
    assert.equal(
      api._registeredServiceIds.length,
      0,
      "expected zero services in setup-only mode",
    );

    // registerMemoryPromptSection should not have been called
    assert.ok(
      !api._memoryPromptSectionRegistered,
      "registerMemoryPromptSection should NOT be called in setup-only mode",
    );
  } finally {
    resetGlobals();
  }
});
