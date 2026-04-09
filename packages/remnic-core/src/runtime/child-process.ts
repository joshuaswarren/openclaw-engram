import { createRequire } from "node:module";
import type {
  ChildProcess as NodeChildProcess,
  SpawnOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";

const require = createRequire(import.meta.url);

type ChildProcessModule = typeof import("node:child_process");

function loadModule(): ChildProcessModule {
  return require("node:child_process") as ChildProcessModule;
}

export type CommandChildProcess = NodeChildProcess;

export function launchProcess(
  command: string,
  args: string[],
  options?: SpawnOptions,
): CommandChildProcess {
  const moduleApi = loadModule();
  const launch = moduleApi["spawn"] as (
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ) => CommandChildProcess;
  return launch(command, args, options);
}

export function launchProcessSync(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  const moduleApi = loadModule();
  const launchSync = moduleApi["spawnSync"] as (
    command: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => SpawnSyncReturns<string>;
  return launchSync(command, args, options);
}
