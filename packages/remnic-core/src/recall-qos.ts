import { log, type LoggerBackend } from "./logger.js";

export type RecallSectionPriority = "core" | "enrichment";
export type RecallSectionSource = "fresh" | "stale" | "skip";

export interface RecallSectionMetric {
  section: string;
  priority: RecallSectionPriority;
  durationMs: number;
  deadlineMs: number;
  source: RecallSectionSource;
  success: boolean;
  timing?: string;
}

export interface RecallSectionMetricLog {
  message: string;
  payload: {
    section: string;
    priority: RecallSectionPriority;
    durationMs: number;
    deadlineMs: number;
    source: RecallSectionSource;
    success: boolean;
  };
  level: "info" | "debug";
  timing: string;
}

function defaultTiming(metric: RecallSectionMetric): string {
  if (typeof metric.timing === "string" && metric.timing.length > 0) {
    return metric.timing;
  }
  if (metric.source === "skip") {
    return "skip";
  }
  return `${Math.max(0, Math.round(metric.durationMs))}ms`;
}

export function formatRecallSectionMetric(metric: RecallSectionMetric): RecallSectionMetricLog {
  const payload = {
    section: metric.section,
    priority: metric.priority,
    durationMs: metric.durationMs,
    deadlineMs: metric.deadlineMs,
    source: metric.source,
    success: metric.success,
  };
  return {
    message: "recall section metric",
    payload,
    level: metric.priority === "core" && metric.success && metric.source !== "skip" ? "info" : "debug",
    timing: defaultTiming(metric),
  };
}

export function createRecallSectionMetricRecorder(options: {
  timings?: Record<string, string>;
  logger?: Pick<LoggerBackend, "info" | "debug">;
} = {}) {
  const logger = options.logger ?? log;
  return (metric: RecallSectionMetric): RecallSectionMetricLog => {
    const entry = formatRecallSectionMetric(metric);
    if (options.timings) {
      options.timings[metric.section] = entry.timing;
    }
    if (entry.level === "info") {
      if (typeof logger.info === "function") {
        logger.info(entry.message, entry.payload);
      } else {
        log.info(entry.message, entry.payload);
      }
    } else {
      if (typeof logger.debug === "function") {
        logger.debug(entry.message, entry.payload);
      } else {
        log.debug(entry.message, entry.payload);
      }
    }
    return entry;
  };
}
