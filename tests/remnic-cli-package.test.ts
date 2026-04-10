import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("remnic CLI bundles the private bench package instead of publishing it as a runtime dependency", async () => {
  const [pkgRaw, tsupRaw] = await Promise.all([
    readFile("packages/remnic-cli/package.json", "utf8"),
    readFile("packages/remnic-cli/tsup.config.ts", "utf8"),
  ]);
  const pkg = JSON.parse(pkgRaw) as {
    scripts?: { build?: string };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.equal(pkg.scripts?.build, "tsup --config tsup.config.ts");
  assert.match(tsupRaw, /noExternal:\s*\["@remnic\/bench"\]/);
  assert.equal(pkg.dependencies?.["@remnic/bench"], undefined);
  assert.equal(pkg.devDependencies?.["@remnic/bench"], "workspace:*");
});
