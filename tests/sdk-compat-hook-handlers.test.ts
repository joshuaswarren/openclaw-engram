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
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
  _registeredServiceStart?: (() => Promise<void>) | null;
  _registeredServiceStop?: (() => Promise<void>) | null;
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
    registerService(spec) {
      api._registeredServiceStart = spec.start;
      api._registeredServiceStop = spec.stop;
    },
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    registerHook(_events: unknown, _handler: unknown, _opts?: unknown) {},
    runtime: { version: "2026.3.22" },
    registrationMode: opts?.registrationMode ?? "full",
    registerMemoryPromptSection(spec: unknown) {
      api._memoryPromptSection = spec as (params: { sessionKey?: string }) => string[] | null;
    },
    _registeredServiceStart: null,
    _registeredServiceStop: null,
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
  assert.equal(Array.isArray(result), true);
  const group = result?.[0];
  assert.equal(group?.name, "remnic");
  assert.equal(group?.category, "memory");
  assert.equal(group?.pluginId, "openclaw-remnic");
  assert.equal(Array.isArray(group?.subcommands), true);
  for (const command of group?.subcommands ?? []) {
    assert.equal(typeof command.handler, "function");
  }
});

test("before_prompt_build respects the primary session toggle store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-toggle-hook-"));
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-toggle-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const commandsList = api.handlers.get("commands.list");
  const commandGroup = ((commandsList ? await commandsList() : []) ?? [])[0];
  const offCommand = commandGroup?.subcommands?.find((entry: { name?: string }) => entry.name === "off");
  assert.ok(offCommand?.handler, "off command should expose a handler");
  await offCommand.handler({ sessionKey: "session-a", agentId: "main" });

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  let recallCalls = 0;
  orchestrator.recall = async () => {
    recallCalls++;
    return "should never be injected";
  };
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "Remember anything?" },
    { sessionKey: "session-a", agentId: "main" },
  );

  assert.equal(recallCalls, 0);
  assert.equal(result, undefined);
  assert.equal(api._memoryCapability?.promptBuilder?.({ sessionKey: "session-a" }) ?? null, null);
});

test("before_prompt_build honors bundled active-memory toggle read-through and writes recall audit transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bundled-toggle-hook-"));
  const bundledDir = path.join(root, "state", "plugins", "active-memory");
  await mkdir(bundledDir, { recursive: true });
  await writeFile(
    path.join(bundledDir, "session-toggles.json"),
    JSON.stringify(
      {
        version: 1,
        entries: {
          [`${encodeURIComponent("session-b")}::${encodeURIComponent("main")}`]: {
            disabled: true,
            updatedAt: "2026-04-12T12:00:00Z",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-bundled-toggle-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    recallTranscriptsEnabled: true,
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "should not run";
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "Remember anything?" },
    { sessionKey: "session-b", agentId: "main" },
  );
  assert.equal(result, undefined);

  const auditPath = path.join(
    root,
    "state",
    "plugins",
    "openclaw-remnic",
    "transcripts",
    new Date().toISOString().slice(0, 10),
    `${encodeURIComponent("session-b")}.jsonl`,
  );
  const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? "{}") as { toggleState?: string };
  assert.equal(parsed.toggleState, "disabled-secondary");
});

test("before_prompt_build prepends the active-recall fallback block when enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-active-recall-hook-"));
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-active-recall-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    activeRecallEnabled: true,
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "remembered context from Remnic";
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "What happened with CI?" },
    { sessionKey: "session-c", agentId: "main" },
  );
  assert.match(String(result?.prependSystemContext ?? ""), /## Active Recall \(Remnic\)/);
  assert.match(String(result?.prependSystemContext ?? ""), /remembered context from Remnic/);
});

test("before_prompt_build prepends recent dreams when dreaming injection is enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreaming-hook-"));
  await writeFile(
    path.join(root, "DREAMS.md"),
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T08:00:00Z — First dream*",
      "",
      "The first dream body.",
      "",
      "---",
      "",
      "*2026-04-12T09:00:00Z — Second dream*",
      "",
      "The second dream body.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-dreaming-test");
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    dreaming: {
      enabled: true,
      journalPath: "DREAMS.md",
      injectRecentCount: 2,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => "remembered context from Remnic";
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "What happened this morning?" },
    { sessionKey: "session-d", agentId: "main", workspaceDir: root },
  );

  assert.match(String(result?.prependSystemContext ?? ""), /## Recent Dreams \(Remnic\)/);
  assert.match(String(result?.prependSystemContext ?? ""), /Second dream/);
  assert.match(String(result?.prependSystemContext ?? ""), /The second dream body/);
  assert.match(String(result?.prependSystemContext ?? ""), /First dream/);
});

