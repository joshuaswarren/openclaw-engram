import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Topological publish order: core first, then the à-la-carte companion
// packages (bench, weclone family, connector-replit) that install
// surfaces depend on, then the depend-on-core runtimes (server, CLI) and
// plugin bundles (openclaw + per-agent plugins), and finally the legacy
// shim that lives at the tail. Keep in sync with PUBLISH_ORDER in
// .github/workflows/release-and-publish.yml and AGENTS.md §44.
const expectedPublishDirs = [
  "packages/remnic-core",
  "packages/bench",
  "packages/export-weclone",
  "packages/import-weclone",
  "packages/import-chatgpt",
  "packages/import-claude",
  "packages/import-gemini",
  "packages/import-mem0",
  "packages/import-lossless-claw",
  "packages/connector-weclone",
  "packages/connector-replit",
  "packages/hermes-provider",
  "packages/remnic-server",
  "packages/remnic-cli",
  "packages/plugin-openclaw",
  "packages/plugin-claude-code",
  "packages/plugin-codex",
  "packages/shim-openclaw-engram",
] as const;

test("release workflow publish order matches the supported npm install surfaces", async () => {
  const workflow = await readFile(".github/workflows/release-and-publish.yml", "utf8");
  const publishOrderMatch = workflow.match(/PUBLISH_ORDER=\(\s*([\s\S]*?)\s*\)/);
  assert.ok(publishOrderMatch, "release workflow must define PUBLISH_ORDER");
  const publishDirs = [...publishOrderMatch[1].matchAll(/packages\/[A-Za-z0-9_-]+/g)].map((match) => match[0]);

  assert.deepEqual(publishDirs, [...expectedPublishDirs]);

  for (const pkgDir of expectedPublishDirs) {
    assert.match(
      workflow,
      new RegExp(`\\b${pkgDir.replace("/", "\\/")}\\b`),
      `release-and-publish.yml must publish ${pkgDir}`,
    );
  }
});
