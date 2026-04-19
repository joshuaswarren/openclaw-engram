import path from "node:path";
import type { BuiltInProvider } from "@remnic/bench";
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
export type BenchRuntimeProfile = "baseline" | "real" | "openclaw-chain";
export type BenchModelSource = "plugin" | "gateway";
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
  runtimeProfile?: BenchRuntimeProfile;
  matrixProfiles?: BenchRuntimeProfile[];
  remnicConfigPath?: string;
  openclawConfigPath?: string;
  modelSource?: BenchModelSource;
  gatewayAgentId?: string;
  fastGatewayAgentId?: string;
  systemProvider?: BuiltInProvider;
  systemModel?: string;
  systemBaseUrl?: string;
  judgeProvider?: BuiltInProvider;
  judgeModel?: string;
  judgeBaseUrl?: string;
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
      arg === "--runtime-profile" ||
      arg === "--matrix" ||
      arg === "--remnic-config" ||
      arg === "--openclaw-config" ||
      arg === "--model-source" ||
      arg === "--gateway-agent-id" ||
      arg === "--fast-gateway-agent-id" ||
      arg === "--system-provider" ||
      arg === "--system-model" ||
      arg === "--system-base-url" ||
      arg === "--judge-provider" ||
      arg === "--judge-model" ||
      arg === "--judge-base-url" ||
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
  const runtimeProfileRaw = readBenchOptionValue(args, "--runtime-profile");
  const matrixRaw = readBenchOptionValue(args, "--matrix");
  const remnicConfigRaw = readBenchOptionValue(args, "--remnic-config");
  const openclawConfigRaw = readBenchOptionValue(args, "--openclaw-config");
  const modelSourceRaw = readBenchOptionValue(args, "--model-source");
  const gatewayAgentId = readBenchOptionValue(args, "--gateway-agent-id");
  const fastGatewayAgentId = readBenchOptionValue(args, "--fast-gateway-agent-id");
  const systemProviderRaw = readBenchOptionValue(args, "--system-provider");
  const systemModel = readBenchOptionValue(args, "--system-model");
  const systemBaseUrl = readBenchOptionValue(args, "--system-base-url");
  const judgeProviderRaw = readBenchOptionValue(args, "--judge-provider");
  const judgeModel = readBenchOptionValue(args, "--judge-model");
  const judgeBaseUrl = readBenchOptionValue(args, "--judge-base-url");
  const thresholdRaw = readBenchOptionValue(args, "--threshold");
  const customRaw = readBenchOptionValue(args, "--custom");
  const formatRaw = readBenchOptionValue(args, "--format");
  const output = readBenchOptionValue(args, "--output");
  const targetRaw = readBenchOptionValue(args, "--target");
  let runtimeProfile: BenchRuntimeProfile | undefined;
  if (runtimeProfileRaw !== undefined) {
    if (
      runtimeProfileRaw !== "baseline" &&
      runtimeProfileRaw !== "real" &&
      runtimeProfileRaw !== "openclaw-chain"
    ) {
      throw new Error(
        'ERROR: --runtime-profile must be "baseline", "real", or "openclaw-chain".',
      );
    }
    runtimeProfile = runtimeProfileRaw;
  }

  let matrixProfiles: BenchRuntimeProfile[] | undefined;
  if (matrixRaw !== undefined) {
    const candidates = matrixRaw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (candidates.length === 0) {
      throw new Error(
        'ERROR: --matrix must contain one or more of "baseline", "real", or "openclaw-chain".',
      );
    }
    for (const candidate of candidates) {
      if (
        candidate !== "baseline" &&
        candidate !== "real" &&
        candidate !== "openclaw-chain"
      ) {
        throw new Error(
          'ERROR: --matrix must contain only "baseline", "real", or "openclaw-chain".',
        );
      }
    }
    matrixProfiles = candidates;
  }

  let modelSource: BenchModelSource | undefined;
  if (modelSourceRaw !== undefined) {
    if (modelSourceRaw !== "plugin" && modelSourceRaw !== "gateway") {
      throw new Error('ERROR: --model-source must be "plugin" or "gateway".');
    }
    modelSource = modelSourceRaw;
  }

  let systemProvider: BuiltInProvider | undefined;
  if (systemProviderRaw !== undefined) {
    if (
      systemProviderRaw !== "openai" &&
      systemProviderRaw !== "anthropic" &&
      systemProviderRaw !== "ollama" &&
      systemProviderRaw !== "litellm"
    ) {
      throw new Error(
        'ERROR: --system-provider must be "openai", "anthropic", "ollama", or "litellm".',
      );
    }
    systemProvider = systemProviderRaw;
  }

  let judgeProvider: BuiltInProvider | undefined;
  if (judgeProviderRaw !== undefined) {
    if (
      judgeProviderRaw !== "openai" &&
      judgeProviderRaw !== "anthropic" &&
      judgeProviderRaw !== "ollama" &&
      judgeProviderRaw !== "litellm"
    ) {
      throw new Error(
        'ERROR: --judge-provider must be "openai", "anthropic", "ollama", or "litellm".',
      );
    }
    judgeProvider = judgeProviderRaw;
  }

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
    runtimeProfile,
    matrixProfiles,
    remnicConfigPath: remnicConfigRaw ? path.resolve(expandTilde(remnicConfigRaw)) : undefined,
    openclawConfigPath: openclawConfigRaw ? path.resolve(expandTilde(openclawConfigRaw)) : undefined,
    modelSource,
    gatewayAgentId,
    fastGatewayAgentId,
    systemProvider,
    systemModel,
    systemBaseUrl,
    judgeProvider,
    judgeModel,
    judgeBaseUrl,
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
