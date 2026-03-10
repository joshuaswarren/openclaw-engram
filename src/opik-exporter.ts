import { randomUUID } from "node:crypto";
/**
 * opik-exporter.ts — Engram-native Opik trace exporter
 *
 * Subscribes to the globalThis.__openclawEngramTrace slot that Engram already
 * emits on, and forwards recall + LLM events to a self-hosted (or cloud) Opik
 * instance via its REST API. No extra npm dependencies — uses Node's built-in
 * fetch.
 *
 * Auto-detects apiUrl / projectName from the opik-openclaw plugin config so
 * traces land in the same project and are grouped by session thread.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LoggerBackend } from "./logger.js";

// ---------------------------------------------------------------------------
// Engram event types (mirrors types.ts without importing from it)
// ---------------------------------------------------------------------------

type EngramLlmTraceEvent = {
  kind: "llm_start" | "llm_end" | "llm_error";
  traceId: string;
  model: string;
  operation: "extraction" | "consolidation" | "profile_consolidation" | "identity_consolidation";
  input?: string;
  output?: string;
  durationMs?: number;
  error?: string;
  tokenUsage?: { input?: number; output?: number; total?: number };
};

type EngramRecallTraceEvent = {
  kind: "recall_summary";
  traceId: string;
  operation: "recall";
  sessionKey?: string;
  promptLength: number;
  retrievalQueryLength: number;
  recallMode: string;
  recallResultLimit: number;
  qmdEnabled: boolean;
  qmdAvailable: boolean;
  recallNamespaces: string[];
  source: string;
  recalledMemoryCount: number;
  injected: boolean;
  contextChars: number;
  identityInjectionMode?: string;
  identityInjectedChars?: number;
  durationMs: number;
  timings?: Record<string, string>;
  recalledContent?: string;
};

type EngramTraceEvent = EngramLlmTraceEvent | EngramRecallTraceEvent;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpikExporterConfig {
  enabled: boolean;
  /** Base URL of the Opik API, e.g. http://192.168.3.147:5173/api */
  apiUrl: string;
  projectName: string;
  workspaceName: string;
  /** Optional API key (not required for self-hosted deployments) */
  apiKey?: string;
  /** Include recalled memory text in spans (default false) */
  traceRecallContent: boolean;
}

// ---------------------------------------------------------------------------
// Auto-detect from opik-openclaw plugin config
// ---------------------------------------------------------------------------

