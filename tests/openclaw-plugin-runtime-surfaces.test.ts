import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const REQUIRED_RUNTIME_SURFACE_KEYS = [
  "openclawToolsEnabled",
  "openclawToolSnippetMaxChars",
  "sessionTogglesEnabled",
  "verboseRecallVisibility",
  "recallTranscriptsEnabled",
  "recallTranscriptRetentionDays",
  "respectBundledActiveMemoryToggle",
  "activeRecallEnabled",
  "activeRecallAgents",
  "activeRecallAllowedChatTypes",
  "activeRecallQueryMode",
  "activeRecallPromptStyle",
  "activeRecallPromptOverride",
  "activeRecallPromptAppend",
  "activeRecallMaxSummaryChars",
  "activeRecallRecentUserTurns",
  "activeRecallRecentAssistantTurns",
  "activeRecallRecentUserChars",
  "activeRecallRecentAssistantChars",
  "activeRecallThinking",
  "activeRecallTimeoutMs",
  "activeRecallCacheTtlMs",
  "activeRecallModel",
  "activeRecallModelFallbackPolicy",
  "activeRecallPersistTranscripts",
  "activeRecallTranscriptDir",
  "activeRecallEntityGraphDepth",
  "activeRecallIncludeCausalTrajectories",
  "activeRecallIncludeDaySummary",
  "activeRecallAttachRecallExplain",
  "activeRecallAllowChainedActiveMemory",
];

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
    assert.deepEqual(
      REQUIRED_RUNTIME_SURFACE_KEYS.filter((key) => !(key in properties)),
      [],
      "runtime-surface manifest must advertise every parser-supported OpenClaw config key",
    );
    assert.deepEqual(
      properties.activeRecallQueryMode?.enum,
      ["recent", "message", "full"],
    );
    assert.deepEqual(
      properties.activeRecallPromptStyle?.enum,
      [
        "balanced",
        "strict",
        "contextual",
        "recall-heavy",
        "precision-heavy",
        "preference-only",
      ],
    );
    assert.deepEqual(
      properties.activeRecallThinking?.enum,
      ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"],
    );
    assert.equal(properties.activeRecallCacheTtlMs?.minimum, 0);
    assert.equal(properties.activeRecallCacheTtlMs?.default, 15000);

    assert.ok(properties.codexCompat, "codexCompat config block should exist");
    assert.deepEqual(
      Object.keys(properties.codexCompat.properties ?? {}).sort(),
      ["compactionFlushMode", "enabled", "fingerprintDedup", "threadIdBufferKeying"],
    );

    const maxEntries = properties.dreaming.properties?.maxEntries;
    assert.ok(
      Array.isArray(maxEntries?.anyOf),
      "dreaming.maxEntries should use an explicit 0-or-10+ schema",
    );
    assert.deepEqual(
      maxEntries.anyOf,
      [
        { type: "integer", const: 0 },
        { type: "integer", minimum: 10, maximum: 10000 },
      ],
      "dreaming.maxEntries must allow the runtime disable switch without advertising unsupported 1..9 values",
    );
  });
}