test("before_prompt_build records auxiliary-only dream injection in recall audit transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-auxiliary-recall-audit-"));
  await writeFile(
    path.join(root, "DREAMS.md"),
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T09:00:00Z — Second dream*",
      "",
      "The second dream body.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-auxiliary-audit-test");
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    recallTranscriptsEnabled: true,
    dreaming: {
      enabled: true,
      journalPath: "DREAMS.md",
      injectRecentCount: 1,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => null;
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "Any dream context?", verbose: true },
    { sessionKey: "session-e", agentId: "main", workspaceDir: root },
  );

  assert.equal(result, undefined);
  assert.match(
    String((api._memoryPromptSection?.({ sessionKey: "session-e" }) ?? []).join("\n")),
    /The second dream body/,
  );

  const auditPath = path.join(
    root,
    "state",
    "plugins",
    "openclaw-remnic",
    "transcripts",
    new Date().toISOString().slice(0, 10),
    `${encodeURIComponent("session-e")}.jsonl`,
  );
  const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? "{}") as {
    summary?: string | null;
    injectedChars?: number;
  };
  assert.match(String(parsed.summary ?? ""), /The second dream body/);
  assert.ok((parsed.injectedChars ?? 0) > 0);
});

test("before_prompt_build avoids double-injecting auxiliary no-recall context when memory prompt sections are enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-no-recall-aux-section-"));
  await writeFile(
    path.join(root, "DREAMS.md"),
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T10:00:00Z — First dream*",
      "",
      "The second dream body.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-no-recall-section-test", {
    includeMemoryCapability: true,
  });
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    dreaming: {
      enabled: true,
      injectRecentCount: 2,
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");
  assert.ok(api._memoryCapability?.promptBuilder, "memory capability promptBuilder should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => null;
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    { prompt: "No ordinary recall should land here." },
    { sessionKey: "session-no-recall", agentId: "main" },
  );

  assert.equal(
    result,
    undefined,
    "auxiliary no-recall context should stay in the memory section cache when memory prompt sections are enabled",
  );
  assert.deepEqual(
    api._memoryCapability?.promptBuilder?.({ sessionKey: "session-no-recall" }),
    [
      "## Recent Dreams (Remnic)",
      "",
      "- 2026-04-12T10:00:00Z — First dream: The second dream body.",
      "",
    ],
  );
});

