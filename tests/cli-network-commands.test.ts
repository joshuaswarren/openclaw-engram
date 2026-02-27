import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  runTailscaleStatusCliCommand,
  runTailscaleSyncCliCommand,
  runWebDavServeCliCommand,
  runWebDavStopCliCommand,
} from "../src/cli.js";

test("tailscale-status CLI wrapper returns helper status", async () => {
  const status = await runTailscaleStatusCliCommand({
    helper: {
      async status() {
        return {
          available: true,
          running: true,
          backendState: "Running",
          version: "1.80.0",
          selfHostname: "engram-node",
          selfIp: "100.90.10.20",
        };
      },
      async syncDirectory() {
        throw new Error("not used");
      },
    },
  });

  assert.equal(status.available, true);
  assert.equal(status.running, true);
  assert.equal(status.selfHostname, "engram-node");
});

test("tailscale-sync CLI wrapper passes options through", async () => {
  const calls: Array<{
    sourceDir: string;
    destination: string;
    delete?: boolean;
    dryRun?: boolean;
    extraArgs?: string[];
  }> = [];

  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-ts-sync-"));

  const result = await runTailscaleSyncCliCommand({
    sourceDir,
    destination: "peer:/srv/engram",
    delete: true,
    dryRun: true,
    extraArgs: ["--numeric-ids"],
    helper: {
      async status() {
        return { available: true, running: true };
      },
      async syncDirectory(options) {
        calls.push(options);
      },
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    sourceDir,
    destination: "peer:/srv/engram",
    delete: true,
    dryRun: true,
    extraArgs: ["--numeric-ids"],
  });
});

test("webdav serve/stop CLI wrappers manage server lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-cli-webdav-"));

  const started = await runWebDavServeCliCommand({
    host: "127.0.0.1",
    port: 0,
    allowlistDirs: [root],
  });

  assert.equal(started.running, true);
  assert.equal(started.rootCount, 1);
  assert.ok(started.port > 0);

  const stopResult = await runWebDavStopCliCommand();
  assert.deepEqual(stopResult, { stopped: true });

  const stopAgain = await runWebDavStopCliCommand();
  assert.deepEqual(stopAgain, { stopped: false });
});

test("webdav serve wrapper requires both auth fields when either is set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-cli-webdav-auth-"));

  await assert.rejects(
    () =>
      runWebDavServeCliCommand({
        allowlistDirs: [root],
        authUsername: "engram",
      }),
    /requires both username and password/i,
  );

  await assert.rejects(
    () =>
      runWebDavServeCliCommand({
        allowlistDirs: [root],
        authPassword: "secret",
      }),
    /requires both username and password/i,
  );
});
