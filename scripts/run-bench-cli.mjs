import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(args) {
  const result = spawnSync(pnpmCmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}

const coreDistPath = path.join(repoRoot, "packages", "remnic-core", "dist", "index.js");
const benchDistPath = path.join(repoRoot, "packages", "bench", "dist", "index.js");
const benchSourcePaths = [
  path.join(repoRoot, "packages", "bench", "src"),
  path.join(repoRoot, "packages", "bench", "package.json"),
  path.join(repoRoot, "packages", "bench", "tsup.config.ts"),
  path.join(repoRoot, "packages", "bench", "tsconfig.json"),
];

if (!fs.existsSync(coreDistPath)) {
  run(["--filter", "@remnic/core", "build"]);
}

if (!fs.existsSync(benchDistPath) || isAnySourceNewerThan(benchSourcePaths, benchDistPath)) {
  run(["--filter", "@remnic/bench", "build"]);
}

run(["exec", "tsx", "packages/remnic-cli/src/index.ts", "bench", ...process.argv.slice(2)]);

function isAnySourceNewerThan(sourcePaths, distPath) {
  const distMtimeMs = fs.statSync(distPath).mtimeMs;
  const newestSource = newestMtime(sourcePaths);
  return newestSource !== undefined && newestSource > distMtimeMs + 1000;
}

function newestMtime(paths) {
  let newest;
  const visit = (entryPath) => {
    if (!fs.existsSync(entryPath)) {
      return;
    }
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entryPath)) {
        visit(path.join(entryPath, child));
      }
      return;
    }
    if (stat.isFile()) {
      newest = newest === undefined ? stat.mtimeMs : Math.max(newest, stat.mtimeMs);
    }
  };
  for (const sourcePath of paths) {
    visit(sourcePath);
  }
  return newest;
}
