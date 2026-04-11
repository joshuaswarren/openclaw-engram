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
  // Note: @remnic/plugin-openclaw intentionally has no @remnic/core dependency —
  // it does not import @remnic/core at runtime. Keeping it would cause the
  // workspace:^ protocol string to appear verbatim in the published package
  // metadata when released via npm publish (see issue #403).
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
