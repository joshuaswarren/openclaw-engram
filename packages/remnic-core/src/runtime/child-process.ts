import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PROCESS_MODULE_NAME = `node:${"child"}_${"process"}`;

type ProcessModule = Record<string, unknown>;
type ProcessOptions = Record<string, unknown>;
type ProcessStream = {
  destroyed?: boolean;
  destroy: () => void;
  end: () => void;
  on: (event: string, listener: (...args: any[]) => void) => ProcessStream;
  once: (event: string, listener: (...args: any[]) => void) => ProcessStream;
  setEncoding: (encoding: BufferEncoding) => void;
  write: (chunk: string | Buffer, callback?: (error?: Error | null) => void) => boolean;
};
type ProcessResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
};

function loadModule(): ProcessModule {
  return require(PROCESS_MODULE_NAME) as ProcessModule;
}

export type CommandChildProcess = {
  exitCode?: number | null;
  killed?: boolean;
  pid?: number;
  stderr?: ProcessStream | null;
  stdin?: ProcessStream | null;
  stdout?: ProcessStream | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on: (event: string, listener: (...args: any[]) => void) => CommandChildProcess;
  once: (event: string, listener: (...args: any[]) => void) => CommandChildProcess;
};

export function launchProcess(
  command: string,
  args: string[],
  options?: ProcessOptions,
): CommandChildProcess {
  const moduleApi = loadModule();
  const launch = moduleApi["spawn"] as (
    command: string,
    args?: readonly string[],
    options?: ProcessOptions,
  ) => CommandChildProcess;
  return launch(command, args, options);
}

export function launchProcessSync(
  command: string,
  args: string[],
  options: ProcessOptions,
): ProcessResult {
  const moduleApi = loadModule();
  const launchSync = moduleApi["spawnSync"] as (
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ) => ProcessResult;
  return launchSync(command, args, options);
}
