import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import {
  openTraceRecorder,
  replayTrace,
  parseSnapshotLine,
  computeReplayDelay,
  parseSpeedFlag,
} from "./trace.js";
import { stripAnsi } from "./tui.js";
import type { ConsoleStateSnapshot } from "./state.js";

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

function makeSnapshot(
  overrides: Partial<ConsoleStateSnapshot> = {},
): ConsoleStateSnapshot {
  return {
    capturedAt: "2026-04-26T00:00:00.000Z",
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

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-trace-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("openTraceRecorder writes one parseable JSON object per line", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "nested", "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    try {
      await recorder.append(
        makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }),
      );
      await recorder.append(
        makeSnapshot({
          capturedAt: "2026-04-26T00:00:02.000Z",
          bufferState: { turnsCount: 5, byteCount: 100 },
        }),
      );
      await recorder.append(
        makeSnapshot({ capturedAt: "2026-04-26T00:00:04.000Z" }),
      );
    } finally {
      await recorder.close();
    }
    assert.equal(recorder.getLastError(), null);

    const raw = await fs.readFile(tracePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3, "expected three frames in the trace");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.capturedAt, "string");
      assert.ok(parsed.bufferState, "each line carries a bufferState");
    }
    const second = JSON.parse(lines[1]);
    assert.equal(second.bufferState.turnsCount, 5);
  });
});

test("openTraceRecorder appends to an existing file rather than truncating", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const r1 = await openTraceRecorder(tracePath);
    await r1.append(makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }));
    await r1.close();
    const r2 = await openTraceRecorder(tracePath);
    await r2.append(makeSnapshot({ capturedAt: "2026-04-26T00:00:01.000Z" }));
    await r2.close();
    const raw = await fs.readFile(tracePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
  });
});

test("replayTrace renders every frame and emits expected stdout snapshots", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    await recorder.append(
      makeSnapshot({
        capturedAt: "2026-04-26T00:00:00.000Z",
        bufferState: { turnsCount: 1, byteCount: 10 },
      }),
    );
    await recorder.append(
      makeSnapshot({
        capturedAt: "2026-04-26T00:00:02.000Z",
        bufferState: { turnsCount: 7, byteCount: 70 },
      }),
    );
    await recorder.append(
      makeSnapshot({
        capturedAt: "2026-04-26T00:00:04.000Z",
        bufferState: { turnsCount: 11, byteCount: 99 },
      }),
    );
    await recorder.close();

    const stream = new CaptureStream();
    const result = await replayTrace(tracePath, {
      output: stream,
      speed: 1000, // collapse delays for the test
      sleep: () => Promise.resolve(),
      manageCursor: false,
    });

    assert.equal(result.framesRendered, 3);
    assert.equal(result.framesSkipped, 0);
    assert.ok(result.lastSnapshot);
    assert.equal(result.lastSnapshot?.bufferState.turnsCount, 11);

    const text = stream.textPlain();
    // All three buffer-state values should have been rendered.
    assert.match(text, /turns=1 bytes=10/);
    assert.match(text, /turns=7 bytes=70/);
    assert.match(text, /turns=11 bytes=99/);
    // The header is reused from the live TUI.
    assert.match(text, /remnic console/);
  });
});

test("replayTrace skips malformed lines without crashing", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const valid = JSON.stringify(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }),
    );
    const corrupt =
      `${valid}\n` +
      "{not json\n" +
      "null\n" +
      "[1,2,3]\n" +
      `${JSON.stringify(makeSnapshot({ capturedAt: "2026-04-26T00:00:01.000Z" }))}\n`;
    await fs.writeFile(tracePath, corrupt, "utf-8");

    const stream = new CaptureStream();
    const result = await replayTrace(tracePath, {
      output: stream,
      sleep: () => Promise.resolve(),
      manageCursor: false,
    });
    assert.equal(result.framesRendered, 2);
    // Three malformed lines: bad JSON, null literal, array literal.
    assert.equal(result.framesSkipped, 3);
  });
});

