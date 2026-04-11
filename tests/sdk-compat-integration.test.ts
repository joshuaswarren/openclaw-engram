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
const MIGRATION_PROMISE_KEY = "__openclawEngramMigrationPromise";
const DISABLE_REGISTER_MIGRATION_ENV = "REMNIC_DISABLE_REGISTER_MIGRATION";

// ============================================================================
// Helpers
// ============================================================================

async function awaitPendingMigration() {
  const pending = (globalThis as any)[MIGRATION_PROMISE_KEY];
  if (pending && typeof pending.then === "function") {
    try {
      await pending;
    } catch {}
  }
}

function disableRegisterMigrationForTest(): string | undefined {
  const previous = process.env[DISABLE_REGISTER_MIGRATION_ENV];
  process.env[DISABLE_REGISTER_MIGRATION_ENV] = "1";
  return previous;
}

function restoreRegisterMigrationEnv(previous: string | undefined) {
  if (previous === undefined) {
    delete process.env[DISABLE_REGISTER_MIGRATION_ENV];
    return;
  }
  process.env[DISABLE_REGISTER_MIGRATION_ENV] = previous;
}

function resetGlobals() {
  for (const key of [
    GUARD_KEY,
    HOOK_APIS_KEY,
    ORCH_KEY,
    ACCESS_SVC_KEY,
    ACCESS_HTTP_KEY,
    SERVICE_STARTED_KEY,
    INIT_PROMISE_KEY,
    MIGRATION_PROMISE_KEY,
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
  runtime?: { version: string; agent?: { id?: string; workspaceDir?: string } };
  registrationMode?: string;
  registerMemoryPromptSection?: (spec: unknown) => void;
  registerMemoryCapability?: (spec: unknown) => void;
  _registeredHooks: string[];
  _registeredToolCount: number;
  _registeredServiceIds: string[];
  _memoryPromptSectionRegistered: boolean;
  _registeredMemoryCapability?: any;
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
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("new-sdk-test");
    plugin.register(api as any);

    // When registerMemoryPromptSection is available (new SDK), before_prompt_build
    // IS registered for async pre-computation (the synchronous builder reads
    // the cached result).  The recall hook handler itself is skipped.
    assert.ok(
      api._registeredHooks.includes("before_prompt_build"),
      "before_prompt_build should be registered for async pre-compute when registerMemoryPromptSection is available",
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
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

// ============================================================================
// Test 2: Legacy SDK api gets legacy hooks only
// ============================================================================
test("legacy SDK api gets legacy hooks only", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
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
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
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
  assert.equal(plugin.name, "Remnic (Local Memory)");
  assert.equal(plugin.kind, "memory");
  assert.equal(typeof plugin.register, "function");
});

// ============================================================================
// Test 4: Setup-only mode skips all registration
// ============================================================================
test("setup-only mode skips all registration", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
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
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

// ============================================================================
// Test 5: publicArtifacts.listArtifacts derives agentIds from runtime
// ============================================================================
test("publicArtifacts.listArtifacts derives agentIds from api.runtime.agent.id", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("capability-runtime-agent-test");
    // Capture info log output so we can assert SDK detection reports the new
    // memoryCapability flag.
    const infoLogs: string[] = [];
    api.logger = {
      debug: () => {},
      info: (...args: unknown[]) => {
        infoLogs.push(args.map((a) => String(a)).join(" "));
      },
      warn: () => {},
      error: () => {},
    } as any;
    // Simulate a new SDK runtime that supplies an agent id out-of-band.
    api.runtime = {
      version: "2026.4.9",
      agent: { id: "wiki-bridge-agent", workspaceDir: "/tmp/wiki-ws" },
    };
    api.registerMemoryCapability = (spec: any) => {
      api._registeredMemoryCapability = spec;
    };

    plugin.register(api as any);

    // SDK detection log must include the memoryCapability flag so diagnosing
    // capability-only runtimes doesn't require guessing the detection result.
    const detectionLog = infoLogs.find((msg) => msg.includes("SDK detection:"));
    assert.ok(
      detectionLog && /memoryCapability=true/.test(detectionLog),
      `SDK detection log must report memoryCapability=true, got: ${detectionLog ?? "<missing>"}`,
    );

    // Capability must have been registered
    assert.ok(
      api._registeredMemoryCapability,
      "registerMemoryCapability should have been called on a new SDK that exposes it",
    );
    const cap = api._registeredMemoryCapability;
    assert.ok(cap.publicArtifacts, "capability must expose publicArtifacts");
    assert.equal(typeof cap.publicArtifacts.listArtifacts, "function");

    const result = await cap.publicArtifacts.listArtifacts({ cfg: {} });
    // Whether or not artifacts are found (memoryDir likely empty), every
    // returned artifact must carry the runtime agent id — never the hardcoded
    // "generalist" fallback.
    assert.ok(Array.isArray(result), "listArtifacts must return an array");
    for (const artifact of result) {
      assert.deepStrictEqual(
        artifact.agentIds,
        ["wiki-bridge-agent"],
        "agentIds should be derived from api.runtime.agent.id, not hardcoded",
      );
    }
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});

test("publicArtifacts.listArtifacts falls back to default agent id when runtime agent is absent", async () => {
  resetGlobals();
  const previousDisableMigration = disableRegisterMigrationForTest();
  try {
    const { default: plugin } = await import("../src/index.js");

    const api = buildNewSdkApi("capability-no-runtime-agent-test");
    // runtime is present but without an agent.id — older new-SDK shape.
    api.runtime = { version: "2026.4.9" };
    api.registerMemoryCapability = (spec: any) => {
      api._registeredMemoryCapability = spec;
    };

    plugin.register(api as any);

    assert.ok(api._registeredMemoryCapability);
    const cap = api._registeredMemoryCapability;
    const result = await cap.publicArtifacts.listArtifacts({ cfg: {} });
    assert.ok(Array.isArray(result));
    // Every returned artifact must carry a non-empty agentIds array.
    for (const artifact of result) {
      assert.ok(
        Array.isArray(artifact.agentIds) && artifact.agentIds.length > 0,
        "agentIds fallback must be a non-empty array",
      );
    }
  } finally {
    await awaitPendingMigration();
    restoreRegisterMigrationEnv(previousDisableMigration);
    resetGlobals();
  }
});
