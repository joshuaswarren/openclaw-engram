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

function ensurePackageBuild(pkgName, distPath) {
  if (fs.existsSync(distPath)) {
    return;
  }

  run(["--filter", pkgName, "build"]);
}

ensurePackageBuild(
  "@remnic/core",
  path.join(repoRoot, "packages", "remnic-core", "dist", "index.js"),
);
ensurePackageBuild(
  "@remnic/bench",
  path.join(repoRoot, "packages", "bench", "dist", "index.js"),
);
