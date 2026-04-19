import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function publicPackageDirs(): Promise<string[]> {
  const packagesDir = path.resolve("packages");
  const dirs = await readdir(packagesDir, { withFileTypes: true });
  const publicDirs: string[] = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(packagesDir, entry.name, "package.json");
    try {
      const raw = await readFile(pkgPath, "utf8");
      const pkg = JSON.parse(raw) as {
        private?: boolean;
        publishConfig?: { access?: string };
      };
      if (pkg.private) continue;
      if (pkg.publishConfig?.access !== "public") continue;
      publicDirs.push(`packages/${entry.name}`);
    } catch {
      continue;
    }
  }
  return publicDirs.sort();
}

test("release workflow publish order includes every public workspace package", async () => {
  const workflow = await readFile(".github/workflows/release-and-publish.yml", "utf8");
  const publicDirs = await publicPackageDirs();

  for (const pkgDir of publicDirs) {
    assert.match(
      workflow,
      new RegExp(`\\b${pkgDir.replace("/", "\\/")}\\b`),
      `release-and-publish.yml must publish ${pkgDir}`,
    );
  }
});
