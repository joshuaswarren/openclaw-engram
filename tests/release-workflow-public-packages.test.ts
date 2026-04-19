import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedPublishDirs = [
  "packages/remnic-core",
  "packages/remnic-server",
  "packages/remnic-cli",
  "packages/hermes-provider",
  "packages/plugin-openclaw",
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
