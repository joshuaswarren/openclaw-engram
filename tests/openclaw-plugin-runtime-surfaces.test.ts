import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function readManifest(relativePath: string): Record<string, any> {
  const raw = fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
  return JSON.parse(raw) as Record<string, any>;
}

for (const manifestPath of [
  "openclaw.plugin.json",
  "packages/plugin-openclaw/openclaw.plugin.json",
]) {
  test(`${manifestPath} advertises the v2026.4.10 runtime capability surfaces`, () => {
    const manifest = readManifest(manifestPath);

    assert.deepEqual(manifest.supports, {
      memorySlot: true,
      dreamingSlot: true,
      activeMemory: true,
      heartbeat: true,
      commandsList: true,
      beforeReset: true,
    });
  });

  test(`${manifestPath} accepts slot, reset, and codex compatibility config blocks`, () => {
    const manifest = readManifest(manifestPath);
    const properties = manifest.configSchema?.properties ?? {};

    assert.ok(properties.dreaming, "dreaming config block should exist");
    assert.deepEqual(
      Object.keys(properties.dreaming.properties ?? {}).sort(),
      [
        "enabled",
        "injectRecentCount",
        "journalPath",
        "maxEntries",
        "minIntervalMinutes",
        "narrativeModel",
        "narrativePromptStyle",
        "watchFile",
      ],
    );
    assert.ok(properties.heartbeat, "heartbeat config block should exist");
    assert.deepEqual(
      Object.keys(properties.heartbeat.properties ?? {}).sort(),
      [
        "detectionMode",
        "enabled",
        "gateExtractionDuringHeartbeat",
        "journalPath",
        "maxPreviousRuns",
        "watchFile",
      ],
    );

    assert.ok(properties.slotBehavior, "slotBehavior config block should exist");
    assert.deepEqual(
      Object.keys(properties.slotBehavior.properties ?? {}).sort(),
      ["onSlotMismatch", "requireExclusiveMemorySlot"],
    );

    assert.equal(properties.beforeResetTimeoutMs?.default, 2000);
    assert.equal(properties.flushOnResetEnabled?.default, true);
    assert.equal(properties.commandsListEnabled?.default, true);

    assert.ok(properties.codexCompat, "codexCompat config block should exist");
    assert.deepEqual(
      Object.keys(properties.codexCompat.properties ?? {}).sort(),
      ["compactionFlushMode", "enabled", "fingerprintDedup", "threadIdBufferKeying"],
    );

    assert.equal(
      properties.dreaming.properties?.maxEntries?.minimum,
      0,
      "dreaming.maxEntries must allow 0 so the runtime hard-disable switch remains reachable",
    );
  });
}