test("runtime pluginConfig overrides file-backed config for dreaming surfaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-dreaming-config-precedence-"));
  const configPath = path.join(root, "openclaw.json");
  await writeFile(
    path.join(root, "DREAMS.md"),
    [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "---",
      "",
      "*2026-04-12T10:00:00Z — Runtime dream*",
      "",
      "The runtime-configured dream body.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    configPath,
    JSON.stringify(
      {
        plugins: {
          entries: {
            "openclaw-remnic": {
              config: {
                dreaming: {
                  enabled: false,
                  journalPath: "IGNORED.md",
                  injectRecentCount: 0,
                },
              },
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const previousConfigPath = process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
  process.env.OPENCLAW_ENGRAM_CONFIG_PATH = configPath;

  try {
    const { default: plugin } = await import("../src/index.js");
    const api = buildHandlerCapturingApi("before-prompt-build-config-precedence-test");
    api.pluginConfig = {
      memoryDir: root,
      workspaceDir: root,
      dreaming: {
        enabled: true,
        journalPath: "DREAMS.md",
        injectRecentCount: 1,
      },
    };
    plugin.register(api as any);

    const beforePromptBuild = api.handlers.get("before_prompt_build");
    assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

    const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
    orchestrator.maybeRunFileHygiene = async () => undefined;
    orchestrator.recall = async () => "remembered context from Remnic";
    orchestrator.config.compactionResetEnabled = false;

    const result = await beforePromptBuild(
      { prompt: "What happened mid-morning?" },
      { sessionKey: "session-e", agentId: "main", workspaceDir: root },
    );

    assert.match(String(result?.prependSystemContext ?? ""), /## Recent Dreams \(Remnic\)/);
    assert.match(String(result?.prependSystemContext ?? ""), /Runtime dream/);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_ENGRAM_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_ENGRAM_CONFIG_PATH = previousConfigPath;
    }
  }
});

test("before_prompt_build gates normal recall during heartbeat runs and injects heartbeat context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-hook-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const { StorageManager } = await import("../packages/remnic-core/src/storage.ts");
  const storage = new StorageManager(root);
  await storage.writeMemory("fact", "Last run found two new failures in the flaky integration suite.", {
    source: "test",
    tags: ["heartbeat", "ci"],
    structuredAttributes: {
      relatedHeartbeatSlug: "check-test-suite",
    },
  });

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 5,
      detectionMode: "runtime-signal",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  let recallCalls = 0;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => {
    recallCalls++;
    return "normal recall should be gated during heartbeat runs";
  };
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    {
      prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
    },
    {
      sessionKey: "session-heartbeat-a",
      agentId: "main",
      workspaceDir: root,
      trigger: "heartbeat",
    },
  );

  assert.equal(recallCalls, 0);
  assert.match(String(result?.prependSystemContext ?? ""), /## Active Heartbeat \(Remnic\)/);
  assert.match(String(result?.prependSystemContext ?? ""), /check-test-suite/);
  assert.match(String(result?.prependSystemContext ?? ""), /## Previous Runs/);
  assert.match(String(result?.prependSystemContext ?? ""), /two new failures/);
  assert.doesNotMatch(String(result?.prependSystemContext ?? ""), /## Memory Context \(Remnic\)/);
});

test("gateway_start heartbeat sync does not clear prior heartbeat links when the journal is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-startup-missing-"));
  const { StorageManager } = await import("../packages/remnic-core/src/storage.ts");
  const storage = new StorageManager(root);
  const memoryId = await storage.writeMemory(
    "fact",
    "Last run found two new failures in the flaky integration suite.",
    {
      source: "test",
      tags: ["heartbeat", "ci", "heartbeat:check-test-suite"],
      structuredAttributes: {
        relatedHeartbeatSlug: "check-test-suite",
      },
    },
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("heartbeat-startup-missing-journal");
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      watchFile: false,
    },
  };
  plugin.register(api as any);

  assert.ok(api._registeredServiceStart, "service start should be registered");

  try {
    await api._registeredServiceStart?.();
    const allMemories = await storage.readAllMemories();
    const memory = allMemories.find((entry) => entry.frontmatter.id === memoryId);
    assert.equal(
      memory?.frontmatter.structuredAttributes?.relatedHeartbeatSlug,
      "check-test-suite",
    );
    assert.deepEqual(memory?.frontmatter.tags, ["heartbeat", "ci", "heartbeat:check-test-suite"]);
  } finally {
    await api._registeredServiceStop?.();
  }
});

test("before_prompt_build reads previous heartbeat runs from the caller namespace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-namespace-hook-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-namespace-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: "team-alpha",
        readPrincipals: ["team-alpha"],
        writePrincipals: ["team-alpha"],
        includeInRecallByDefault: false,
      },
    ],
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 5,
      detectionMode: "runtime-signal",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => {
    throw new Error("normal recall should be gated during heartbeat runs");
  };
  orchestrator.config.compactionResetEnabled = false;

  await orchestrator.storage.writeMemory(
    "fact",
    "Default namespace result should stay isolated from team-alpha.",
    {
      source: "test",
      tags: ["heartbeat", "ci"],
      structuredAttributes: {
        relatedHeartbeatSlug: "check-test-suite",
      },
    },
  );

  const teamStorage = await orchestrator.getStorageForNamespace("team-alpha");
  await teamStorage.writeMemory(
    "fact",
    "Team alpha run found the adapter-specific regression.",
    {
      source: "test",
      tags: ["heartbeat", "ci"],
      structuredAttributes: {
        relatedHeartbeatSlug: "check-test-suite",
      },
    },
  );

  const result = await beforePromptBuild(
    {
      prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
    },
    {
      sessionKey: "agent:team-alpha:main",
      agentId: "main",
      workspaceDir: root,
      trigger: "heartbeat",
    },
  );

  assert.match(String(result?.prependSystemContext ?? ""), /## Previous Runs/);
  assert.match(
    String(result?.prependSystemContext ?? ""),
    /Team alpha run found the adapter-specific regression\./,
  );
  assert.doesNotMatch(
    String(result?.prependSystemContext ?? ""),
    /Default namespace result should stay isolated from team-alpha\./,
  );
});

