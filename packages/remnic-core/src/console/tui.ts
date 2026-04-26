/**
 * Operator console TUI for issue #688 (PR 2/3).
 *
 * Renders a five-panel one-screen layout that periodically polls
 * `gatherConsoleState` and repaints the terminal. Deliberately uses
 * the minimal-deps "clear + repaint" approach (no curses / blessed /
 * ink) — we just emit ANSI control sequences directly to the output
 * stream. This keeps the surface portable and dependency-free.
 *
 * PR 1/3 (#721) shipped `gatherConsoleState` plus the CLI's
 * `--state-only` flag (one-shot JSON snapshot). PR 2/3 wires the
 * interactive surface. Trace replay (`--trace <session-id>`) is
 * deferred to PR 3/3.
 *
 * Design contract:
 *   - Read-only: never mutates orchestrator state.
 *   - Resilient: a thrown error in one refresh cycle must NOT crash
 *     the loop. Errors are surfaced inside the rendered frame.
 *   - Cleanly stoppable: `runConsoleTui` returns a `stop()` that
 *     clears the interval, restores the cursor, and resolves the
 *     pending exit promise. SIGINT triggers the same cleanup.
 *   - No external deps: only ANSI control sequences.
 */

import type { Writable } from "node:stream";

import {
  gatherConsoleState,
  type ConsoleStateOrchestratorLike,
  type ConsoleStateSnapshot,
} from "./state.js";

/** ANSI: clear screen + move cursor to home (top-left). */
const ANSI_CLEAR_HOME = "\x1b[2J\x1b[H";
/** ANSI: hide / show the cursor (we hide during the loop, restore on exit). */
const ANSI_HIDE_CURSOR = "\x1b[?25l";
const ANSI_SHOW_CURSOR = "\x1b[?25h";

/** Total inner width of the rendered frame (between the box borders). */
const FRAME_INNER_WIDTH = 70;

/** Default refresh interval in milliseconds. Chosen to match the spec. */
const DEFAULT_REFRESH_INTERVAL_MS = 2000;

export interface RunConsoleTuiOptions {
  /** Polling interval in milliseconds. Defaults to 2000ms. */
  refreshIntervalMs?: number;
  /** Output stream. Defaults to `process.stdout`. */
  output?: Writable;
  /**
   * Optional clock injection — primarily for tests so the rendered
   * timestamp is deterministic. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * If true, install a SIGINT handler that calls `stop()` and resolves
   * the returned promise. Defaults to true. Tests typically pass false.
   */
  installSigintHandler?: boolean;
  /**
   * Optional trace recorder. When provided, every successfully
   * gathered snapshot is appended to the recorder for later replay
   * via `replayTrace`. Failed appends are surfaced through the
   * recorder's `getLastError()` and never crash the loop (issue
   * #688 PR 3/3).
   */
  traceRecorder?: {
    append: (snapshot: ConsoleStateSnapshot) => Promise<void>;
  };
}

export interface RunConsoleTuiHandle {
  /** Stop the refresh loop, restore the cursor, and resolve `done`. */
  stop: () => void;
  /** Resolves once `stop()` has been invoked and cleanup ran. */
  done: Promise<void>;
}

/**
 * Start the operator console TUI. Returns immediately with a handle
 * exposing `stop()` and a `done` promise that resolves once the loop
 * has been torn down. The caller can `await handle.done` to block
 * until the user (or a SIGINT) exits.
 */
