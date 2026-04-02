// Performance profiling collector for recall and extraction traces.
// Zero external dependencies — uses only node:fs and node:path.

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileSpan {
  name: string;
  startOffsetMs: number;
  durationMs: number;
}

export interface ProfileParallelGroupMember {
  name: string;
  durationMs: number;
  resolvedIndex: number;
}

export interface ProfileParallelGroup {
  name: string;
  startOffsetMs: number;
  wallMs: number;
  members: ProfileParallelGroupMember[];
}

export interface ProfileTrace {
  ts: string;
  kind: "recall" | "extraction";
  traceId: string;
  sessionKey?: string;
  totalMs: number;
  spans: ProfileSpan[];
  parallelGroups?: ProfileParallelGroup[];
  configSnapshot?: Record<string, unknown>;
}

export interface ProfilingConfig {
  enabled: boolean;
  storageDir: string;
  maxTraces: number;
}

export interface ParallelGroupHandle {
  name: string;
  startOffsetMs: number;
}

export interface ProfilingStats {
  byKind: Record<string, { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number }>;
  bySpan: Record<string, { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function aggregateStats(values: number[]): { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number } {
  const count = values.length;
  if (count === 0) return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count,
    avgMs: Math.round(sum / count),
    p50Ms: Math.round(percentile(sorted, 50)),
    p95Ms: Math.round(percentile(sorted, 95)),
    maxMs: sorted[sorted.length - 1],
  };
}

let traceCounter = 0;

// ---------------------------------------------------------------------------
// ProfilingCollector
// ---------------------------------------------------------------------------

export class ProfilingCollector {
  private enabled: boolean;
  private storageDir: string;
  private maxTraces: number;
  private traces: ProfileTrace[] = [];

  // Active trace state (single trace at a time).
  private activeTraceStart = 0;
  private activeTraceKind: "recall" | "extraction" | null = null;
  private activeTraceId = "";
  private activeSessionKey?: string;
  private activeConfigSnapshot?: Record<string, unknown>;
  private activeSpans: ProfileSpan[] = [];
  private activeSpanStarts: Map<string, number> = new Map();
  private activeParallelGroups: ProfileParallelGroup[] = [];

