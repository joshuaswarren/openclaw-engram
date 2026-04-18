import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionCommandDescriptors } from "./session-command-descriptors.js";

test("buildSessionCommandDescriptors wires toggle and status handlers", async () => {
  const disabled = new Map<string, boolean>();
  const recallCalls: string[] = [];
  const summaryCalls: string[] = [];
  const runtime = {
    toggles: {
      async isDisabled(sessionKey: string, agentId: string) {
        return disabled.get(`${sessionKey}:${agentId}`) === true;
      },
      async resolve(sessionKey: string, agentId: string) {
        const key = `${sessionKey}:${agentId}`;
        return {
          disabled: disabled.get(key) === true,
          source: disabled.has(key) ? ("primary" as const) : ("none" as const),
        };
      },
      async setDisabled(sessionKey: string, agentId: string, next: boolean) {
        disabled.set(`${sessionKey}:${agentId}`, next);
      },
      async clear(sessionKey: string, agentId: string) {
        disabled.delete(`${sessionKey}:${agentId}`);
      },
      async list() {
        return [];
      },
    },
    getLastRecall(sessionKey: string) {
      recallCalls.push(sessionKey);
      return {
        memoryIds: ["mem-1", "mem-2"],
        latencyMs: 33,
        plannerMode: "minimal",
      };
    },
    getLastRecallSummary(sessionKey: string) {
      summaryCalls.push(sessionKey);
      return "CI recovered after the flaky worker drain.";
    },
    async flushSession() {},
  };

  const [group] = buildSessionCommandDescriptors("openclaw-remnic", runtime);
  assert.equal(group?.name, "remnic");
  const subcommands = (group?.subcommands ?? []) as Array<{
    name: string;
    handler: (ctx?: { sessionKey?: string; agentId?: string }) => Promise<string>;
  }>;

  const off = subcommands.find((entry) => entry.name === "off");
  const status = subcommands.find((entry) => entry.name === "status");
  const clear = subcommands.find((entry) => entry.name === "clear");
  assert.ok(off && status && clear, "expected command handlers to be present");

  await off.handler({ sessionKey: "session-a", agentId: "main" });
  assert.equal(disabled.get("session-a:main"), true);

  const statusText = await status.handler({ sessionKey: "session-a", agentId: "main" });
  assert.match(statusText, /disabled/);
  assert.match(statusText, /CI recovered/);
  assert.deepEqual(recallCalls, ["session-a"]);
  assert.deepEqual(summaryCalls, ["session-a"]);

  await clear.handler({ sessionKey: "session-a", agentId: "main" });
  assert.equal(disabled.has("session-a:main"), false);
});

test("top-level descriptor satisfies OpenClaw registerCommand validator and dispatches subcommands", async () => {
  const disabled = new Map<string, boolean>();
  const runtime = {
    toggles: {
      async isDisabled() {
        return false;
      },
      async resolve(sessionKey: string, agentId: string) {
        const key = `${sessionKey}:${agentId}`;
        return {
          disabled: disabled.get(key) === true,
          source: disabled.has(key) ? ("primary" as const) : ("none" as const),
        };
      },
      async setDisabled(sessionKey: string, agentId: string, next: boolean) {
        disabled.set(`${sessionKey}:${agentId}`, next);
      },
      async clear(sessionKey: string, agentId: string) {
        disabled.delete(`${sessionKey}:${agentId}`);
      },
      async list() {
        return [];
      },
    },
    getLastRecall() {
      return null;
    },
    getLastRecallSummary() {
      return null;
    },
    async flushSession() {},
  };

  const [group] = buildSessionCommandDescriptors("openclaw-remnic", runtime);
  const descriptor = group as unknown as {
    name: string;
    description: string;
    acceptsArgs: boolean;
    handler: (ctx?: { sessionKey?: string; agentId?: string; args?: readonly string[] }) => Promise<string>;
  };

  // Shape required by openclaw's validatePluginCommandDefinition
  // (see openclaw/dist/command-registration:*).
  assert.equal(typeof descriptor.handler, "function");
  assert.equal(typeof descriptor.description, "string");
  assert.ok(descriptor.description.trim().length > 0);
  assert.equal(descriptor.acceptsArgs, true);

  await descriptor.handler({ args: ["off"], sessionKey: "session-b", agentId: "main" });
  assert.equal(disabled.get("session-b:main"), true);

  const statusText = await descriptor.handler({
    args: ["status"],
    sessionKey: "session-b",
    agentId: "main",
  });
  assert.match(statusText, /disabled/);

  const unknownText = await descriptor.handler({
    args: ["bogus"],
    sessionKey: "session-b",
    agentId: "main",
  });
  assert.match(unknownText, /Unknown Remnic subcommand "bogus"/);

  // No args => defaults to status.
  const defaultText = await descriptor.handler({ sessionKey: "session-b", agentId: "main" });
  assert.match(defaultText, /Remnic recall is/);
});
