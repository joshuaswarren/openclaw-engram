/**
 * TTY passphrase reader (issue #690 PR 2/4).
 *
 * Reads a line from stdin without echoing it back to the terminal.
 * Disables echo by setting raw mode + manually buffering input until
 * Enter / EOT.
 *
 * Why not `readline.question`?
 * ----------------------------
 * `readline` echoes by default and has no clean "no-echo" toggle that
 * survives across Node versions. The raw-mode loop is the canonical
 * idiom for reading passwords on Node and matches what `npm` uses
 * internally.
 *
 * Security
 * --------
 *   - Never log the passphrase (no `console.log`, no debug output).
 *   - Never include it in a thrown error message.
 *   - On Ctrl+C / Ctrl+D, abort with a clear error rather than
 *     silently treating EOF as an empty submission.
 *   - On non-TTY stdin (pipe, redirect), read a line via line-buffered
 *     readline so automation (`echo "passphrase" | remnic ...`) works.
 *     Operators are responsible for not piping plaintext passphrases
 *     in shell history; we surface a stderr warning.
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type { PassphraseReader } from "./cli-handlers.js";

export interface CreatePassphraseReaderOptions {
  input?: Readable;
  output?: Writable;
  /** Override stderr for warning surface; defaults to `process.stderr`. */
  errorStream?: Writable;
}

/**
 * Build a `PassphraseReader` bound to the given streams. Exported so
 * tests can construct one against in-memory streams without touching
 * the real TTY.
 */
export function createPassphraseReader(
  options: CreatePassphraseReaderOptions = {},
): PassphraseReader {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorStream = options.errorStream ?? process.stderr;
  return async function readPassphrase(
    prompt: string,
    readerOptions?: { confirm?: boolean },
  ): Promise<string> {
    const first = await readSinglePassphrase(prompt, input, output, errorStream);
    if (readerOptions?.confirm) {
      const second = await readSinglePassphrase("Confirm passphrase: ", input, output, errorStream);
      if (first !== second) {
        throw new Error("passphrases did not match");
      }
    }
    return first;
  };
}

async function readSinglePassphrase(
  prompt: string,
  input: Readable,
  output: Writable,
  errorStream: Writable,
): Promise<string> {
  const inputAsAny = input as Readable & {
    isTTY?: boolean;
    setRawMode?: (raw: boolean) => Readable;
  };
  if (inputAsAny.isTTY && typeof inputAsAny.setRawMode === "function") {
    return readNoEcho(prompt, inputAsAny, output);
  }
  // Non-TTY: line-buffered fallback via readline. Warn once on stderr
  // so operators piping plaintext passphrases in shell pipelines are
  // aware their history may contain the secret.
  errorStream.write(
    "[remnic secure-store] warning: stdin is not a TTY; reading passphrase as a plain line. " +
      "Take care that the passphrase is not exposed in shell history.\n",
  );
  output.write(prompt);
  return readPlainLine(input, output);
}

function readNoEcho(
  prompt: string,
  input: Readable & { setRawMode?: (raw: boolean) => Readable },
  output: Writable,
): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    let buffer = "";
    let settled = false;
    const wasRaw = (input as Readable & { isRaw?: boolean }).isRaw === true;
    // Codex P2 on PR #737: per-chunk `chunk.toString("utf8")` corrupts
    // multibyte characters that straddle a chunk boundary (Node inserts
    // U+FFFD replacement characters for incomplete sequences). Use a
    // StringDecoder, which buffers partial sequences across chunks so
    // non-ASCII passphrases survive intact.
    const decoder = new StringDecoder("utf8");
    if (input.setRawMode) input.setRawMode(true);
    input.resume();
    const cleanup = (): void => {
      input.pause();
      input.removeListener("data", onData);
      // Flush any remaining bytes the decoder is holding so trailing
      // partial sequences are surfaced rather than silently swallowed.
      decoder.end();
      // Restore the prior raw-mode state so we don't strand the parent shell
      // in an unexpected configuration.
      if (input.setRawMode) input.setRawMode(wasRaw);
      output.write("\n");
    };
    const onData = (chunk: Buffer): void => {
      const str = decoder.write(chunk);
      for (const ch of str) {
        if (settled) return;
        const code = ch.charCodeAt(0);
        // Enter / newline: submit.
        if (ch === "\n" || ch === "\r") {
          settled = true;
          cleanup();
          resolve(buffer);
          return;
        }
        // Ctrl+C: abort.
        if (code === 0x03) {
          settled = true;
          cleanup();
          reject(new Error("passphrase entry aborted (Ctrl+C)"));
          return;
        }
        // Ctrl+D / EOT: treat as abort if buffer is empty, else submit.
        if (code === 0x04) {
          settled = true;
          cleanup();
          if (buffer.length === 0) {
            reject(new Error("passphrase entry aborted (EOF)"));
          } else {
            resolve(buffer);
          }
          return;
        }
        // Backspace / DEL.
        if (code === 0x08 || code === 0x7f) {
          if (buffer.length > 0) buffer = buffer.slice(0, -1);
          continue;
        }
        // Ignore other control bytes (escape sequences, etc.).
        if (code < 0x20) {
          continue;
        }
        buffer += ch;
      }
    };
    input.on("data", onData);
  });
}

function readPlainLine(input: Readable, output: Writable): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input, output, terminal: false });
    // Codex P1 on PR #737: a previous version called `rl.close()`
    // before `resolve(line)`, but `close` emits synchronously and a
    // separate `close` listener that resolved with `""` could win the
    // race against the `line` listener — turning piped passphrases
    // (`echo secret | remnic ...`) into empty input. Track settled
    // state explicitly so the first event wins and subsequent events
    // become no-ops.
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    rl.on("line", (line) => {
      settle(() => resolve(line));
      rl.close();
    });
    rl.on("close", () => {
      // Stream ended without a newline — only honored if no line was
      // delivered first.
      settle(() => resolve(""));
    });
    rl.on("error", (err) => {
      settle(() => reject(err));
      rl.close();
    });
  });
}
