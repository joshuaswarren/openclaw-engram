import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("remnic CLI bundles private bench helpers instead of publishing them as runtime dependencies", async () => {
  const [pkgRaw, tsupRaw, buildHelperRaw] = await Promise.all([
    readFile("packages/remnic-cli/package.json", "utf8"),
    readFile("packages/remnic-cli/tsup.config.ts", "utf8"),
    readFile("scripts/ensure-cli-bench-build-deps.mjs", "utf8"),
  ]);
  const pkg = JSON.parse(pkgRaw) as {
    scripts?: { prebuild?: string; build?: string };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.equal(pkg.scripts?.prebuild, "node ../../scripts/ensure-cli-bench-build-deps.mjs");
  assert.match(pkg.scripts?.build ?? "", /^tsup --config tsup\.config\.ts(\s+&&\s+.+)?$/);
  assert.match(tsupRaw, /noExternal:\s*\["@remnic\/bench", "@remnic\/export-weclone"\]/);
  assert.match(buildHelperRaw, /"@remnic\/core"/);
  assert.match(buildHelperRaw, /"@remnic\/bench"/);
  assert.match(buildHelperRaw, /"@remnic\/export-weclone"/);
  assert.match(buildHelperRaw, /packages", "remnic-core", "dist", "index\.js"/);
  assert.match(buildHelperRaw, /packages", "bench", "dist", "index\.js"/);
  assert.match(buildHelperRaw, /packages", "export-weclone", "dist", "index\.js"/);
  assert.equal(pkg.dependencies?.["@remnic/bench"], undefined);
  assert.equal(pkg.dependencies?.["@remnic/export-weclone"], undefined);
  assert.equal(pkg.devDependencies?.["@remnic/bench"], "workspace:*");
  assert.equal(pkg.devDependencies?.["@remnic/export-weclone"], "workspace:*");
});