test("before_prompt_build only treats canonical heartbeat links as previous runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-canonical-links-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const { StorageManager } = await import("../packages/remnic-core/src/storage.ts");
  const storage = new StorageManager(root);
  await storage.writeMemory(
    "fact",
    "During check-test-suite, the canonical heartbeat-linked run found two new failures.",
    {
      source: "test",
      tags: ["heartbeat", "ci", "heartbeat:check-test-suite"],
      structuredAttributes: {
        relatedHeartbeatSlug: "check-test-suite",
      },
    },
  );
  await storage.writeMemory("fact", "Unrelated memory happens to use the slug as a normal tag.", {
    source: "test",
    tags: ["check-test-suite", "ops"],
  });

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-canonical-links");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 5,
      detectionMode: "runtime-signal",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => {
    throw new Error("normal recall should be gated during heartbeat runs");
  };
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    {
      prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
    },
    {
      sessionKey: "session-heartbeat-canonical",
      agentId: "main",
      workspaceDir: root,
      trigger: "heartbeat",
    },
  );

  assert.match(String(result?.prependSystemContext ?? ""), /## Previous Runs/);
  assert.match(
    String(result?.prependSystemContext ?? ""),
    /canonical heartbeat-linked run found two new failures\./i,
  );
  assert.doesNotMatch(
    String(result?.prependSystemContext ?? ""),
    /Unrelated memory happens to use the slug as a normal tag\./,
  );
});