export function runConsoleTui(
  orchestrator: ConsoleStateOrchestratorLike,
  options: RunConsoleTuiOptions = {},
): RunConsoleTuiHandle {
  const refreshIntervalMs = Math.max(
    50,
    options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
  );
  const output: Writable = options.output ?? process.stdout;
  const now = options.now ?? (() => Date.now());
  const installSigintHandler = options.installSigintHandler ?? true;

  let stopped = false;
  let inFlight = false;
  // Codex P2 (PR #732): backpressure for trace recording. If the
  // previous fire-and-forget `append()` has not resolved yet, we drop
  // the current frame instead of enqueuing it onto the recorder's
  // internal writeChain. Without this guard, a wedged filesystem
  // would let memory grow unboundedly — every tick adds a JSON line
  // to a serialized chain that never drains. Dropping is preferable
  // to OOM; the operator can inspect `getLastError()` to learn that
  // tracing fell behind.
  let traceWritePending = false;
  let traceFramesDropped = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // Hide the cursor while the loop runs so the repaint doesn't flicker.
  safeWrite(output, ANSI_HIDE_CURSOR);

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    // Cursor Low: wrap the entire body in try/finally so a thrown
    // `renderFrame` (or any other unexpected sync failure after the
    // gatherConsoleState try/catch) still releases the `inFlight`
    // latch. Without this guard, a single render-time exception
    // permanently freezes the loop because every subsequent tick
    // hits `if (inFlight) return`. Honors the file's design contract
    // ("a thrown error in one refresh cycle must NOT crash the loop").
    try {
      let snapshot: ConsoleStateSnapshot | null = null;
      let renderError: string | null = null;
      try {
        snapshot = await gatherConsoleState(orchestrator);
      } catch (err) {
        renderError = describeError(err);
      }
      if (stopped) return;
      let frame: string;
      try {
        frame = renderFrame({ snapshot, renderError, now });
      } catch (err) {
        // If the renderer itself throws (e.g. an invalid clock
        // injection produced `NaN`), fall back to a minimal error
        // frame instead of letting the exception escape and reject
        // the void-floated promise (which would also be unhandled).
        frame = `remnic console: render failed: ${describeError(err)}\n`;
      }
      safeWrite(output, ANSI_CLEAR_HOME);
      safeWrite(output, frame);
      // Codex P2: do NOT await trace writes inside the render tick.
      // Awaiting holds `inFlight = true` for the duration of the disk
      // write; on a slow / network-backed filesystem that stretches
      // the visual refresh interval and skips ticks. Fire-and-forget
      // preserves the paint cadence; errors are captured via
      // `getLastError()`.
      //
      // Codex P2 (PR #732 follow-up): apply backpressure. If the
      // previous append is still pending (writeChain not yet
      // drained), drop this frame instead of queuing another line.
      // Without this gate, a wedged FS lets the chain grow
      // unboundedly — one JSON line per tick — until the process
      // OOMs. Dropping is preferable; the operator can inspect
      // `getLastError()` to see tracing fell behind.
      if (snapshot && options.traceRecorder && !traceWritePending) {
        traceWritePending = true;
        void options.traceRecorder
          .append(snapshot)
          .catch(() => {
            // already recorded in lastError; defense-in-depth.
          })
          .finally(() => {
            traceWritePending = false;
          });
      } else if (snapshot && options.traceRecorder) {
        traceFramesDropped += 1;
      }
    } finally {
      inFlight = false;
    }
  };

  // Kick off an immediate first paint, then schedule the interval.
  // Codex P1: do NOT call `handle.unref()`. The CLI path keeps the
  // process alive by `await`-ing `handle.done`, but a pending promise
  // alone is not enough to keep Node.js running — the interval timer
  // is the only ref'd handle that holds the event loop open between
  // ticks. Unref'ing it caused `remnic console` to render once and
  // exit immediately. Tests that don't want the process held open
  // can call `handle.stop()` directly when they're done.
  void runTickSafely(tick);
  const handle = setInterval(() => {
    void runTickSafely(tick);
  }, refreshIntervalMs);

  const sigintHandler = () => {
    stop();
  };
  if (installSigintHandler) {
    process.on("SIGINT", sigintHandler);
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
    if (installSigintHandler) {
      try {
        process.removeListener("SIGINT", sigintHandler);
      } catch {
        // ignore
      }
    }
    safeWrite(output, ANSI_SHOW_CURSOR);
    resolveDone();
  };

  return { stop, done };
}

interface RenderFrameInput {
  snapshot: ConsoleStateSnapshot | null;
  renderError: string | null;
  now: () => number;
}

/**
 * Build the full rendered frame as a single string. Pure — exposed
 * for testing.
 */
export function renderFrame(input: RenderFrameInput): string {
  const ts = new Date(input.now()).toISOString();
  const lines: string[] = [];
  lines.push(renderHeader(ts));
  for (const panel of renderPanels(input)) {
    lines.push(panel);
  }
  lines.push(renderFooter());
  return lines.join("\n") + "\n";
}

function renderHeader(ts: string): string {
  // ╔═ remnic console ════════════════════════════════ <ts> ═╗
  const title = " remnic console ";
  const trailing = ` ${ts} `;
  // 2 corner chars + title + ts + filler. Filler at minimum 1 char.
  const fillerLen = Math.max(
    1,
    FRAME_INNER_WIDTH - title.length - trailing.length,
  );
  const filler = "═".repeat(fillerLen);
  return `╔${title}${filler}${trailing}╗`;
}

function renderFooter(): string {
  return `╚${"═".repeat(FRAME_INNER_WIDTH)}╝`;
}

