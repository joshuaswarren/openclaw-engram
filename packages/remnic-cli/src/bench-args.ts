import path from "node:path";

export type BenchAction = "help" | "list" | "run" | "check" | "report";

export interface ParsedBenchArgs {
  action: BenchAction;
  benchmarks: string[];
  quick: boolean;
  all: boolean;
  json: boolean;
  datasetDir?: string;
}

function resolveHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "~";
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return resolveHomeDir() + p.slice(1);
  }
  const home = resolveHomeDir();
  if (p === "$HOME" || p.startsWith("$HOME/") || p.startsWith("$HOME\\")) {
    return home + p.slice(5);
  }
  if (p === "${HOME}" || p.startsWith("${HOME}/") || p.startsWith("${HOME}\\")) {
    return home + p.slice(7);
  }
  return p;
}

export function readBenchOptionValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`ERROR: ${flag} requires a value.`);
  }

  return value;
}

export function collectBenchmarks(argv: string[]): string[] {
  const benchmarks: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dataset-dir") {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      benchmarks.push(arg);
    }
  }
  return benchmarks;
}

export function parseBenchActionArgs(argv: string[]): {
  action: BenchAction;
  args: string[];
} {
  const [first, ...rest] = argv;
  const action: BenchAction =
    first === "list" || first === "run" || first === "check" || first === "report"
      ? first
      : first === undefined || first === "--help" || first === "-h"
        ? "help"
        : "run";

  return {
    action,
    args: action === "run" && action !== first ? argv : rest,
  };
}

export function parseBenchArgs(argv: string[]): ParsedBenchArgs {
  const { action, args } = parseBenchActionArgs(argv);
  const benchmarks = collectBenchmarks(args);
  const datasetDir = readBenchOptionValue(args, "--dataset-dir");

  return {
    action,
    benchmarks,
    quick: args.includes("--quick"),
    all: args.includes("--all"),
    json: args.includes("--json"),
    datasetDir: datasetDir ? path.resolve(expandTilde(datasetDir)) : undefined,
  };
}
