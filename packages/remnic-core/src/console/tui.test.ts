import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";

import {
  renderFrame,
  runConsoleTui,
  stripAnsi,
} from "./tui.js";
import {
  type ConsoleStateOrchestratorLike,
  type ConsoleStateSnapshot,
} from "./state.js";

/**
 * Test stream that accumulates writes into a buffer string. Used in
 * place of `process.stdout` so we can assert what the TUI rendered.
 */
class CaptureStream extends Writable {
  public chunks: string[] = [];
  override _write(
    chunk: unknown,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
  textPlain(): string {
    return stripAnsi(this.text());
  }
}

function makeOrchestrator(
  overrides: Partial<ConsoleStateOrchestratorLike> = {},
): ConsoleStateOrchestratorLike {
  return {
    config: { memoryDir: "/nonexistent" },
    buffer: { getTurns: () => [] },
    qmd: {
      isAvailable: () => true,
      isDaemonMode: () => true,
      debugStatus: () => "stub",
    },
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<ConsoleStateSnapshot> = {},
): ConsoleStateSnapshot {
  return {
    capturedAt: "2025-01-01T00:00:00.000Z",
    bufferState: { turnsCount: 0, byteCount: 0 },
    extractionQueue: { depth: 0, recentVerdicts: [] },
    dedupRecent: [],
    maintenanceLedgerTail: [],
    qmdProbe: { available: true, daemonMode: true, debug: "" },
    daemon: { uptimeMs: 0, version: "test" },
    errors: [],
    ...overrides,
  };
}

test("renderFrame produces text containing each panel header", () => {
  const frame = renderFrame({
    snapshot: makeSnapshot({
      bufferState: { turnsCount: 3, byteCount: 42 },
      extractionQueue: {
        depth: 5,
        recentVerdicts: [
          { ts: "2025-01-01T00:00:00.000Z", kind: "accept" },
          { ts: "2025-01-01T00:00:01.000Z", kind: "accept" },
          { ts: "2025-01-01T00:00:02.000Z", kind: "reject" },
        ],
      },
      dedupRecent: [
        {
          ts: "2025-01-01T00:00:00.000Z",
          decision: "admit",
          fingerprint: "abc123",
        },
      ],
      maintenanceLedgerTail: [
        {
          ts: "2025-01-01T00:00:00.000Z",
          category: "judge-verdict",
          summary: "verdict=accept",
        },
      ],
    }),
    renderError: null,
    now: () => Date.parse("2025-01-01T00:00:10.000Z"),
  });

  const plain = stripAnsi(frame);
  assert.match(plain, /remnic console/);
  assert.match(plain, /Buffer\b/);
  assert.match(plain, /turns=3 bytes=42/);
  assert.match(plain, /Extraction\b/);
  assert.match(plain, /queue=5/);
  assert.match(plain, /accept\(2\)\/reject\(1\)/);
  assert.match(plain, /Dedup\b/);
  assert.match(plain, /hash=abc123/);
  assert.match(plain, /decision=admit/);
  assert.match(plain, /Maintenance\b/);
  assert.match(plain, /judge-verdict/);
  assert.match(plain, /QMD\b/);
  assert.match(plain, /probe=ok/);
});

test("renderFrame surfaces a refresh error in the Error panel without losing layout", () => {
  const frame = renderFrame({
    snapshot: null,
    renderError: "boom",
    now: () => Date.parse("2025-01-01T00:00:00.000Z"),
  });
  const plain = stripAnsi(frame);
  assert.match(plain, /Error/);
  assert.match(plain, /refresh failed: boom/);
  // Layout headers are still present so operators see the structure.
  assert.match(plain, /Buffer\b/);
  assert.match(plain, /Extraction\b/);
  assert.match(plain, /Dedup\b/);
  assert.match(plain, /Maintenance\b/);
  assert.match(plain, /QMD\b/);
});

test("runConsoleTui repaints once on start and survives a snapshot failure", async () => {
  const stream = new CaptureStream();
  let calls = 0;
  // Mock orchestrator: first call succeeds (via gatherConsoleState's
  // defensive readers), second call throws when the buffer accessor
  // is invoked. The loop must NOT crash.
  const orchestrator: ConsoleStateOrchestratorLike = {
    config: { memoryDir: "/nonexistent" },
    qmd: {
      isAvailable: () => true,
      isDaemonMode: () => false,
      debugStatus: () => "stub",
    },
    buffer: {
      getTurns: () => {
        calls += 1;
        if (calls >= 2) {
          throw new Error("simulated read failure");
        }
        return [{ content: "hi" }];
      },
    },
  };

  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 50,
    output: stream,
    installSigintHandler: false,
    now: () => Date.parse("2025-01-01T00:00:00.000Z"),
  });

  // Wait long enough for at least two ticks (initial paint + one
  // interval-driven tick that exercises the failure path).
  await new Promise((resolve) => setTimeout(resolve, 200));
  handle.stop();
  await handle.done;

  // Loop did not crash and we got at least one frame.
  const text = stream.textPlain();
  assert.match(text, /remnic console/);
  assert.match(text, /Buffer\b/);
  // Error from the failing buffer reader is captured by gatherConsoleState's
  // try/catch and surfaced via the snapshot's `errors` array → Errors panel.
  // It is NOT a renderError (which only fires for gatherConsoleState
  // throwing outright). We assert the loop reached the second tick.
  assert.ok(calls >= 2, `expected >= 2 buffer reads, got ${calls}`);
});

