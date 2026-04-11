/**
 * Regression test for the plugin id split (#403).
 *
 * Asserts that:
 *   - @remnic/plugin-openclaw and the root manifest use the canonical id "openclaw-remnic"
 *   - @joshuaswarren/openclaw-engram (shim) intentionally keeps the legacy id "openclaw-engram"
 *   - The PLUGIN_ID constant exported from @remnic/core matches the two non-shim manifests
 *   - LEGACY_PLUGIN_ID matches the shim manifest
 *
 * This test locks the id split in place so a future refactor cannot silently
 * revert the rename or break the shim's backwards-compat guarantee.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ID, LEGACY_PLUGIN_ID } from "../packages/remnic-core/src/plugin-id.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PACKAGES_DIR = path.join(ROOT, "packages");

function readManifestId(manifestPath: string): string {
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(raw) as { id?: string };
  assert.ok(typeof manifest.id === "string", `${manifestPath} must have a string "id" field`);
  return manifest.id as string;
}

test("PLUGIN_ID constant equals 'openclaw-remnic'", () => {
  assert.equal(PLUGIN_ID, "openclaw-remnic");
});

test("LEGACY_PLUGIN_ID constant equals 'openclaw-engram'", () => {
  assert.equal(LEGACY_PLUGIN_ID, "openclaw-engram");
});

test("root openclaw.plugin.json declares id 'openclaw-remnic'", () => {
  const id = readManifestId(path.join(ROOT, "openclaw.plugin.json"));
  assert.equal(
    id,
    PLUGIN_ID,
    `Root manifest id must be "${PLUGIN_ID}" (got "${id}")`,
  );
});

test("packages/plugin-openclaw/openclaw.plugin.json declares id 'openclaw-remnic'", () => {
  const manifestPath = path.join(PACKAGES_DIR, "plugin-openclaw", "openclaw.plugin.json");
  const id = readManifestId(manifestPath);
  assert.equal(
    id,
    PLUGIN_ID,
    `plugin-openclaw manifest id must be "${PLUGIN_ID}" (got "${id}") — see #403`,
  );
});

test("packages/shim-openclaw-engram/openclaw.plugin.json declares id 'openclaw-engram' (legacy compat)", () => {
  const manifestPath = path.join(PACKAGES_DIR, "shim-openclaw-engram", "openclaw.plugin.json");
  const id = readManifestId(manifestPath);
  assert.equal(
    id,
    LEGACY_PLUGIN_ID,
    `shim manifest id must stay "${LEGACY_PLUGIN_ID}" for backwards compat (got "${id}") — see #403`,
  );
});

test("plugin id split: non-shim ids match PLUGIN_ID and shim id matches LEGACY_PLUGIN_ID", () => {
  const rootId = readManifestId(path.join(ROOT, "openclaw.plugin.json"));
  const pluginId = readManifestId(path.join(PACKAGES_DIR, "plugin-openclaw", "openclaw.plugin.json"));
  const shimId = readManifestId(path.join(PACKAGES_DIR, "shim-openclaw-engram", "openclaw.plugin.json"));

  assert.equal(rootId, PLUGIN_ID, "root manifest must match PLUGIN_ID");
  assert.equal(pluginId, PLUGIN_ID, "plugin-openclaw manifest must match PLUGIN_ID");
  assert.equal(shimId, LEGACY_PLUGIN_ID, "shim manifest must match LEGACY_PLUGIN_ID (backwards compat)");
  assert.notEqual(PLUGIN_ID, LEGACY_PLUGIN_ID, "PLUGIN_ID and LEGACY_PLUGIN_ID must be distinct");
});