  constructor(config: ProfilingConfig) {
    this.enabled = config.enabled;
    this.storageDir = config.storageDir;
    this.maxTraces = config.maxTraces;

    if (this.enabled) {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
        log.debug(`profiling: created storage dir ${this.storageDir}`);
      }
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  // ---- Trace lifecycle ---------------------------------------------------

  startTrace(kind: "recall" | "extraction", sessionKey?: string, configSnapshot?: Record<string, unknown>): string {
    if (!this.enabled) return "";
    if (this.activeTraceKind) {
      log.debug(`profiling: skipping startTrace — trace ${this.activeTraceId} already active`);
      return "";
    }
    traceCounter++;
    this.activeTraceStart = Date.now();
    this.activeTraceKind = kind;
    this.activeTraceId = `t${traceCounter}-${Date.now().toString(36)}`;
    this.activeSessionKey = sessionKey;
    this.activeConfigSnapshot = configSnapshot;
    this.activeSpans = [];
    this.activeSpanStarts = new Map();
    this.activeParallelGroups = [];
    log.debug(`profiling: started trace ${this.activeTraceId} kind=${kind}`);
    return this.activeTraceId;
  }

  startSpan(name: string): void {
    if (!this.activeTraceKind) return;
    const offset = Date.now() - this.activeTraceStart;
    this.activeSpanStarts.set(name, Date.now());
    log.debug(`profiling: span ${name} started at +${offset}ms`);
  }

  endSpan(name: string): void {
    if (!this.activeTraceKind) return;
    const start = this.activeSpanStarts.get(name);
    if (start === undefined) return;
    const duration = Date.now() - start;
    const startOffset = start - this.activeTraceStart;
    this.activeSpans.push({ name, startOffsetMs: startOffset, durationMs: duration });
    this.activeSpanStarts.delete(name);
    log.debug(`profiling: span ${name} ended ${duration}ms`);
  }

  endTrace(): ProfileTrace | null {
    if (!this.activeTraceKind) return null;

    const trace: ProfileTrace = {
      ts: new Date().toISOString(),
      kind: this.activeTraceKind,
      traceId: this.activeTraceId,
      totalMs: Date.now() - this.activeTraceStart,
      spans: this.activeSpans,
      configSnapshot: this.activeConfigSnapshot,
    };

    if (this.activeSessionKey) {
      trace.sessionKey = this.activeSessionKey;
    }
    if (this.activeParallelGroups.length > 0) {
      trace.parallelGroups = this.activeParallelGroups;
    }

    // Reset active state.
    this.activeTraceKind = null;
    this.activeSpanStarts.clear();

    if (!this.enabled) {
      log.debug("profiling: trace discarded (disabled)");
      return null;
    }

    // Persist.
    this.persistTrace(trace);

    // Buffer in memory (FIFO).
    this.traces.push(trace);
    if (this.traces.length > this.maxTraces) {
      this.traces.shift();
    }

    this.pruneFiles();
    log.debug(`profiling: trace ${trace.traceId} finalized totalMs=${trace.totalMs}`);
    return trace;
  }

  // ---- Parallel group tracking -------------------------------------------

  startParallelGroup(name: string): ParallelGroupHandle {
    const startOffsetMs = this.activeTraceKind ? Date.now() - this.activeTraceStart : 0;
    return { name, startOffsetMs };
  }

  async endParallelGroup(
    handle: ParallelGroupHandle,
    members: Array<{ name: string; promise: Promise<unknown> }>,
  ): Promise<void> {
    const wallStart = Date.now();
    const results = await Promise.allSettled(members.map((m) => m.promise));

    if (!this.activeTraceKind) return;

    const wallMs = Date.now() - wallStart;

    // Capture individual durations by wrapping — but since we receive raw
    // promises, we record wall time per member from settlement timestamps.
    // We use resolvedIndex to show which finished first.
    const groupMembers: ProfileParallelGroupMember[] = members.map((m, i) => ({
      name: m.name,
      durationMs: wallMs, // fallback — individual timing needs instrumentation
      resolvedIndex: i,
    }));

    // If we have at least one fulfilled member, try to estimate durations.
    // Since the promises were started before endParallelGroup was called,
    // the wall time is the best approximation for all members.
    // Users who need per-member timing should wrap their promises with timers.

    this.activeParallelGroups.push({
      name: handle.name,
      startOffsetMs: handle.startOffsetMs,
      wallMs,
      members: groupMembers,
    });

    log.debug(`profiling: parallel group ${handle.name} wallMs=${wallMs}`);
  }

  // ---- Query methods -----------------------------------------------------

  getRecentTraces(limit?: number): ProfileTrace[] {
    const n = limit ?? this.traces.length;
    return this.traces.slice(-n);
  }

  getStats(): ProfilingStats {
    const byKind: Record<string, number[]> = {};
    const bySpan: Record<string, number[]> = {};

    for (const trace of this.traces) {
      if (!byKind[trace.kind]) byKind[trace.kind] = [];
      byKind[trace.kind].push(trace.totalMs);

      for (const span of trace.spans) {
        if (!bySpan[span.name]) bySpan[span.name] = [];
        bySpan[span.name].push(span.durationMs);
      }
    }

    const result: ProfilingStats = { byKind: {}, bySpan: {} };
    for (const [k, v] of Object.entries(byKind)) {
      result.byKind[k] = aggregateStats(v);
    }
    for (const [k, v] of Object.entries(bySpan)) {
      result.bySpan[k] = aggregateStats(v);
    }
    return result;
  }

  identifyBottleneck(): string | null {
    if (this.traces.length === 0) return null;
    const latest = this.traces[this.traces.length - 1];
    if (latest.spans.length === 0) return null;
    let slowest = latest.spans[0];
    for (const span of latest.spans) {
      if (span.durationMs > slowest.durationMs) slowest = span;
    }
    return slowest.name;
  }

  parallelEfficiency(trace: ProfileTrace): number | null {
    if (!trace.parallelGroups || trace.parallelGroups.length === 0) return null;
    const group = trace.parallelGroups[0];
    if (group.members.length <= 1) return null;
    const idealMs = Math.max(...group.members.map((m) => m.durationMs));
    if (group.wallMs === 0) return null;
    return Math.round((idealMs / group.wallMs) * 100);
  }

  // ---- Persistence -------------------------------------------------------

  private persistTrace(trace: ProfileTrace): void {
    const filename = `${trace.kind}-${trace.traceId}.jsonl`;
    const filepath = join(this.storageDir, filename);
    try {
      writeFileSync(filepath, JSON.stringify(trace) + "\n", "utf-8");
      log.debug(`profiling: persisted ${filename}`);
    } catch (err) {
      log.warn(`profiling: failed to persist ${filename}`, err);
    }
  }

  pruneFiles(): void {
    try {
      const files = readdirSync(this.storageDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();

      while (files.length > this.maxTraces) {
        const oldest = files.shift()!;
        unlinkSync(join(this.storageDir, oldest));
        log.debug(`profiling: pruned ${oldest}`);
      }
    } catch (err) {
      log.warn("profiling: prune failed", err);
    }
  }
}

// ---------------------------------------------------------------------------
// ASCII formatter
// ---------------------------------------------------------------------------

export function formatProfileTraceAscii(trace: ProfileTrace): string {
  const lines: string[] = [];
  const BAR_WIDTH = 40;

  lines.push(`=== Profile: ${trace.kind} ===`);
  lines.push(`Trace ID : ${trace.traceId}`);
  lines.push(`Total    : ${trace.totalMs}ms`);
  if (trace.sessionKey) lines.push(`Session  : ${trace.sessionKey}`);
  lines.push("");

  // Identify bottleneck.
  let bottleneckName: string | null = null;
  if (trace.spans.length > 0) {
    let slowest = trace.spans[0];
    for (const s of trace.spans) {
      if (s.durationMs > slowest.durationMs) slowest = s;
    }
    bottleneckName = slowest.name;
  }

  // Spans.
  if (trace.spans.length > 0) {
    const maxDuration = Math.max(...trace.spans.map((s) => s.durationMs), 1);
    lines.push("Spans:");
    for (const span of trace.spans) {
      const barLen = Math.max(1, Math.round((span.durationMs / maxDuration) * BAR_WIDTH));
      const bar = "\u2588".repeat(barLen);
      const suffix = span.name === bottleneckName ? " \u2190 bottleneck" : "";
      lines.push(`  ${span.name.padEnd(30)} ${String(span.durationMs).padStart(6)}ms ${bar}${suffix}`);
    }
    lines.push("");
  }

  // Parallel groups.
  if (trace.parallelGroups && trace.parallelGroups.length > 0) {
    lines.push("Parallel Groups:");
    for (const group of trace.parallelGroups) {
      lines.push(`  ${group.name}:`);
      lines.push(`    Wall time    : ${group.wallMs}ms`);
      const efficiency = parallelEfficiency(group);
      if (efficiency !== null) {
        lines.push(`    Efficiency   : ${efficiency}%`);
      }
      for (const member of group.members) {
        lines.push(`    [${String(member.resolvedIndex).padStart(2)}] ${member.name.padEnd(28)} ${String(member.durationMs).padStart(6)}ms`);
      }
    }
    lines.push("");
  }

  lines.push("---");
  return lines.join("\n");
}

function parallelEfficiency(group: ProfileParallelGroup): number | null {
  if (group.members.length <= 1) return null;
  const idealMs = Math.max(...group.members.map((m) => m.durationMs));
  if (group.wallMs === 0) return null;
  return Math.round((idealMs / group.wallMs) * 100);
}