function renderPanels(input: RenderFrameInput): string[] {
  const lines: string[] = [];
  const snap = input.snapshot;

  if (input.renderError !== null) {
    lines.push(panelLine("Error", `refresh failed: ${input.renderError}`));
    // Even on error we still print the section headers so the layout
    // stays stable for the operator and tests can locate them.
    lines.push(panelLine("Buffer", "(unavailable)"));
    lines.push(panelLine("Extraction", "(unavailable)"));
    lines.push(panelLine("Dedup", "(unavailable)"));
    lines.push(panelLine("Maintenance", "(unavailable)"));
    lines.push(panelLine("QMD", "(unavailable)"));
    return lines;
  }

  // Buffer panel.
  if (snap) {
    lines.push(
      panelLine(
        "Buffer",
        `turns=${snap.bufferState.turnsCount} bytes=${snap.bufferState.byteCount}`,
      ),
    );

    // Extraction panel.
    const verdicts = snap.extractionQueue.recentVerdicts;
    const accepts = verdicts.filter((v) => v.kind === "accept").length;
    const rejects = verdicts.filter((v) => v.kind === "reject").length;
    lines.push(
      panelLine(
        "Extraction",
        `queue=${snap.extractionQueue.depth}  recent verdicts: accept(${accepts})/reject(${rejects})`,
      ),
    );

    // Dedup panel.
    const dedupSummary = formatDedupSummary(snap.dedupRecent, input.now);
    lines.push(panelLine("Dedup", dedupSummary));

    // Maintenance panel.
    const maintSummary = formatMaintenanceTail(snap.maintenanceLedgerTail);
    lines.push(panelLine("Maintenance", maintSummary));

    // QMD panel.
    lines.push(panelLine("QMD", formatQmdSummary(snap)));
  }

  // Surface aggregator-level read errors (e.g. ledger I/O failures)
  // without crashing the loop. These are not fatal — the snapshot is
  // still partially usable.
  if (snap && snap.errors.length > 0) {
    const head = snap.errors[0];
    lines.push(panelLine("Errors", head ?? ""));
  }

  return lines;
}

function formatDedupSummary(
  decisions: ConsoleStateSnapshot["dedupRecent"],
  now: () => number,
): string {
  if (decisions.length === 0) return "no recent decisions";
  const last = decisions[decisions.length - 1];
  if (!last) return "no recent decisions";
  const ageMs = ageMsFromIso(last.ts, now);
  const ageStr = ageMs === null ? "T-?" : `T-${Math.round(ageMs / 1000)}s`;
  const fp = last.fingerprint ? `hash=${last.fingerprint}` : "hash=?";
  return `recent: ${fp} decision=${last.decision} (${ageStr})`;
}

function formatMaintenanceTail(
  events: ConsoleStateSnapshot["maintenanceLedgerTail"],
): string {
  if (events.length === 0) return "no events";
  const last = events[events.length - 1];
  if (!last) return "no events";
  // Show count + most-recent event line.
  return `n=${events.length}  last: ${last.category} ${truncate(last.summary, 40)}`;
}

function formatQmdSummary(snap: ConsoleStateSnapshot): string {
  const probe = snap.qmdProbe.available ? "ok" : "down";
  const uptimeH = snap.daemon.uptimeMs / 3_600_000;
  const uptimeStr = uptimeH < 1
    ? `${Math.round(snap.daemon.uptimeMs / 1000)}s`
    : `${uptimeH.toFixed(1)}h`;
  const mode = snap.qmdProbe.daemonMode ? "daemon" : "cli";
  return `probe=${probe}  mode=${mode}  uptime=${uptimeStr}`;
}

function panelLine(label: string, value: string): string {
  // Layout: ║<space><label padded to LABEL_WIDTH><value padded to fill><space>║
  // Cursor Medium: the closing ║ must be preceded by a trailing space
  // so the rendered line width matches the header/footer borders.
  // Without it, every panel line was 71 chars while the borders were
  // 72, misaligning the right-hand box edge.
  const LABEL_WIDTH = 13;
  const labelCol = padRight(label, LABEL_WIDTH);
  // Two spaces (leading + trailing) inside the box, consuming 2 cols.
  const remaining = FRAME_INNER_WIDTH - LABEL_WIDTH - 2;
  const valueCol = padRight(truncate(value, remaining), remaining);
  return `║ ${labelCol}${valueCol} ║`;
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + "…";
}

function ageMsFromIso(iso: string, now: () => number): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const delta = now() - ms;
  return delta < 0 ? 0 : delta;
}

/**
 * Run an async tick function and swallow any rejection so the floated
 * `void runTickSafely(tick)` call never produces an unhandled-rejection
 * crash (which Node ≥15 escalates to a process exit). The tick body
 * itself already wraps everything in try/finally, but this is the
 * outermost belt-and-suspenders guard.
 */
async function runTickSafely(tick: () => Promise<void>): Promise<void> {
  try {
    await tick();
  } catch {
    // Any error has already been (or will be) surfaced inside the
    // rendered frame; never let it escape the timer callback.
  }
}

function safeWrite(output: Writable, chunk: string): void {
  try {
    output.write(chunk);
  } catch {
    // Writing to a closed / broken stream is non-fatal for the TUI;
    // the next tick will retry.
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

/**
 * Strip ANSI escape sequences from a string. Exposed for tests so the
 * rendered frame can be asserted against plain text.
 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
