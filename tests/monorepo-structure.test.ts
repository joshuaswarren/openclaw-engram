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
  { dir: "engram-core", name: "@engram/core" },
  { dir: "engram-server", name: "@engram/server" },
  { dir: "engram-cli", name: "@engram/cli" },
  { dir: "plugin-openclaw", name: "openclaw-engram" },
  { dir: "plugin-claude-code", name: "@engram/plugin-claude-code" },
  { dir: "plugin-codex", name: "@engram/plugin-codex" },
  { dir: "connector-replit", name: "@engram/replit" },
  { dir: "bench", name: "@engram/bench" },
];

// Packages that must exist NOW (pre-migration names accepted too)
const REQUIRED_NOW = [
  // These exist under current names or target names
  "core",
  "server",
  "cli",
];

test("packages/ directory exists", () => {
  assert.ok(fs.existsSync(PACKAGES_DIR), "packages/ directory must exist");
});

test("each required package has a package.json", () => {
  const dirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const req of REQUIRED_NOW) {
    // Accept either current name or target name (e.g., "core" or "engram-core")
    const found = dirs.some((d) => d === req || d === `engram-${req}`);
    assert.ok(found, `Required package "${req}" (or "engram-${req}") must exist in packages/`);

    const dirName = dirs.find((d) => d === req || d === `engram-${req}`)!;
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
      if (dep.startsWith("@engram/") || dep === "openclaw-engram") {
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

test("plugin-openclaw publishes as 'openclaw-engram' for backward compat", () => {
  // Check both current and target directory names
  const candidates = ["plugin-openclaw", "adapter-openclaw"];
  for (const dir of candidates) {
    const pkgJsonPath = path.join(PACKAGES_DIR, dir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    // During migration, the name might still be @engram/adapter-openclaw
    // After migration, it must be openclaw-engram
    // This test documents the requirement
    assert.ok(
      pkg.name === "openclaw-engram" || pkg.name === "@engram/adapter-openclaw",
      `OpenClaw plugin package must be named "openclaw-engram" (got "${pkg.name}")`,
    );
    return;
  }
  // If neither directory exists yet, that's ok during early phases
});
