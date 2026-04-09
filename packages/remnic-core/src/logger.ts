export interface LoggerBackend {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug?(msg: string, ...args: unknown[]): void;
}

const NOOP_LOGGER: LoggerBackend = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

let _backend: LoggerBackend = NOOP_LOGGER;
let _debug = false;

export function initLogger(backend: LoggerBackend, debug: boolean): void {
  _backend = backend;
  _debug = debug;
}

export const log = {
  info(msg: string, ...args: unknown[]): void {
    _backend.info(`remnic: ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]): void {
    _backend.warn(`remnic: ${msg}`, ...args);
  },
  error(msg: string, err?: unknown): void {
    const detail =
      err instanceof Error ? err.message : err ? String(err) : "";
    _backend.error(
      `remnic: ${msg}${detail ? ` — ${detail}` : ""}`,
    );
  },
  debug(msg: string, ...args: unknown[]): void {
    if (!_debug) return;
    const fn = _backend.debug ?? _backend.info;
    fn(`remnic [debug]: ${msg}`, ...args);
  },
};