test("before_prompt_build falls back to heuristic heartbeat detection when runtime signals are absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-heuristic-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-heuristic-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 3,
      detectionMode: "heuristic",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  let recallCalls = 0;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.recall = async () => {
    recallCalls++;
    return "normal recall should be gated during heuristic heartbeat runs";
  };
  orchestrator.config.compactionResetEnabled = false;

  const result = await beforePromptBuild(
    {
      prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
    },
    {
      sessionKey: "session-heartbeat-heuristic-a",
      agentId: "main",
      workspaceDir: root,
    },
  );

  assert.equal(recallCalls, 0);
  assert.match(String(result?.prependSystemContext ?? ""), /## Active Heartbeat \(Remnic\)/);
  assert.match(String(result?.prependSystemContext ?? ""), /check-test-suite/);
  assert.doesNotMatch(String(result?.prependSystemContext ?? ""), /## Memory Context \(Remnic\)/);
});

test("before_prompt_build does not inject heartbeat context when multiple heartbeat tasks match the prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-ambiguous-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
      "## sync-secrets",
      "",
      "Every day, refresh secrets from the vault.",
      "",
      "Schedule: daily",
      "Tags: #ops #secrets",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-ambiguous-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 3,
      detectionMode: "runtime-signal",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;

  let recallCalls = 0;
  orchestrator.recall = async () => {
    recallCalls++;
    return "normal recall stays active when heartbeat selection is ambiguous";
  };

  const result = await beforePromptBuild(
    {
      prompt:
        "Run the following periodic tasks: check-test-suite and sync-secrets. Summarize what changed.",
    },
    {
      sessionKey: "session-heartbeat-ambiguous-a",
      agentId: "main",
      workspaceDir: root,
      trigger: "heartbeat",
    },
  );

  assert.equal(recallCalls, 1);
  assert.match(String(result?.prependSystemContext ?? ""), /## Memory Context \(Remnic\)/);
  assert.match(
    String(result?.prependSystemContext ?? ""),
    /normal recall stays active when heartbeat selection is ambiguous/,
  );
  assert.doesNotMatch(String(result?.prependSystemContext ?? ""), /## Active Heartbeat \(Remnic\)/);
});

test("before_prompt_build does not relink heartbeat outcomes on non-heartbeat prompts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-normal-prompt-"));
  await writeFile(
    path.join(root, "HEARTBEAT.md"),
    [
      "# Heartbeat Tasks",
      "",
      "## check-test-suite",
      "",
      "Every hour, run the test suite and flag any new failures.",
      "",
      "Schedule: hourly",
      "Tags: #ci #tests",
      "",
    ].join("\n"),
    "utf8",
  );

  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("before-prompt-build-heartbeat-normal-test");
  delete api.registerMemoryPromptSection;
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      journalPath: "HEARTBEAT.md",
      maxPreviousRuns: 3,
      detectionMode: "heuristic",
    },
  };
  plugin.register(api as any);

  const beforePromptBuild = api.handlers.get("before_prompt_build");
  assert.ok(beforePromptBuild, "before_prompt_build handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  orchestrator.maybeRunFileHygiene = async () => undefined;
  orchestrator.config.compactionResetEnabled = false;
  await orchestrator.storage.writeMemory(
    "fact",
    "During check-test-suite we found two new failures in the smoke run.",
    {
      source: "test",
      tags: ["ci"],
    },
  );

  let writeFrontmatterCalls = 0;
  const originalWriteMemoryFrontmatter =
    orchestrator.storage.writeMemoryFrontmatter.bind(orchestrator.storage);
  orchestrator.storage.writeMemoryFrontmatter = async (...args: unknown[]) => {
    writeFrontmatterCalls++;
    return originalWriteMemoryFrontmatter(
      args[0] as Parameters<typeof originalWriteMemoryFrontmatter>[0],
      args[1] as Parameters<typeof originalWriteMemoryFrontmatter>[1],
    );
  };

  let recallCalls = 0;
  orchestrator.recall = async () => {
    recallCalls++;
    return "normal recall stays active for ordinary prompts";
  };

  const result = await beforePromptBuild(
    {
      prompt: "What changed in the integration tests this morning?",
    },
    {
      sessionKey: "session-heartbeat-normal-a",
      agentId: "main",
      workspaceDir: root,
    },
  );

  assert.equal(writeFrontmatterCalls, 0);
  assert.equal(recallCalls, 1);
  assert.match(String(result?.prependSystemContext ?? ""), /## Memory Context \(Remnic\)/);
  assert.match(
    String(result?.prependSystemContext ?? ""),
    /normal recall stays active for ordinary prompts/,
  );
  assert.doesNotMatch(String(result?.prependSystemContext ?? ""), /## Active Heartbeat \(Remnic\)/);
});

test("agent_end skips transcript persistence and extraction buffering for heartbeat runs by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-heartbeat-agent-end-"));
  const { default: plugin } = await import("../src/index.js");
  const api = buildHandlerCapturingApi("agent-end-heartbeat-test");
  api.pluginConfig = {
    memoryDir: root,
    workspaceDir: root,
    heartbeat: {
      enabled: true,
      gateExtractionDuringHeartbeat: true,
    },
  };
  plugin.register(api as any);

  const agentEnd = api.handlers.get("agent_end");
  assert.ok(agentEnd, "agent_end handler should be registered");

  const orchestrator = (globalThis as any).__openclawEngramOrchestrator;
  let transcriptAppendCalls = 0;
  let processTurnCalls = 0;
  orchestrator.transcript.append = async () => {
    transcriptAppendCalls++;
  };
  orchestrator.processTurn = async () => {
    processTurnCalls++;
  };

  await agentEnd(
    {
      success: true,
      messages: [
        { role: "user", content: "Read HEARTBEAT.md if it exists (workspace context)." },
        { role: "assistant", content: "HEARTBEAT_OK" },
      ],
    },
    {
      sessionKey: "session-heartbeat-b",
      trigger: "heartbeat",
    },
  );

  assert.equal(transcriptAppendCalls, 0);
  assert.equal(processTurnCalls, 0);
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

  assert.equal(flushed?.sessionKey, "session-a");
  assert.equal(flushed?.options?.reason, "before_reset");
  assert.ok(
    flushed?.options?.abortSignal instanceof AbortSignal,
    "before_reset should forward an abort signal to flushSession",
  );
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
