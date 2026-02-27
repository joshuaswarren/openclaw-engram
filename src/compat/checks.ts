import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CompatCheckOptions, CompatCheckResult, CompatReport, CompatRunner } from "./types.js";

const REQUIRED_HOOKS = ["before_agent_start", "agent_end"];

function isSafeCommandToken(command: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(command);
}

const defaultRunner: CompatRunner = {
  async commandExists(command: string): Promise<boolean> {
    if (!isSafeCommandToken(command)) return false;
    const binary = process.platform === "win32" ? "where" : "which";
    const args = [command];
    return new Promise<boolean>((resolve) => {
      const child = spawn(binary, args, { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  },
};

function summarize(checks: CompatCheckResult[]): { ok: number; warn: number; error: number } {
  const out = { ok: 0, warn: 0, error: 0 };
  for (const check of checks) {
    out[check.level] += 1;
  }
  return out;
}

function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      out.push(" ", " ");
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < source.length) {
        const c = source[i];
        const n = source[i + 1];
        out.push(c === "\n" ? "\n" : " ");
        i += 1;
        if (c === "*" && n === "/") {
          out.push(" ");
          i += 1;
          break;
        }
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out.push(" ");
      i += 1;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") {
          out.push(" ");
          i += 1;
          if (i < source.length) {
            out.push(source[i] === "\n" ? "\n" : " ");
            i += 1;
          }
          continue;
        }
        out.push(c === "\n" ? "\n" : " ");
        i += 1;
        if (c === quote) break;
      }
      continue;
    }

    out.push(ch);
    i += 1;
  }
  return out.join("");
}

function parseHookRegistrations(source: string): Set<string> {
  const hooks = new Set<string>();
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (source.startsWith("api.on", i)) {
      let j = i + "api.on".length;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (source[j] !== "(") {
        i += 1;
        continue;
      }

      j += 1;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      const quote = source[j];
      if (quote !== '"' && quote !== "'") {
        i += 1;
        continue;
      }

      j += 1;
      const start = j;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") {
          j += 2;
        } else {
          j += 1;
        }
      }
      if (j < source.length) {
        const hook = source.slice(start, j);
        if (/^[a-z_]+$/.test(hook)) hooks.add(hook);
        i = j + 1;
        continue;
      }
    }

    i += 1;
  }

  return hooks;
}

function hasServiceStartRegistration(source: string): boolean {
  return /api\.registerService\s*\(\s*\{[\s\S]*?\bstart\s*:/m.test(source);
}

function hasCliRegistration(source: string): boolean {
  return /registerCli\s*\([^)]*\borchestrator\b[^)]*\)/m.test(source);
}