function readOpikOpenclawConfig(): Partial<OpikExporterConfig> {
  try {
    const configPath =
      process.env.OPENCLAW_CONFIG_PATH ??
      path.join(process.env.HOME ?? os.homedir(), ".openclaw", "openclaw.json");
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const entry = raw?.plugins?.entries?.["opik-openclaw"];
    if (!entry?.enabled || !entry?.config) return {};
    const c = entry.config as Record<string, unknown>;
    return {
      apiUrl: typeof c.apiUrl === "string" && c.apiUrl.length > 0 ? c.apiUrl : undefined,
      projectName: typeof c.projectName === "string" ? c.projectName : undefined,
      workspaceName: typeof c.workspaceName === "string" ? c.workspaceName : undefined,
      apiKey: typeof c.apiKey === "string" && c.apiKey.length > 0 ? c.apiKey : undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

function buildHeaders(cfg: OpikExporterConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.workspaceName) headers["Comet-Workspace"] = cfg.workspaceName;
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  return headers;
}

async function postSpanBatch(
  cfg: OpikExporterConfig,
  spans: unknown[],
  log: LoggerBackend,
): Promise<void> {
  const url = `${cfg.apiUrl.replace(/\/$/, "")}/v1/private/spans/batch`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(cfg),
      body: JSON.stringify({ spans }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.debug?.(`[opik-exporter] span batch failed ${res.status}: ${text}`);
    }
  } catch (err) {
    log.debug?.(`[opik-exporter] span batch error: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// In-flight LLM span tracking
// ---------------------------------------------------------------------------

type InFlightLlm = {
  startedAt: number;
  startTime: string;
  model: string;
  operation: string;
  input?: string;
  spanId: string;
  traceId: string;
};

// ---------------------------------------------------------------------------
// Main exporter class
// ---------------------------------------------------------------------------

export class OpikExporter {
  private readonly cfg: OpikExporterConfig;
  private readonly log: LoggerBackend;
  private readonly inFlight = new Map<string, InFlightLlm>();
  /** TTL for in-flight LLM entries (ms). Entries older than this are discarded. */
  private static readonly IN_FLIGHT_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(cfg: OpikExporterConfig, log: LoggerBackend) {
    this.cfg = cfg;
    this.log = log;
  }

  /**
   * Subscribe to Engram's global trace slot. Safe to call multiple times —
   * chains with existing subscribers (e.g. Langfuse) rather than replacing.
   */
  subscribe(): void {
    if (!this.cfg.enabled) return;

    const existing = (globalThis as Record<string, unknown>).__openclawEngramTrace as
      | ((e: EngramTraceEvent) => void)
      | undefined;

    const handler = (event: EngramTraceEvent) => {
      try {
        this.handleEvent(event);
      } catch (err) {
        this.log.debug?.(`[opik-exporter] handler error: ${err}`);
      }
    };

    (globalThis as Record<string, unknown>).__openclawEngramTrace =
      typeof existing === "function"
        ? (event: EngramTraceEvent) => {
            existing(event);
            handler(event);
          }
        : handler;

    this.log.info(
      `[opik-exporter] subscribed — apiUrl=${this.cfg.apiUrl} project=${this.cfg.projectName}`,
    );
  }

  unsubscribe(): void {
    // Best-effort: if we're the outermost handler, clear it. In practice the
    // gateway restart path handles this via process exit.
    const current = (globalThis as Record<string, unknown>).__openclawEngramTrace;
    if (current === undefined) return;
    // We can't easily un-chain, so just log. The gateway will restart anyway.
    this.log.debug?.("[opik-exporter] unsubscribe called (no-op in chained mode)");
  }

  private handleEvent(event: EngramTraceEvent): void {
    if (event.kind === "recall_summary") {
      void this.onRecall(event);
    } else if (event.kind === "llm_start") {
      this.onLlmStart(event);
    } else if (event.kind === "llm_end" || event.kind === "llm_error") {
      void this.onLlmEnd(event);
    }
  }

  // -------------------------------------------------------------------------
  // Recall events → general span
  // -------------------------------------------------------------------------

  private async onRecall(evt: EngramRecallTraceEvent): Promise<void> {
    const now = new Date();
    const startTime = new Date(now.getTime() - evt.durationMs).toISOString();
    const endTime = now.toISOString();

    const input: Record<string, unknown> = {
      recallMode: evt.recallMode,
      recalledMemoryCount: evt.recalledMemoryCount,
      recallNamespaces: evt.recallNamespaces,
      source: evt.source,
      qmdEnabled: evt.qmdEnabled,
      qmdAvailable: evt.qmdAvailable,
      retrievalQueryLength: evt.retrievalQueryLength,
      recallResultLimit: evt.recallResultLimit,
      promptLength: evt.promptLength,
    };

    if (this.cfg.traceRecallContent && evt.recalledContent) {
      input.recalledContent = evt.recalledContent;
    }

    const metadata: Record<string, unknown> = {
      source: "engram",
      injected: evt.injected,
      contextChars: evt.contextChars,
      durationMs: evt.durationMs,
    };

    if (evt.identityInjectionMode) {
      metadata.identityInjectionMode = evt.identityInjectionMode;
      metadata.identityInjectedChars = evt.identityInjectedChars;
    }

    if (evt.timings) metadata.timings = evt.timings;

    const span = {
      id: randomUUID(),
      trace_id: evt.sessionKey ? this.sessionToTraceId(evt.sessionKey) : randomUUID(),
      project_name: this.cfg.projectName,
      name: "engram:recall",
      type: "general",
      start_time: startTime,
      end_time: endTime,
      input,
      metadata,
      tags: ["engram", "recall"],
    };

    await postSpanBatch(this.cfg, [span], this.log);
  }

  // -------------------------------------------------------------------------
  // Engram internal LLM events (extraction / consolidation) → llm span
  // -------------------------------------------------------------------------

  private onLlmStart(evt: EngramLlmTraceEvent): void {
    this.inFlight.set(evt.traceId, {
      startedAt: Date.now(),
      startTime: new Date().toISOString(),
      model: evt.model,
      operation: evt.operation,
      input: evt.input,
      spanId: randomUUID(),
      traceId: randomUUID(),
    });
  }

  private sweepStaleInFlight(): void {
    const cutoff = Date.now() - OpikExporter.IN_FLIGHT_TTL_MS;
    for (const [id, entry] of this.inFlight) {
      if (entry.startedAt < cutoff) {
        this.inFlight.delete(id);
      }
    }
  }

  private async onLlmEnd(evt: EngramLlmTraceEvent): Promise<void> {
    // Opportunistically sweep stale entries to prevent unbounded map growth.
    if (this.inFlight.size > 20) this.sweepStaleInFlight();
    const state = this.inFlight.get(evt.traceId);
    this.inFlight.delete(evt.traceId);

    const startTime = state?.startTime ?? new Date().toISOString();
    const endTime = new Date().toISOString();

    const usage: Record<string, number> = {};
    if (evt.tokenUsage?.input != null) usage.prompt_tokens = evt.tokenUsage.input;
    if (evt.tokenUsage?.output != null) usage.completion_tokens = evt.tokenUsage.output;
    if (evt.tokenUsage?.total != null) usage.total_tokens = evt.tokenUsage.total;

    const span: Record<string, unknown> = {
      id: state?.spanId ?? randomUUID(),
      trace_id: state?.traceId ?? randomUUID(),
      project_name: this.cfg.projectName,
      name: `engram:${evt.operation}`,
      type: "llm",
      model: evt.model,
      start_time: startTime,
      end_time: endTime,
      input: state?.input != null ? { prompt: state.input } : undefined,
      output:
        evt.kind === "llm_end" && evt.output != null
          ? { completion: evt.output }
          : evt.kind === "llm_error"
            ? { error: evt.error }
            : undefined,
      metadata: {
        source: "engram",
        operation: evt.operation,
        durationMs: evt.durationMs ?? (state ? Date.now() - state.startedAt : undefined),
      },
      tags: ["engram", evt.operation],
      usage: Object.keys(usage).length > 0 ? usage : undefined,
    };

    await postSpanBatch(this.cfg, [span], this.log);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Convert a sessionKey to a stable UUID v5-like deterministic ID so that
   * spans for the same session share a trace_id and are threaded in Opik.
   * We use a simple XOR fold rather than pulling in the `uuid` v5 module.
   */
  private sessionToTraceId(sessionKey: string): string {
    // Simple deterministic mapping: hash sessionKey bytes into 16 bytes
    const bytes = new Uint8Array(16);
    for (let i = 0; i < sessionKey.length; i++) {
      bytes[i % 16] ^= sessionKey.charCodeAt(i);
    }
    // Stamp as UUID v4 format (not truly v4 but valid UUID hex shape)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

// ---------------------------------------------------------------------------
// Factory: build from Engram resolved config + auto-detect from opik-openclaw
// ---------------------------------------------------------------------------

export interface OpikExporterRawConfig {
  opikTraceEnabled?: boolean;
  opikApiUrl?: string;
  opikProjectName?: string;
  opikWorkspaceName?: string;
  opikApiKey?: string;
  opikTraceRecallContent?: boolean;
}

export function createOpikExporter(
  raw: OpikExporterRawConfig,
  log: LoggerBackend,
): OpikExporter | null {
  // Explicit opt-out: if set to false, never enable.
  if (raw.opikTraceEnabled === false) return null;

  // Auto-detect from opik-openclaw plugin config.
  // If opikTraceEnabled is not set (undefined), we enable automatically
  // whenever opik-openclaw is configured — avoids needing extra fields in
  // Engram's openclaw.json config section (which would fail schema validation).
  const detected = readOpikOpenclawConfig();

  const apiUrl = raw.opikApiUrl ?? detected.apiUrl;
  if (!apiUrl) {
    // Only warn when the user explicitly opted in but forgot to set the URL.
    // When auto-detecting (opikTraceEnabled not set), return silently so non-Opik
    // users see no log noise on every startup.
    if (raw.opikTraceEnabled === true) {
      log.warn(
        "[opik-exporter] opikTraceEnabled=true but no apiUrl found — " +
          "set opikApiUrl in Engram config or ensure opik-openclaw plugin is configured",
      );
    }
    return null;
  }

  const cfg: OpikExporterConfig = {
    enabled: true,
    apiUrl,
    projectName: raw.opikProjectName ?? detected.projectName ?? "openclaw",
    workspaceName: raw.opikWorkspaceName ?? detected.workspaceName ?? "default",
    apiKey: raw.opikApiKey ?? detected.apiKey,
    traceRecallContent: raw.opikTraceRecallContent === true,
  };

  return new OpikExporter(cfg, log);
}
