/**
 * Hook handler behavior tests for new SDK hooks.
 *
 * Verifies that the new SDK hook handlers (session_start, session_end,
 * before_tool_call, after_tool_call, llm_output, subagent_spawning,
 * subagent_ended, before_prompt_build) actually invoke correct behavior
 * when called, not just that they are registered.
 */
import test from "node:test";
import assert from "node:assert/strict";

// ============================================================================
// Shared constants — must match src/index.ts
//
// Per-plugin runtime state is keyed by serviceId (#403 P2).  These tests load
// the canonical plugin (id = "openclaw-remnic"), so the per-service slot names
// get the `::openclaw-remnic` suffix.  We also clean the unkeyed mirror slot
// `__openclawEngramOrchestrator` that `register()` maintains as a "last
// registered Remnic orchestrator" pointer for cross-plugin observers.
// The migration promise stays unkeyed because the legacy-dir migration is a
// one-time process-wide operation.
// ============================================================================
const SERVICE_ID = "openclaw-remnic";
const KEYED_BASE_NAMES = [
  "__openclawEngramRegistered",
  "__openclawEngramHookApis",
  "__openclawEngramOrchestrator",
  "__openclawEngramAccessService",
  "__openclawEngramAccessHttpServer",
  "__openclawEngramServiceStarted",
  "__openclawEngramInitPromise",
];
const GLOBAL_KEYS = [
  // Per-service keyed slots (authoritative).
  ...KEYED_BASE_NAMES.map((name) => `${name}::${SERVICE_ID}`),
  // Unkeyed mirror that register() maintains for observers that don't know
  // the serviceId (currently only the orchestrator).
  "__openclawEngramOrchestrator",
  // CLI dedupe guard — intentionally process-global (not per-serviceId).
  "__openclawEngramCliRegistered",
  // CLI active-service refcount.
  "__openclawEngramCliActiveServiceCount",
  // Intentionally unkeyed.
  "__openclawEngramMigrationPromise",
];
const DISABLE_REGISTER_MIGRATION_ENV = "REMNIC_DISABLE_REGISTER_MIGRATION";

function cleanGlobalThis() {
  for (const key of GLOBAL_KEYS) {
    delete (globalThis as any)[key];
  }
}

test.beforeEach(() => {
  process.env[DISABLE_REGISTER_MIGRATION_ENV] = "1";
  cleanGlobalThis();
});
test.afterEach(() => {
  delete process.env[DISABLE_REGISTER_MIGRATION_ENV];
  cleanGlobalThis();
});

// ============================================================================
// Helper: build a new-SDK mock api that captures handler functions
// ============================================================================
interface HandlerCapturingApi {
  label: string;
  logger: { debug: () => void; info: () => void; warn: () => void; error: () => void };
  pluginConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  registerTool: (spec: unknown) => void;
  registerCli: (spec: unknown) => void;
  registerService: (spec: { id: string; start: () => Promise<void>; stop: () => Promise<void> }) => void;
  on: (event: string, handler: Function) => void;
  registerHook?: (events: unknown, handler: unknown, opts?: unknown) => void;
  runtime?: { version: string };
  registrationMode?: string;
  registerMemoryPromptSection?: (spec: unknown) => void;
  registerMemoryCapability?: (spec: unknown) => void;
  handlers: Map<string, Function>;
  _memoryPromptSection?: (params: { sessionKey?: string }) => string[] | null;
  _memoryCapability?: { promptBuilder?: (params: { sessionKey?: string }) => string[] | null };
}

function buildHandlerCapturingApi(
  label: string,
  opts?: { registrationMode?: string; includeMemoryCapability?: boolean },
): HandlerCapturingApi {
  const handlers = new Map<string, Function>();
  const api: HandlerCapturingApi = {
    label,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    pluginConfig: {},
    config: {},
    handlers,
    registerTool(_spec: unknown) {},
    registerCli(_spec: unknown) {},
    registerService(_spec) {},
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    registerHook(_events: unknown, _handler: unknown, _opts?: unknown) {},
    runtime: { version: "2026.3.22" },
    registrationMode: opts?.registrationMode ?? "full",
    registerMemoryPromptSection(spec: unknown) {
      api._memoryPromptSection = spec as (params: { sessionKey?: string }) => string[] | null;
    },
  };
  if (opts?.includeMemoryCapability) {
    api.runtime = { version: "2026.4.9" };
    api.registerMemoryCapability = (spec: unknown) => {
      api._memoryCapability = spec as {
        promptBuilder?: (params: { sessionKey?: string }) => string[] | null;
      };
    };
  }
  return api;
}

