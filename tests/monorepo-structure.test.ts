import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PACKAGES_DIR = path.join(ROOT, "packages");

// Expected packages after the monorepo migration
const EXPECTED_PACKAGES = [
  { dir: "remnic-core", name: "@remnic/core" },
  { dir: "remnic-server", name: "@remnic/server" },
  { dir: "remnic-cli", name: "@remnic/cli" },
  { dir: "plugin-openclaw", name: "@remnic/plugin-openclaw" },
  { dir: "plugin-claude-code", name: "@remnic/plugin-claude-code" },
  { dir: "plugin-codex", name: "@remnic/plugin-codex" },
  { dir: "connector-replit", name: "@remnic/replit" },
  { dir: "bench", name: "@remnic/bench" },
];

// Packages that must exist NOW (renamed to target names)
const REQUIRED_NOW = [
  "remnic-core",
  "remnic-server",
  "remnic-cli",
];

test("packages/ directory exists", () => {
  assert.ok(fs.existsSync(PACKAGES_DIR), "packages/ directory must exist");
});

test("each required package has a package.json", () => {
  const dirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const req of REQUIRED_NOW) {
    const found = dirs.some((d) => d === req);
    assert.ok(found, `Required package "${req}" must exist in packages/`);

    const dirName = dirs.find((d) => d === req)!;
    const pkgJsonPath = path.join(PACKAGES_DIR, dirName, "package.json");
    assert.ok(fs.existsSync(pkgJsonPath), `${dirName}/package.json must exist`);
  }
});

test("every package.json has required fields", () => {
  const dirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const dir of dirs) {
    const pkgJsonPath = path.join(PACKAGES_DIR, dir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));

    assert.ok(typeof pkg.name === "string" && pkg.name.length > 0,
      `${dir}/package.json must have a non-empty "name" field`);

    assert.ok(typeof pkg.version === "string" && /^\d+\.\d+\.\d+/.test(pkg.version),
      `${dir}/package.json must have a valid semver "version" (got "${pkg.version}")`);

    assert.equal(pkg.type, "module",
      `${dir}/package.json must have "type": "module"`);
  }
});

test("no circular dependencies between packages", () => {
  const dirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Build dependency graph
  const graph = new Map<string, Set<string>>();
  const nameToDir = new Map<string, string>();

  for (const dir of dirs) {
    const pkgJsonPath = path.join(PACKAGES_DIR, dir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    nameToDir.set(pkg.name, dir);
    graph.set(pkg.name, new Set());

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };

    for (const dep of Object.keys(allDeps)) {
      // Only track internal workspace deps
      if (dep.startsWith("@remnic/")) {
        graph.get(pkg.name)!.add(dep);
      }
    }
  }

  // Detect cycles using DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(node: string, path: string[]): string[] | null {
    if (inStack.has(node)) return [...path, node];
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);

    for (const dep of graph.get(node) ?? []) {
      const cycle = hasCycle(dep, [...path, node]);
      if (cycle) return cycle;
    }

    inStack.delete(node);
    return null;
  }

  for (const name of graph.keys()) {
    const cycle = hasCycle(name, []);
    assert.equal(cycle, null,
      `Circular dependency detected: ${cycle?.join(" → ")}`);
  }
});

test("root package.json lists workspaces", () => {
  const rootPkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));

  assert.ok(
    Array.isArray(pkg.workspaces) || (pkg.workspaces && Array.isArray(pkg.workspaces.packages)),
    "Root package.json must have a workspaces field",
  );
});

test("plugin-openclaw publishes under the Remnic scope", () => {
  const pkgJsonPath = path.join(PACKAGES_DIR, "plugin-openclaw", "package.json");
  assert.ok(fs.existsSync(pkgJsonPath), "plugin-openclaw/package.json must exist");

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  assert.equal(
    pkg.name,
    "@remnic/plugin-openclaw",
    `OpenClaw plugin package must be named "@remnic/plugin-openclaw" (got "${pkg.name}")`,
  );
});

test("published OpenClaw packages require openclaw 2026.4.8 or greater", () => {
  for (const packageDir of ["plugin-openclaw", "shim-openclaw-engram"]) {
    const pkgJsonPath = path.join(PACKAGES_DIR, packageDir, "package.json");
    assert.ok(fs.existsSync(pkgJsonPath), `${packageDir}/package.json must exist`);

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    assert.equal(
      pkg.peerDependencies?.openclaw,
      ">=2026.4.8",
      `${packageDir} must require openclaw >=2026.4.8`,
    );
  }
});
