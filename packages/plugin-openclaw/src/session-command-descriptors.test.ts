import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionCommandDescriptors } from "./session-command-descriptors.js";

test("buildSessionCommandDescriptors wires toggle and status handlers", async () => {
  const disabled = new Map<string, boolean>();
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
    getLastRecall() {
      return {
        memoryIds: ["mem-1", "mem-2"],
        latencyMs: 33,
        plannerMode: "minimal",
      };
    },
    getLastRecallSummary() {
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

  await clear.handler({ sessionKey: "session-a", agentId: "main" });
  assert.equal(disabled.has("session-a:main"), false);
});