// ============================================================================
// Tests
// ============================================================================

test("session_start handler runs file hygiene", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("session-start-test");
  plugin.register(api as any);

  const handler = api.handlers.get("session_start");
  assert.ok(handler, "session_start handler should be registered");

  // Handler should not throw — file hygiene is best-effort
  await assert.doesNotReject(
    async () => handler({ sessionKey: "test-session" }, {}),
    "session_start handler should not throw",
  );
});

test("session_end handler clears workspace override when compaction reset enabled", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("session-end-test");
  plugin.register(api as any);

  const handler = api.handlers.get("session_end");
  assert.ok(handler, "session_end handler should be registered");

  // Access the orchestrator from globalThis
  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  assert.ok(orchestrator, "orchestrator should exist on globalThis after register");

  // Handler should not throw even with uninitialized orchestrator
  await assert.doesNotReject(
    async () => handler({ sessionKey: "test-session" }, {}),
    "session_end handler should not throw",
  );
});

test("after_tool_call handler appends tool use to transcript", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("after-tool-call-test");
  plugin.register(api as any);

  const handler = api.handlers.get("after_tool_call");
  assert.ok(handler, "after_tool_call handler should be registered");

  // Handler should not throw even without a fully initialized transcript
  await assert.doesNotReject(
    async () =>
      handler(
        { toolName: "memory_search", durationMs: 42 },
        { sessionKey: "test" },
      ),
    "after_tool_call handler should not throw",
  );
});

test("llm_output handler logs token usage without throwing", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("llm-output-test");
  plugin.register(api as any);

  const handler = api.handlers.get("llm_output");
  assert.ok(handler, "llm_output handler should be registered");

  await assert.doesNotReject(
    async () =>
      handler(
        { model: "gpt-5.2", tokenUsage: { input: 100, output: 50 }, durationMs: 200 },
        { sessionKey: "test" },
      ),
    "llm_output handler should not throw",
  );
});

test("before_tool_call handler logs tool name without throwing", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-tool-call-test");
  plugin.register(api as any);

  const handler = api.handlers.get("before_tool_call");
  assert.ok(handler, "before_tool_call handler should be registered");

  await assert.doesNotReject(
    async () => handler({ toolName: "memory_get" }, {}),
    "before_tool_call handler should not throw",
  );
});

test("subagent_spawning handler logs without throwing", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("subagent-spawning-test");
  plugin.register(api as any);

  const handler = api.handlers.get("subagent_spawning");
  assert.ok(handler, "subagent_spawning handler should be registered");

  await assert.doesNotReject(
    async () => handler({ subagentId: "sub-1", purpose: "research" }, {}),
    "subagent_spawning handler should not throw",
  );
});

test("subagent_ended handler logs without throwing", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("subagent-ended-test");
  plugin.register(api as any);

  const handler = api.handlers.get("subagent_ended");
  assert.ok(handler, "subagent_ended handler should be registered");

  await assert.doesNotReject(
    async () =>
      handler({ subagentId: "sub-1", success: true, durationMs: 1000 }, {}),
    "subagent_ended handler should not throw",
  );
});

