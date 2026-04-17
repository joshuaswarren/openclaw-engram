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

const CONSOLE_LOGGER: LoggerBackend = {
  info: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

export function initLogger(backend?: LoggerBackend, debug?: boolean): void {
  _backend = backend ?? CONSOLE_LOGGER;
  _debug = debug ?? false;
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
