import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Bridge mode detection — packages/plugin-openclaw/src/bridge.ts
// ---------------------------------------------------------------------------

test("detectBridgeMode defaults to embedded when no daemon running", async () => {
  // Clear any env override
  delete process.env.ENGRAM_BRIDGE_MODE;
  const { detectBridgeMode } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const config = detectBridgeMode();
  // Without a daemon running, should default to embedded
  assert.equal(config.mode, "embedded");
  assert.equal(config.daemonHost, "127.0.0.1");
  assert.ok(config.daemonPort > 0);
});

test("detectBridgeMode respects ENGRAM_BRIDGE_MODE=delegate", async () => {
  process.env.ENGRAM_BRIDGE_MODE = "delegate";
  // Re-import to pick up env change
  const bridgeMod = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const config = bridgeMod.detectBridgeMode();
  assert.equal(config.mode, "delegate");
  delete process.env.ENGRAM_BRIDGE_MODE;
});

test("detectBridgeMode respects ENGRAM_BRIDGE_MODE=embedded", async () => {
  process.env.ENGRAM_BRIDGE_MODE = "embedded";
  const bridgeMod = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const config = bridgeMod.detectBridgeMode();
  assert.equal(config.mode, "embedded");
  delete process.env.ENGRAM_BRIDGE_MODE;
});

test("checkDaemonHealth returns false when nothing is listening", async () => {
  const { checkDaemonHealth } = await import(path.join(ROOT, "packages/plugin-openclaw/src/bridge.ts"));
  const healthy = await checkDaemonHealth("127.0.0.1", 49999);
  assert.equal(healthy, false);
});

test("bridge service candidate helper falls through to legacy labels after a failure", async () => {
  const { firstSuccessfulResult } = await import(
    path.join(ROOT, "packages/plugin-openclaw/src/service-candidates.ts")
  );
  const calls: string[] = [];
  const result = firstSuccessfulResult(["ai.remnic.daemon", "ai.engram.daemon"], (candidate) => {
    calls.push(candidate);
    if (candidate === "ai.remnic.daemon") {
      throw new Error("canonical label missing");
    }
    return candidate;
  });
  assert.equal(result, "ai.engram.daemon");
  assert.deepEqual(calls, ["ai.remnic.daemon", "ai.engram.daemon"]);
});