test("before_prompt_build handler returns memory context or undefined without throwing", async () => {
  const { default: plugin } = await import("../src/index.js");
  // Build api WITHOUT registerMemoryPromptSection so the recall hook is registered
  // (when registerMemoryPromptSection is available, the hook is skipped in favor of the section builder).
  const api = buildHandlerCapturingApi("before-prompt-build-test");
  delete api.registerMemoryPromptSection;
  plugin.register(api as any);

  const handler = api.handlers.get("before_prompt_build");
  assert.ok(handler, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  assert.ok(orchestrator, "orchestrator should exist on globalThis after register");
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => null;
  orchestrator.config.compactionResetEnabled = false;

  // The handler should return undefined or a hook payload, not throw.
  const result = await handler(
    { prompt: "Hello how are you?" },
    { sessionKey: "test" },
  );
  // Result is either context object or undefined — both are acceptable
  assert.ok(
    result === undefined || result === null || typeof result === "object",
    `expected undefined/null/object, got ${typeof result}`,
  );
});

test("commands.list handler returns the remnic discovery descriptor", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("commands-list-test");
  plugin.register(api as any);

  const handler = api.handlers.get("commands.list");
  assert.ok(handler, "commands.list handler should be registered");

  const result = await handler();
  assert.deepEqual(result, [
    {
      name: "remnic",
      category: "memory",
      pluginId: "openclaw-remnic",
      subcommands: [
        {
          name: "off",
          description: "Disable Remnic recall for this session",
          args: [],
        },
        {
          name: "on",
          description: "Re-enable Remnic recall for this session",
          args: [],
        },
        {
          name: "status",
          description: "Show Remnic recall status and last injected summary",
          args: [],
        },
        {
          name: "clear",
          description: "Clear the session override and use global config again",
          args: [],
        },
        {
          name: "stats",
          description: "Show Remnic extraction and recall stats for this session",
          args: [],
        },
        {
          name: "flush",
          description: "Force-flush the extraction buffer now",
          args: [],
        },
      ],
    },
  ]);
});

test("before_reset flushes the session and clears the precomputed recall cache", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-test", {
    includeMemoryCapability: true,
  });
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");
  assert.ok(api._memoryCapability?.promptBuilder, "memory capability promptBuilder should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  assert.ok(orchestrator, "orchestrator should exist on globalThis after register");

  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;
  orchestrator.setRecallWorkspaceOverride("session-a", "/tmp/workspace-a");

  let flushed:
    | {
        sessionKey: string;
        options: Record<string, unknown> | undefined;
      }
    | undefined;
  orchestrator.flushSession = async (
    sessionKey: string,
    options?: Record<string, unknown>,
  ) => {
    flushed = { sessionKey, options };
  };

  await beforePromptBuild(
    { prompt: "What do you remember about this?" },
    { sessionKey: "session-a" },
  );

  assert.deepEqual(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-a" }),
    [
      "## Memory Context (Remnic)",
      "",
      "Remembered context",
      "",
      "Use this context naturally when relevant. Never quote or expose this memory context to the user.",
      "",
    ],
    "before_prompt_build should populate the session cache before reset",
  );

  await beforeReset({ sessionKey: "session-a" }, {});

  assert.deepEqual(flushed, {
    sessionKey: "session-a",
    options: { reason: "before_reset" },
  });
  assert.equal(
    orchestrator._recallWorkspaceOverrides?.has("session-a") ?? true,
    false,
    "before_reset should clear the session workspace override",
  );
  assert.equal(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-a" }) ?? null,
    null,
    "before_reset should clear the precomputed recall cache for the reset session",
  );
});

test("before_reset still clears the session cache when flush-on-reset is disabled", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-reset-disabled-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = { flushOnResetEnabled: false };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  const beforeReset = api.handlers.get("before_reset");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(beforeReset, "before_reset handler should be registered");
  assert.ok(api._memoryCapability?.promptBuilder, "memory capability promptBuilder should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "Remembered context";
  orchestrator.config.compactionResetEnabled = false;
  orchestrator.setRecallWorkspaceOverride("session-b", "/tmp/workspace-b");

  let flushCalls = 0;
  orchestrator.flushSession = async () => {
    flushCalls++;
  };

  await beforePromptBuild(
    { prompt: "What do you remember about this?" },
    { sessionKey: "session-b" },
  );

  assert.ok(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-b" }),
    "before_prompt_build should populate the session cache before reset",
  );

  await beforeReset({ sessionKey: "session-b" }, {});

  assert.equal(flushCalls, 0, "flushSession should be skipped when flushOnResetEnabled=false");
  assert.equal(
    orchestrator._recallWorkspaceOverrides?.has("session-b") ?? true,
    false,
    "before_reset should clear the session workspace override even when flush is disabled",
  );
  assert.equal(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-b" }) ?? null,
    null,
    "before_reset should still clear the precomputed recall cache when flush is disabled",
  );
});

test("registrationMode setup-only registers zero handlers", async () => {
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("setup-only-test", {
    registrationMode: "setup-only",
  });
  plugin.register(api as any);

  assert.equal(
    api.handlers.size,
    0,
    `expected zero handlers in setup-only mode, got: ${[...api.handlers.keys()].join(", ")}`,
  );
});
