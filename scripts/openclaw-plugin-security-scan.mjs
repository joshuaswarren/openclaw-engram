#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return [
    "Usage: node scripts/openclaw-plugin-security-scan.mjs <package-dir>",
    "",
    "Environment:",
    "  OPENCLAW_PACKAGE_DIR  Path to an installed openclaw package directory.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = argv.slice(2).filter((arg) => arg !== "--");
  const packageDir = args[0];
  if (!packageDir || packageDir === "--help" || packageDir === "-h") {
    console.error(usage());
    process.exit(packageDir ? 0 : 2);
  }
  return path.resolve(packageDir);
}

function findOpenClawPackageDir() {
  const explicit = process.env.OPENCLAW_PACKAGE_DIR;
  if (explicit) return path.resolve(explicit);

  for (const searchRoot of [
    process.cwd(),
    path.join(process.cwd(), "node_modules"),
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
  ]) {
    const candidate = searchRoot.endsWith("openclaw")
      ? searchRoot
      : path.join(searchRoot, "openclaw");
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }

  throw new Error("Unable to find openclaw package; set OPENCLAW_PACKAGE_DIR.");
}

function findScannerModule(openclawPackageDir) {
  const distDir = path.join(openclawPackageDir, "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error(`OpenClaw dist directory not found: ${distDir}`);
  }

  const candidates = fs.readdirSync(distDir)
    .filter((entry) => /^skill-scanner-.*\.js$/.test(entry))
    .sort()
    .map((entry) => path.join(distDir, entry));

  if (candidates.length === 0) {
    throw new Error(`OpenClaw skill scanner module not found under ${distDir}`);
  }

  return candidates[0];
}

function selectScannerFunction(moduleExports) {
  if (typeof moduleExports.scanDirectoryWithSummary === "function") {
    return moduleExports.scanDirectoryWithSummary;
  }

  if (typeof moduleExports.scanDirectory === "function") {
    return moduleExports.scanDirectory;
  }

  if (typeof moduleExports.t === "function") return moduleExports.t;

  const exportedFunctions = Object.values(moduleExports).filter((value) => typeof value === "function");
  if (exportedFunctions.length === 1) return exportedFunctions[0];

  throw new Error(
    `Unable to identify OpenClaw scanner export; found exports: ${Object.keys(moduleExports).join(", ")}`,
  );
}

function formatFinding(finding) {
  const severity = finding.severity ?? "unknown";
  const message = finding.message ?? "finding";
  const file = finding.file ?? "unknown";
  const line = finding.line ?? 1;
  const evidence = finding.evidence ? ` ${finding.evidence}` : "";
  return `${severity}\t${message}\t${file}:${line}${evidence}`;
}

const packageDir = parseArgs(process.argv);
if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) {
  throw new Error(`Package directory does not exist or is not a directory: ${packageDir}`);
}

const openclawPackageDir = findOpenClawPackageDir();
const openclawPackageJson = JSON.parse(fs.readFileSync(path.join(openclawPackageDir, "package.json"), "utf8"));
const scannerModule = findScannerModule(openclawPackageDir);
const scannerExports = await import(pathToFileURL(scannerModule).href);
const scan = selectScannerFunction(scannerExports);
const summary = await scan(packageDir);
const findings = Array.isArray(summary.findings) ? summary.findings : [];

console.log(`OpenClaw ${openclawPackageJson.version} scanner: ${scannerModule}`);
for (const finding of findings) console.log(formatFinding(finding));
console.log(`scanned=${summary.scannedFiles ?? "unknown"} critical=${summary.critical ?? 0} warn=${summary.warn ?? 0}`);

if ((summary.critical ?? 0) > 0) {
  process.exitCode = 1;
}
