import test from "node:test";
import assert from "node:assert/strict";
import {
  runDashboardStartCliCommand,
  runDashboardStatusCliCommand,
  runDashboardStopCliCommand,
} from "../src/cli.js";

test("dashboard CLI wrappers manage lifecycle", async () => {
  let running = false;
  const createServer = () => ({
    async start() {
      running = true;
      return {
        running: true,
        host: "127.0.0.1",
        port: 4319,
        watching: true,
        graphNodeCount: 2,
        graphEdgeCount: 1,
      };
    },
    async stop() {
      running = false;
    },
    status() {
      return {
        running,
        host: "127.0.0.1",
        port: 4319,
        watching: true,
        graphNodeCount: 2,
        graphEdgeCount: 1,
      };
    },
  });

  const start = await runDashboardStartCliCommand({
    memoryDir: "/tmp/engram",
    createServer,
  });
  assert.equal(start.running, true);

  const status = await runDashboardStatusCliCommand();
  assert.equal("running" in status ? status.running : false, true);

  const stop = await runDashboardStopCliCommand();
  assert.deepEqual(stop, { stopped: true });
});

test("dashboard stop is idempotent when not running", async () => {
  await runDashboardStopCliCommand();
  const result = await runDashboardStopCliCommand();
  assert.deepEqual(result, { stopped: false });
});