test("replayTrace --speed 2 halves the inter-frame delay vs --speed 1", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    // Two frames captured 4s apart.
    await recorder.append(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }),
    );
    await recorder.append(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:04.000Z" }),
    );
    await recorder.close();

    const recordDelays = async (
      speed: number,
    ): Promise<number[]> => {
      const delays: number[] = [];
      const stream = new CaptureStream();
      await replayTrace(tracePath, {
        output: stream,
        speed,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        manageCursor: false,
      });
      return delays;
    };

    const oneX = await recordDelays(1);
    const twoX = await recordDelays(2);

    assert.deepEqual(oneX, [4000]);
    assert.deepEqual(twoX, [2000]);
    assert.equal(twoX[0], oneX[0] / 2);
  });
});

test("computeReplayDelay clamps and respects the speed multiplier", () => {
  // Normal case.
  assert.equal(computeReplayDelay(2000, 1), 2000);
  assert.equal(computeReplayDelay(2000, 2), 1000);
  assert.equal(computeReplayDelay(2000, 0.5), 4000);
  // Negative / zero deltas → no wait.
  assert.equal(computeReplayDelay(-100, 1), 0);
  assert.equal(computeReplayDelay(0, 1), 0);
  // Non-finite → no wait.
  assert.equal(computeReplayDelay(Number.NaN, 1), 0);
  // Speed Infinity → no wait.
  assert.equal(computeReplayDelay(2000, Infinity), 0);
  // Cap at MAX_REPLAY_DELAY_MS (60s).
  assert.equal(computeReplayDelay(10 * 60 * 1000, 1), 60_000);
});

test("parseSpeedFlag accepts positive numbers and rejects garbage", () => {
  assert.equal(parseSpeedFlag(undefined), 1);
  assert.equal(parseSpeedFlag(null), 1);
  assert.equal(parseSpeedFlag(2), 2);
  assert.equal(parseSpeedFlag("0.5"), 0.5);
  assert.throws(() => parseSpeedFlag("0"), /must be > 0/);
  assert.throws(() => parseSpeedFlag("-1"), /must be > 0/);
  assert.throws(() => parseSpeedFlag("abc"), /must be a positive number/);
});

test("parseSnapshotLine handles all the JSON edge cases", () => {
  assert.equal(parseSnapshotLine(""), null);
  assert.equal(parseSnapshotLine("not json"), null);
  assert.equal(parseSnapshotLine("null"), null);
  assert.equal(parseSnapshotLine("[1,2,3]"), null);
  assert.equal(parseSnapshotLine("42"), null);
  const snap = makeSnapshot();
  const parsed = parseSnapshotLine(JSON.stringify(snap));
  assert.ok(parsed);
  assert.equal(parsed?.capturedAt, snap.capturedAt);
});

test("recorder error path does not crash on poisoned writes", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    // First append succeeds.
    await recorder.append(makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }));
    // Close the recorder — subsequent appends become no-ops.
    await recorder.close();
    // Second append after close — must not throw.
    await recorder.append(makeSnapshot({ capturedAt: "2026-04-26T00:00:01.000Z" }));
    const raw = await fs.readFile(tracePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, "post-close append should be dropped");
  });
});

test("replayTrace defaultSleep aborts immediately on signal (Codex P2 regression)", async () => {
  // Regression for Codex review on PR #732: the default sleep used
  // setTimeout with no abort hook, so SIGINT mid-wait could leave
  // Ctrl-C unresponsive for up to MAX_REPLAY_DELAY_MS (60s). The
  // default sleep is now bound to options.signal; aborting during a
  // wait must resolve the sleep promise immediately.
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    // Two frames 5 seconds apart — without abort wiring, replay
    // would block for 5s after the first frame paints.
    await recorder.append(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:00.000Z" }),
    );
    await recorder.append(
      makeSnapshot({ capturedAt: "2026-04-26T00:00:05.000Z" }),
    );
    await recorder.close();

    const stream = new CaptureStream();
    const ac = new AbortController();
    // Abort 50ms after replay starts — should land mid-sleep on
    // the 5000ms inter-frame wait.
    setTimeout(() => ac.abort(), 50);

    const start = Date.now();
    const result = await replayTrace(tracePath, {
      output: stream,
      manageCursor: false,
      signal: ac.signal,
      // Use the default sleep (no override) so we exercise the
      // abort-aware code path.
    });
    const elapsed = Date.now() - start;

    // Without the fix, this would take ~5000ms. With the fix, it
    // resolves shortly after the abort fires (well under 1s).
    assert.ok(
      elapsed < 1000,
      `expected abort to short-circuit sleep, took ${elapsed}ms`,
    );
    // First frame should have rendered before the abort interrupted.
    assert.equal(result.framesRendered, 1);
  });
});

