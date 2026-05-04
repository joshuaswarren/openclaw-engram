import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureOpenClawRegistrationApi,
  disableRegisterMigrationForCaptureTest,
  restoreOpenClawRegistrationGlobals,
  restoreRegisterMigrationForCaptureTest,
  saveAndResetOpenClawRegistrationGlobals,
} from "./helpers/openclaw-registration-harness.js";

const SERVICE_ID = "openclaw-remnic";
const ORCHESTRATOR_KEY = `__openclawEngramOrchestrator::${SERVICE_ID}`;

type ToolSpec = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    ctx?: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

type ScenarioContext = {
  capture: ReturnType<typeof captureOpenClawRegistrationApi>;
  orchestrator: Record<string, any>;
  memoryDir: string;
};

async function withScenarioRegistration(
  fn: (context: ScenarioContext) => Promise<void> | void,
  options: Parameters<typeof captureOpenClawRegistrationApi>[0] = {},
) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-scenario-"));
  const saved = saveAndResetOpenClawRegistrationGlobals();
  const previousMigration = disableRegisterMigrationForCaptureTest();
  try {
    const { default: plugin } = await import("../src/index.js");
    const capture = captureOpenClawRegistrationApi({
      ...options,
      pluginConfig: {
        memoryDir,
        modelSource: "gateway",
        qmdEnabled: false,
        transcriptEnabled: false,
        hourlySummariesEnabled: false,
        ...options.pluginConfig,
      },
    });

    (plugin as { register(api: unknown): void }).register(capture.api);
    const orchestrator = (globalThis as Record<string, any>)[ORCHESTRATOR_KEY];
    if (options.registrationMode !== "setup-only") {
      assert.ok(orchestrator, "registration should expose the Remnic orchestrator");
    }

    await fn({ capture, orchestrator: orchestrator ?? {}, memoryDir });
  } finally {
    restoreRegisterMigrationForCaptureTest(previousMigration);
    restoreOpenClawRegistrationGlobals(saved);
    fs.rmSync(memoryDir, { force: true, recursive: true });
  }
}

test("scenario: memory_store writes through the registered tool and memory_search routes through active memory search", async () => {
  await withScenarioRegistration(async ({ capture, orchestrator }) => {
    const store = registeredTool(capture, "memory_store");
    const storeResult = await store.execute("store-1", {
      content: "The user prefers compact dashboards for operational tools.",
      category: "preference",
      tags: ["scenario"],
    });

    assert.match(resultText(storeResult), /Memory stored:/);

    let searched = false;
    orchestrator.searchAcrossNamespaces = async (params: Record<string, unknown>) => {
      searched = true;
      assert.equal(params.query, "compact dashboards");
      assert.deepEqual(params.namespaces, ["default"]);
      return [
        {
          id: "memory-dashboard-preference",
          score: 0.97,
          snippet: "The user prefers compact dashboards for operational tools.",
          metadata: { source: "scenario" },
        },
      ];
    };

    const search = registeredTool(capture, "memory_search");
    const searchResult = await search.execute(
      "search-1",
      { query: "compact dashboards", limit: 1 },
      undefined,
      { sessionKey: "scenario-session" },
    );
    const payload = JSON.parse(resultText(searchResult));

    assert.equal(searched, true);
    assert.equal(payload.results[0].id, "memory-dashboard-preference");
    assert.match(payload.results[0].text, /compact dashboards/);
  });
});

test("scenario: prompt injection precomputes recall and serves the cached prompt-section builder", async () => {
  await withScenarioRegistration(async ({ capture, orchestrator }) => {
    let recallCount = 0;
    orchestrator.recall = async (query: string, sessionKey: string) => {
      recallCount += 1;
      assert.match(query, /dashboard/);
      assert.equal(sessionKey, "prompt-session");
      return "Remember that the user prefers compact dashboards.";
    };

    const beforePromptBuild = registeredHook(capture, "before_prompt_build");
    const hookResult = await beforePromptBuild(
      { prompt: "Please design a dashboard for repeated operational review." },
      { sessionKey: "prompt-session" },
    );

    const promptSectionBuilder = capture.registrations("registerMemoryPromptSection")[0]?.[0] as
      | ((params: { availableTools: Set<string> }) => string[])
      | undefined;
    assert.equal(typeof promptSectionBuilder, "function");
    const lines = promptSectionBuilder({
      availableTools: new Set(["memory_search"]),
      sessionKey: "prompt-session",
    } as never);

    assert.equal(recallCount, 1);
    assert.equal(hookResult, undefined);
    assert.match(lines.join("\n"), /Memory Context \(Remnic\)/);
    assert.match(lines.join("\n"), /compact dashboards/);
  });
});

