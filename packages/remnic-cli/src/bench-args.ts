import path from "node:path";
import { expandTilde } from "./path-utils.js";

export type BenchAction =
  | "help"
  | "list"
  | "run"
  | "datasets"
  | "runs"
  | "compare"
  | "ui"
  | "results"
  | "baseline"
  | "export"
  | "providers"
  | "publish"
  | "check"
  | "report";

export type BenchBaselineAction = "save" | "list";
export type BenchDatasetAction = "download" | "status";
export type BenchExportFormat = "json" | "csv" | "html";
export type BenchProviderAction = "discover";
export type BenchPublishTarget = "remnic-ai";
export type BenchRunAction = "list" | "show" | "delete";

export interface ParsedBenchArgs {
  action: BenchAction;
  benchmarks: string[];
  quick: boolean;
  all: boolean;
  json: boolean;
  detail: boolean;
  datasetDir?: string;
  resultsDir?: string;
  baselinesDir?: string;
  threshold?: number;
  baselineAction?: BenchBaselineAction;
  datasetAction?: BenchDatasetAction;
  providerAction?: BenchProviderAction;
  runAction?: BenchRunAction;
  format?: BenchExportFormat;
  output?: string;
  custom?: string;
  target?: BenchPublishTarget;
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
    if (
      arg === "--dataset-dir" ||
      arg === "--results-dir" ||
      arg === "--baselines-dir" ||
      arg === "--threshold" ||
      arg === "--custom" ||
      arg === "--format" ||
      arg === "--output" ||
      arg === "--target"
    ) {
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
    first === "list" ||
    first === "run" ||
    first === "datasets" ||
    first === "runs" ||
    first === "compare" ||
    first === "ui" ||
    first === "results" ||
    first === "baseline" ||
    first === "export" ||
    first === "providers" ||
    first === "publish" ||
    first === "check" ||
    first === "report"
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
  const baselineAction =
    action === "baseline"
      ? args[0] === "save" || args[0] === "list"
        ? args[0]
        : undefined
      : undefined;
  const datasetAction =
    action === "datasets"
      ? args[0] === "download" || args[0] === "status"
        ? args[0]
        : undefined
      : undefined;
  const providerAction =
    action === "providers"
      ? args[0] === "discover"
        ? args[0]
        : undefined
      : undefined;
  const runAction =
    action === "runs"
      ? args[0] === "list" || args[0] === "show" || args[0] === "delete"
        ? args[0]
        : undefined
      : undefined;
  if (action === "baseline" && baselineAction === undefined) {
    throw new Error("ERROR: baseline requires a subcommand: save or list.");
  }
  if (action === "datasets" && datasetAction === undefined) {
    throw new Error("ERROR: datasets requires a subcommand: download or status.");
  }
  if (action === "providers" && providerAction === undefined) {
    throw new Error("ERROR: providers requires a subcommand: discover.");
  }
  if (action === "runs" && runAction === undefined) {
    throw new Error("ERROR: runs requires a subcommand: list, show, or delete.");
  }

  const benchmarkArgs =
    action === "baseline" ||
    action === "datasets" ||
    action === "providers" ||
    action === "runs"
      ? args.slice(1)
      : args;
  const benchmarks = collectBenchmarks(benchmarkArgs);
  const datasetDir = readBenchOptionValue(args, "--dataset-dir");
  const resultsDir = readBenchOptionValue(args, "--results-dir");
  const baselinesDir = readBenchOptionValue(args, "--baselines-dir");
  const thresholdRaw = readBenchOptionValue(args, "--threshold");
  const customRaw = readBenchOptionValue(args, "--custom");
  const formatRaw = readBenchOptionValue(args, "--format");
  const output = readBenchOptionValue(args, "--output");
  const targetRaw = readBenchOptionValue(args, "--target");
  let threshold: number | undefined;
  if (thresholdRaw !== undefined) {
    threshold = Number(thresholdRaw);
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new Error("ERROR: --threshold must be a non-negative number.");
    }
  }

  let format: BenchExportFormat | undefined;
  if (formatRaw !== undefined) {
    if (formatRaw !== "json" && formatRaw !== "csv" && formatRaw !== "html") {
      throw new Error('ERROR: --format must be "json", "csv", or "html".');
    }
    format = formatRaw;
  }

  let target: BenchPublishTarget | undefined;
  if (targetRaw !== undefined) {
    if (targetRaw !== "remnic-ai") {
      throw new Error('ERROR: --target must be "remnic-ai".');
    }
    target = targetRaw;
  }

  return {
    action,
    benchmarks,
    quick: args.includes("--quick"),
    all: args.includes("--all"),
    json: args.includes("--json"),
    detail: args.includes("--detail"),
    datasetDir: datasetDir ? path.resolve(expandTilde(datasetDir)) : undefined,
    resultsDir: resultsDir ? path.resolve(expandTilde(resultsDir)) : undefined,
    baselinesDir: baselinesDir ? path.resolve(expandTilde(baselinesDir)) : undefined,
    threshold,
    custom: customRaw ? path.resolve(expandTilde(customRaw)) : undefined,
    baselineAction,
    datasetAction,
    providerAction,
    runAction,
    format,
    output: output ? path.resolve(expandTilde(output)) : undefined,
    target,
  };
}
