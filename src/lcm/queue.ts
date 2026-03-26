export interface LcmObserveMessage {
  role: string;
  content: string;
}

export interface LcmWorkQueueHooks {
  onJobStart?: (input: {
    sessionId: string;
    depth: number;
    inFlight: number;
    waitMs: number;
  }) => void;
  onJobFinish?: (input: {
    sessionId: string;
    depth: number;
    inFlight: number;
    waitMs: number;
    runMs: number;
    totalMs: number;
    error?: unknown;
  }) => void;
}

export interface LcmWorkQueueOptions {
  concurrency?: number;
  worker: (sessionId: string, messages: LcmObserveMessage[]) => Promise<void>;
  hooks?: LcmWorkQueueHooks;
}

interface PendingJob {
  sessionId: string;
  messages: LcmObserveMessage[];
  enqueuedAt: number;
}

/**
 * Small keyed work queue for LCM observe processing.
 *
 * Jobs are coalesced per session while they are pending. A session can have
 * at most one in-flight job at a time, and the queue processes jobs FIFO up to
 * the configured concurrency limit.
 */
export class LcmWorkQueue {
  private readonly concurrency: number;
  private readonly worker: (sessionId: string, messages: LcmObserveMessage[]) => Promise<void>;
  private readonly hooks: LcmWorkQueueHooks;
  private readonly pending = new Map<string, PendingJob>();
  private inFlight = 0;
  private readonly idleWaiters: Array<() => void> = [];
  private drainScheduled = false;

  constructor(options: LcmWorkQueueOptions) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.worker = options.worker;
    this.hooks = options.hooks ?? {};
  }

  enqueue(sessionId: string, messages: LcmObserveMessage[]): void {
    if (messages.length === 0) return;

    const now = Date.now();
    const existing = this.pending.get(sessionId);
    if (existing) {
      existing.messages.push(...messages.map((message) => ({ ...message })));
    } else {
      this.pending.set(sessionId, {
        sessionId,
        messages: messages.map((message) => ({ ...message })),
        enqueuedAt: now,
      });
    }

    this.scheduleDrain();
  }

  get depth(): number {
    return this.pending.size;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  async whenIdle(): Promise<void> {
    if (this.depth === 0 && this.inFlight === 0) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private startAvailableJobs(): void {
    while (this.inFlight < this.concurrency && this.pending.size > 0) {
      const next = this.pending.entries().next();
      if (next.done) break;

      const [sessionId, job] = next.value;
      this.pending.delete(sessionId);
      this.inFlight++;

      const startedAt = Date.now();
      const waitMs = startedAt - job.enqueuedAt;
      this.hooks.onJobStart?.({
        sessionId,
        depth: this.depth,
        inFlight: this.inFlight,
        waitMs,
      });

      void this.runJob(job, startedAt, waitMs);
    }

    this.resolveIdleWaitersIfNeeded();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;

    queueMicrotask(() => {
      this.drainScheduled = false;
      this.startAvailableJobs();
    });
  }

  private async runJob(job: PendingJob, startedAt: number, waitMs: number): Promise<void> {
    let error: unknown;

    try {
      await this.worker(job.sessionId, job.messages);
    } catch (err) {
      error = err;
    } finally {
      const finishedAt = Date.now();
      const runMs = finishedAt - startedAt;
      const totalMs = finishedAt - job.enqueuedAt;

      this.inFlight--;
      this.hooks.onJobFinish?.({
        sessionId: job.sessionId,
        depth: this.depth,
        inFlight: this.inFlight,
        waitMs,
        runMs,
        totalMs,
        error,
      });

      if (this.pending.size > 0) {
        this.scheduleDrain();
      } else {
        this.resolveIdleWaitersIfNeeded();
      }
    }
  }

  private resolveIdleWaitersIfNeeded(): void {
    if (this.depth !== 0 || this.inFlight !== 0) return;

    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) resolve();
  }
}