test("renderFrame produces panel lines aligned with header/footer borders", () => {
  // Cursor Medium regression: panel lines were 71 chars while
  // header/footer were 72, misaligning the right-hand ║ column.
  const frame = renderFrame({
    snapshot: makeSnapshot(),
    renderError: null,
    now: () => Date.parse("2025-01-01T00:00:00.000Z"),
  });
  const lines = frame.split("\n").filter((l) => l.length > 0);
  // First line is the header, last is the footer; everything between
  // is a panel line. All must be the same visual width.
  const widths = new Set(lines.map((l) => [...l].length));
  assert.equal(
    widths.size,
    1,
    `expected uniform line widths, saw ${[...widths].sort().join(", ")}`,
  );
});

test("runConsoleTui survives a renderer-side exception without freezing", async () => {
  // Cursor Low regression: if the render path threw after `inFlight`
  // was set to true, the latch was never released and every
  // subsequent tick silently bailed via `if (inFlight) return`. The
  // try/finally fix should keep the loop ticking even if `now()`
  // returns NaN (which makes `new Date(NaN).toISOString()` throw).
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  let nowCalls = 0;
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 30,
    output: stream,
    installSigintHandler: false,
    now: () => {
      nowCalls += 1;
      // First two calls poison the renderer; subsequent ticks recover.
      if (nowCalls <= 2) return Number.NaN;
      return Date.parse("2025-01-01T00:00:00.000Z");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  handle.stop();
  await handle.done;

  // The loop kept ticking through the poisoned renders.
  assert.ok(
    nowCalls >= 3,
    `expected loop to keep ticking past renderer failure, saw ${nowCalls} now() calls`,
  );
  // And eventually emitted a healthy frame.
  const text = stream.textPlain();
  assert.match(text, /remnic console/);
});

test("traceRecorder.append is invoked once per successful tick", async () => {
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  const appended: number[] = [];
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 30,
    output: stream,
    installSigintHandler: false,
    traceRecorder: {
      append: async () => {
        appended.push(Date.now());
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  handle.stop();
  await handle.done;
  assert.ok(
    appended.length >= 2,
    `expected >= 2 trace appends, got ${appended.length}`,
  );
});

test("slow trace writes do not block render ticks (Codex P2 #732)", async () => {
  // Regression for Codex review on PR #732: the render tick must not
  // `await` the trace write before painting. If it did, a slow disk
  // (or network FS) would hold `inFlight = true` for the duration of
  // the write, causing every subsequent tick to bail at
  // `if (inFlight) return` and making `--record-trace` look frozen.
  // This test wires a recorder whose `append` never resolves and
  // asserts that frames keep painting anyway.
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  let appendCalls = 0;
  // Pending promise — never resolves. If the tick awaits this, the
  // loop freezes after a single paint.
  const stalledAppend = new Promise<void>(() => {
    /* never resolves */
  });
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 20,
    output: stream,
    installSigintHandler: false,
    traceRecorder: {
      append: async () => {
        appendCalls += 1;
        return stalledAppend;
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  handle.stop();
  await handle.done;

  // If the render path were still awaiting the stalled write, only
  // the first tick would have called `append` (subsequent ticks
  // would short-circuit on `inFlight`). With fire-and-forget, every
  // tick calls `append` because each prior tick releases the latch
  // immediately after painting.
  assert.ok(
    appendCalls >= 3,
    `expected loop to keep ticking past stalled trace write, saw ${appendCalls} append calls`,
  );
  // And the rendered output should reflect multiple paints.
  const text = stream.textPlain();
  const headerCount = (text.match(/remnic console/g) ?? []).length;
  assert.ok(
    headerCount >= 3,
    `expected >= 3 painted frames despite stalled trace, saw ${headerCount}`,
  );
});

test("stop() clears the interval and resolves done", async () => {
  const stream = new CaptureStream();
  const orchestrator = makeOrchestrator();
  const handle = runConsoleTui(orchestrator, {
    refreshIntervalMs: 30,
    output: stream,
    installSigintHandler: false,
  });

  // Let it paint at least once.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const beforeStop = stream.chunks.length;
  handle.stop();
  await handle.done;

  // Wait past several would-be intervals and confirm no further paints.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterStop = stream.chunks.length;
  // A single trailing write (cursor restore) is allowed but no paints
  // beyond that should happen.
  assert.ok(
    afterStop - beforeStop <= 1,
    `expected interval to stop, saw ${afterStop - beforeStop} extra writes`,
  );

  // done() resolved (we already awaited it). Calling stop again is a no-op.
  handle.stop();
});