function parseNodeMinVersion(raw: string | undefined): [number, number, number] | null {
  if (!raw) return null;
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseCurrentNodeVersion(raw: string): [number, number, number] | null {
  const normalized = raw.startsWith("v") ? raw.slice(1) : raw;
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

export async function runCompatChecks(options: CompatCheckOptions): Promise<CompatReport> {
  const checks: CompatCheckResult[] = [];
  const runner = options.runner ?? defaultRunner;
  const pluginJsonPath = path.join(options.repoRoot, "openclaw.plugin.json");
  const packageJsonPath = path.join(options.repoRoot, "package.json");
  const indexPath = path.join(options.repoRoot, "src", "index.ts");

  let pluginRaw = "";
  let pluginManifestPresent = false;
  try {
    pluginRaw = await readFile(pluginJsonPath, "utf-8");
    pluginManifestPresent = true;
    checks.push({
      id: "plugin-manifest-present",
      title: "Plugin manifest present",
      level: "ok",
      message: "Found openclaw.plugin.json",
    });
  } catch {
    checks.push({
      id: "plugin-manifest-present",
      title: "Plugin manifest present",
      level: "error",
      message: "openclaw.plugin.json is missing",
      remediation: "Restore openclaw.plugin.json at repo root with plugin metadata.",
    });
  }

  if (pluginManifestPresent) {
    try {
      const plugin = JSON.parse(pluginRaw) as { id?: string; kind?: string };
      if (plugin.id === "openclaw-engram" && plugin.kind === "memory") {
        checks.push({
          id: "plugin-manifest-shape",
          title: "Plugin manifest ID and kind",
          level: "ok",
          message: "Plugin manifest id/kind match expected values.",
        });
      } else {
        checks.push({
          id: "plugin-manifest-shape",
          title: "Plugin manifest ID and kind",
          level: "error",
          message: `Unexpected manifest values (id=${String(plugin.id)}, kind=${String(plugin.kind)})`,
          remediation: "Set manifest id=openclaw-engram and kind=memory.",
        });
      }
    } catch {
      checks.push({
        id: "plugin-manifest-shape",
        title: "Plugin manifest ID and kind",
        level: "error",
        message: "openclaw.plugin.json is not valid JSON",
        remediation: "Fix JSON syntax in openclaw.plugin.json.",
      });
    }
  }

  let packageRaw = "";
  let packageJsonPresent = false;
  try {
    packageRaw = await readFile(packageJsonPath, "utf-8");
    packageJsonPresent = true;
  } catch {
    checks.push({
      id: "package-json-present",
      title: "package.json present",
      level: "error",
      message: "package.json is missing",
      remediation: "Restore package.json at repo root.",
    });
  }

  if (packageJsonPresent) {
    try {
      const pkg = JSON.parse(packageRaw) as {
        openclaw?: { plugin?: string; extensions?: string[] };
        engines?: { node?: string };
      };
      const pluginPathOk = pkg.openclaw?.plugin === "./openclaw.plugin.json";
      const extOk = Array.isArray(pkg.openclaw?.extensions)
        && pkg.openclaw?.extensions.includes("./dist/index.js");
      if (pluginPathOk && extOk) {
        checks.push({
          id: "package-openclaw-exports",
          title: "package.json OpenClaw export wiring",
          level: "ok",
          message: "package.json openclaw.plugin/extensions wiring looks valid.",
        });
      } else {
        checks.push({
          id: "package-openclaw-exports",
          title: "package.json OpenClaw export wiring",
          level: "error",
          message: "package.json openclaw plugin/extension wiring is missing or invalid.",
          remediation: "Set openclaw.plugin to ./openclaw.plugin.json and include ./dist/index.js in openclaw.extensions.",
        });
      }

      const minVersion = parseNodeMinVersion(pkg.engines?.node);
      const currentVersion = parseCurrentNodeVersion(process.version);
      if (!minVersion || !currentVersion) {
        checks.push({
          id: "node-version-compat",
          title: "Node runtime compatibility",
          level: "warn",
          message: "Unable to parse node engine/current version.",
          remediation: "Confirm Node version meets package.json engines.node requirement.",
          metadata: { enginesNode: pkg.engines?.node, currentNode: process.version },
        });
      } else if (compareVersions(currentVersion, minVersion) >= 0) {
        checks.push({
          id: "node-version-compat",
          title: "Node runtime compatibility",
          level: "ok",
          message: `Current Node ${process.version} satisfies engines requirement ${pkg.engines?.node}.`,
        });
      } else {
        checks.push({
          id: "node-version-compat",
          title: "Node runtime compatibility",
          level: "error",
          message: `Current Node ${process.version} is below required ${pkg.engines?.node}.`,
          remediation: "Upgrade Node runtime to meet package.json engines.node minimum.",
        });
      }
    } catch {
      checks.push({
        id: "package-json-parse",
        title: "package.json parse",
        level: "error",
        message: "package.json is not valid JSON",
        remediation: "Fix JSON syntax in package.json.",
      });
    }
  }

  try {
    await access(indexPath);
    const indexRaw = await readFile(indexPath, "utf-8");
    const structuralSource = stripCommentsAndStrings(indexRaw);
    const hooks = parseHookRegistrations(indexRaw);
    const missingHooks = REQUIRED_HOOKS.filter((hook) => !hooks.has(hook));
    const hasGatewayStartHook = hooks.has("gateway_start");
    const hasServiceStart = hasServiceStartRegistration(structuralSource);
    if (missingHooks.length === 0 && (hasGatewayStartHook || hasServiceStart)) {
      checks.push({
        id: "hook-registration-core",
        title: "Core hook registration",
        level: "ok",
        message: "Core recall/extraction hooks and startup wiring are registered in src/index.ts.",
      });
    } else {
      const missingParts: string[] = [];
      if (missingHooks.length > 0) {
        missingParts.push(`hooks: ${missingHooks.join(", ")}`);
      }
      if (!hasGatewayStartHook && !hasServiceStart) {
        missingParts.push("startup wiring: gateway_start hook or api.registerService({ start })");
      }
      checks.push({
        id: "hook-registration-core",
        title: "Core hook registration",
        level: "error",
        message: `Missing expected registration(s): ${missingParts.join("; ")}`,
        remediation: "Ensure src/index.ts registers before_agent_start and agent_end, plus either gateway_start or api.registerService({ start }).",
      });
    }

    const cliWired = hasCliRegistration(structuralSource);
    checks.push({
      id: "cli-registration",
      title: "CLI registration wiring",
      level: cliWired ? "ok" : "warn",
      message: cliWired
        ? "CLI registration is wired in plugin bootstrap."
        : "CLI registration call not found in src/index.ts.",
      remediation: cliWired ? undefined : "Call registerCli(api, orchestrator) during plugin registration.",
    });
  } catch {
    checks.push({
      id: "hook-registration-core",
      title: "Core hook registration",
      level: "error",
      message: "src/index.ts is missing; cannot validate hook wiring.",
      remediation: "Restore src/index.ts and register required hooks.",
    });
  }

  const qmdAvailable = await runner.commandExists("qmd");
  checks.push({
    id: "qmd-binary-availability",
    title: "QMD binary availability",
    level: qmdAvailable ? "ok" : "warn",
    message: qmdAvailable
      ? "qmd binary is available in PATH."
      : "qmd binary is not available in PATH.",
    remediation: qmdAvailable ? undefined : "Install qmd or configure qmdPath in plugin config.",
  });

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    checks,
    summary: summarize(checks),
  };
}
