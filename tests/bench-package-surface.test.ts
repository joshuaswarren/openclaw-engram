import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("@remnic/bench publishes compiled entrypoints instead of raw source paths", async () => {
  const pkg = JSON.parse(
    await readFile("packages/bench/package.json", "utf8"),
  ) as {
    main?: string;
    types?: string;
    exports?: { ".": { import?: string; types?: string } };
    files?: string[];
    scripts?: Record<string, string>;
  };

  assert.equal(pkg.main, "./dist/index.js");
  assert.equal(pkg.types, "./dist/index.d.ts");
  assert.equal(pkg.exports?.["."]?.import, "./dist/index.js");
  assert.equal(pkg.exports?.["."]?.types, "./dist/index.d.ts");
  assert.deepEqual(pkg.files, ["dist"]);
  assert.equal(pkg.scripts?.build, "tsup --config tsup.config.ts");
});