test("recorder close() drains pending writes (Codex P1 regression)", async () => {
  // Regression for Codex review on PR #732: `close()` must NOT flip
  // `closed = true` before draining the write chain. Queued writes
  // begin with `if (closed) return;`, so flipping the flag first
  // would silently drop frames the caller already enqueued via
  // `append()` immediately before `close()`.
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    // Fire-and-forget a batch of appends, then close immediately.
    // Without the fix, several of these would be dropped.
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      writes.push(
        recorder.append(
          makeSnapshot({
            capturedAt: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
          }),
        ),
      );
    }
    // Do NOT await `writes` first — close concurrently with pending appends.
    const closePromise = recorder.close();
    await Promise.all(writes);
    await closePromise;
    const raw = await fs.readFile(tracePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(
      lines.length,
      10,
      "all queued writes must drain before close completes",
    );
  });
});

test("recorder serializes concurrent appends without interleaving", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      writes.push(
        recorder.append(
          makeSnapshot({
            capturedAt: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
          }),
        ),
      );
    }
    await Promise.all(writes);
    await recorder.close();
    const raw = await fs.readFile(tracePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 25);
    // Every line must be parseable — interleaved writes would break this.
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.capturedAt, "string");
    }
  });
});

test("replayTrace honors AbortSignal mid-replay", async () => {
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    for (let i = 0; i < 10; i++) {
      await recorder.append(
        makeSnapshot({
          capturedAt: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }
    await recorder.close();

    const stream = new CaptureStream();
    const ac = new AbortController();
    let frames = 0;
    const result = await replayTrace(tracePath, {
      output: stream,
      sleep: async () => {
        frames += 1;
        if (frames >= 2) ac.abort();
      },
      manageCursor: false,
      signal: ac.signal,
    });
    assert.ok(
      result.framesRendered < 10,
      `expected early abort, rendered ${result.framesRendered}`,
    );
  });
});

test("replayTrace restores cursor + closes stream when aborted (Codex P2 #732)", async () => {
  // Regression for Codex review on PR #732: the CLI replay path must
  // wire SIGINT to an AbortController so Ctrl-C exits cleanly and the
  // `replayTrace` `finally` block runs. This test exercises the
  // replay-side contract: aborting mid-stream must still execute the
  // `finally` block — which writes the show-cursor escape and closes
  // the underlying handles. (CLI-side SIGINT wiring is verified by
  // visual inspection; this test guarantees the abort semantics the
  // CLI relies on.)
  await withTempDir(async (dir) => {
    const tracePath = path.join(dir, "trace.jsonl");
    const recorder = await openTraceRecorder(tracePath);
    for (let i = 0; i < 10; i++) {
      await recorder.append(
        makeSnapshot({
          capturedAt: `2026-04-26T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }
    await recorder.close();

    const stream = new CaptureStream();
    const ac = new AbortController();
    let frames = 0;
    const result = await replayTrace(tracePath, {
      output: stream,
      sleep: async () => {
        frames += 1;
        if (frames >= 1) ac.abort();
      },
      // manageCursor: true (default) so we can assert the show-cursor
      // sequence was emitted by the `finally` block.
      manageCursor: true,
      signal: ac.signal,
    });

    assert.ok(
      result.framesRendered < 10,
      `expected early abort, rendered ${result.framesRendered}`,
    );

    // Cursor cleanup ran: the raw output must contain both the hide
    // (start-of-replay) AND show (`finally`-block) escape sequences.
    const raw = stream.text();
    assert.ok(
      raw.includes("\x1b[?25l"),
      "expected hide-cursor escape at replay start",
    );
    assert.ok(
      raw.includes("\x1b[?25h"),
      "expected show-cursor escape from finally block after abort",
    );
  });
});