test("scenario: agent_end buffers the last user and assistant turns without live extraction", async () => {
  await withScenarioRegistration(async ({ capture, orchestrator }) => {
    const processed: Array<{
      role: string;
      content: string;
      sessionKey: string;
      options: Record<string, unknown>;
    }> = [];
    orchestrator.processTurn = async (
      role: string,
      content: string,
      sessionKey: string,
      options: Record<string, unknown>,
    ) => {
      processed.push({ role, content, sessionKey, options });
    };

    const agentEnd = registeredHook(capture, "agent_end");
    await agentEnd(
      {
        success: true,
        messages: [
          { role: "system", content: "system metadata should be ignored" },
          { role: "user", content: "Please remember the compact dashboard preference." },
          { role: "assistant", content: "I will keep the dashboard compact." },
        ],
      },
      { sessionKey: "agent-session" },
    );

    assert.deepEqual(processed.map((turn) => turn.role), ["user", "assistant"]);
    assert.deepEqual(processed.map((turn) => turn.sessionKey), [
      "agent-session",
      "agent-session",
    ]);
    assert.match(processed[0].content, /compact dashboard preference/);
    assert.equal(processed[0].options.logicalSessionKey, "agent-session");
    assert.equal(processed[0].options.bufferKey, "agent-session");
  });
});

test("scenario: before_reset and session_end drain discovered buffers with explicit reasons", async () => {
  await withScenarioRegistration(async ({ capture, orchestrator }) => {
    const flushes: Array<{ sessionKey: string; reason: string; bufferKey: string }> = [];
    orchestrator.buffer.findBufferKeysForSession = async () => ["lifecycle-session", "secondary-buffer"];
    orchestrator.buffer.getTurns = (bufferKey: string) =>
      bufferKey === "secondary-buffer" ? [{ role: "user", content: "buffered" }] : [];
    orchestrator.flushSession = async (
      sessionKey: string,
      options: { reason: string; bufferKey: string },
    ) => {
      flushes.push({ sessionKey, reason: options.reason, bufferKey: options.bufferKey });
    };

    await registeredHook(capture, "before_reset")(
      { sessionKey: "lifecycle-session" },
      {},
    );
    await registeredHook(capture, "session_end")(
      { sessionKey: "lifecycle-session" },
      {},
    );

    assert.deepEqual(flushes, [
      {
        sessionKey: "lifecycle-session",
        reason: "before_reset",
        bufferKey: "lifecycle-session",
      },
      {
        sessionKey: "lifecycle-session",
        reason: "before_reset",
        bufferKey: "secondary-buffer",
      },
      {
        sessionKey: "lifecycle-session",
        reason: "session_end",
        bufferKey: "lifecycle-session",
      },
      {
        sessionKey: "lifecycle-session",
        reason: "session_end",
        bufferKey: "secondary-buffer",
      },
    ]);
  }, {
    pluginConfig: {
      flushOnResetEnabled: true,
      beforeResetTimeoutMs: 1000,
    },
  });
});

test("scenario: passive slot and setup-only registrations stay inert for active memory hooks", async () => {
  await withScenarioRegistration(({ capture }) => {
    assert.deepEqual(capture.hooks(), []);
    assert.equal(capture.registrations("registerMemoryCapability").length, 0);
    assert.ok(capture.registrationNames("registerTool").includes("memory_search"));
  }, {
    config: {
      plugins: {
        slots: {
          memory: "another-memory-plugin",
        },
      },
    },
    pluginConfig: {
      slotBehavior: {
        onSlotMismatch: "silent",
      },
    },
  });

  await withScenarioRegistration(({ capture }) => {
    assert.deepEqual(capture.hooks(), []);
    assert.deepEqual(capture.registrations(), []);
  }, {
    registrationMode: "setup-only",
  });
});

function registeredTool(
  capture: ReturnType<typeof captureOpenClawRegistrationApi>,
  name: string,
): ToolSpec {
  const tool = capture
    .registrations("registerTool")
    .map(([spec]) => spec as ToolSpec)
    .find((spec) => spec.name === name);
  assert.ok(tool, `expected registered tool ${name}`);
  return tool;
}

function registeredHook(
  capture: ReturnType<typeof captureOpenClawRegistrationApi>,
  name: string,
) {
  const handler = capture.hooks(name)[0]?.[1];
  assert.equal(typeof handler, "function", `expected registered hook ${name}`);
  return handler as (
    event: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<unknown>;
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}
