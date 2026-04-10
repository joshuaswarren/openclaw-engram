import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const testDir = new URL(".", import.meta.url);

const packageExpectations = [
  {
    label: "CLI",
    path: new URL("../packages/remnic-cli/package.json", testDir),
    deps: {
      "@remnic/core": "workspace:^",
    },
  },
  {
    label: "server",
    path: new URL("../packages/remnic-server/package.json", testDir),
    deps: {
      "@remnic/core": "workspace:^",
    },
  },
  {
    label: "OpenClaw plugin",
    path: new URL("../packages/plugin-openclaw/package.json", testDir),
    deps: {
      "@remnic/core": "workspace:^",
    },
  },
] as const;

test("runtime workspace packages preserve local linking in source manifests", async () => {
  for (const pkgSpec of packageExpectations) {
    const raw = await readFile(pkgSpec.path, "utf8");
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };

    for (const [depName, expectedRange] of Object.entries(pkgSpec.deps)) {
      assert.equal(
        pkg.dependencies?.[depName],
        expectedRange,
        `${pkgSpec.label} should use ${expectedRange} for ${depName}`,
      );
    }
  }
});
