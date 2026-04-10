import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const GLOBAL_KEYS = [
  "__openclawEngramRegistered",
  "__openclawEngramHookApis",
  "__openclawEngramOrchestrator",
  "__openclawEngramAccessService",
  "__openclawEngramAccessHttpServer",
  "__openclawEngramServiceStarted",
  "__openclawEngramInitPromise",
  "__openclawEngramMigrationPromise",
];

function resetGlobals(): void {
  for (const key of GLOBAL_KEYS) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

function buildApi() {
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    pluginConfig: {},
    config: {},
    registerTool() {},
    registerCli() {},
    registerService() {},
    on() {},
  };
}

test.beforeEach(() => resetGlobals());
test.afterEach(() => resetGlobals());

test("plugin register triggers the first-run Engram migration path", async () => {
  const previousHome = process.env.HOME;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-register-migrate-"));

  try {
    process.env.HOME = homeDir;
    await mkdir(path.join(homeDir, ".engram"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".engram", "tokens.json"),
      JSON.stringify({ tokens: [] }),
      "utf8",
    );

    const { default: plugin } = await import("../src/index.js");
    plugin.register(buildApi() as any);

    await (globalThis as Record<string, Promise<unknown>>).__openclawEngramMigrationPromise;

    assert.equal(
      existsSync(path.join(homeDir, ".remnic", ".migrated-from-engram")),
      true,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
