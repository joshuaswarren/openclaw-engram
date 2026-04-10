import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("remnic CLI bundles the private bench package instead of publishing it as a runtime dependency", async () => {
  const raw = await readFile("packages/remnic-cli/package.json", "utf8");
  const pkg = JSON.parse(raw) as {
    scripts?: { build?: string };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.match(pkg.scripts?.build ?? "", /--no-external @remnic\/bench/);
  assert.equal(pkg.dependencies?.["@remnic/bench"], undefined);
  assert.equal(pkg.devDependencies?.["@remnic/bench"], "workspace:*");
});
