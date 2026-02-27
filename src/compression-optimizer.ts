import type {
  CompressionGuidelineOptimizerEventCounts,
  CompressionGuidelineOptimizerState,
  MemoryActionEvent,
  MemoryActionOutcome,
  MemoryActionType,
} from "./types.js";

export interface CompressionOptimizerActionSummary {
  action: MemoryActionType;
  total: number;
  outcomes: Record<MemoryActionOutcome, number>;
  quality: {
    good: number;
    poor: number;
    unknown: number;
  };
}

export interface CompressionOptimizerRuleUpdate {
  action: MemoryActionType;
  delta: number;
  direction: "increase" | "decrease" | "hold";
  confidence: "low" | "medium" | "high";
  notes: string[];
}

export interface CompressionGuidelineCandidate {
  generatedAt: string;
  sourceWindow: {
    from: string;
    to: string;
  };
  eventCounts: CompressionGuidelineOptimizerEventCounts;
  actionSummaries: CompressionOptimizerActionSummary[];
  ruleUpdates: CompressionOptimizerRuleUpdate[];
  guidelineVersion: number;
  optimizerVersion: number;
}

const MAX_DELTA = 0.15;
const SPARSE_SAMPLE = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseRecallQuality(reason: string | undefined): "good" | "poor" | "unknown" {
  if (!reason) return "unknown";
  const text = reason.toLowerCase();
  if (/(recall[_\s-]?good|quality[:=]\s*(good|high)|improv(ed|e)|resolved)/i.test(text)) {
    return "good";
  }
  if (/(recall[_\s-]?poor|quality[:=]\s*(poor|low)|degrad(ed|e)|miss(ed|ing)|irrelevant)/i.test(text)) {
    return "poor";
  }
  return "unknown";
}

function nextGuidelineVersion(previousState: CompressionGuidelineOptimizerState | null): number {
  if (!previousState) return 1;
  return Math.max(1, previousState.guidelineVersion + 1);
}

function nextOptimizerVersion(previousState: CompressionGuidelineOptimizerState | null): number {
  if (!previousState) return 1;
  return Math.max(1, previousState.version + 1);
}

function roundDelta(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function computeCompressionGuidelineCandidate(
  events: MemoryActionEvent[],
  options: {
    generatedAtIso?: string;
    previousState?: CompressionGuidelineOptimizerState | null;
  } = {},
): CompressionGuidelineCandidate {
  const generatedAt = options.generatedAtIso ?? new Date().toISOString();
  const previousState = options.previousState ?? null;
  const totalCounts: CompressionGuidelineOptimizerEventCounts = {
    total: events.length,
    applied: 0,
    skipped: 0,
    failed: 0,
  };

  const actionMap = new Map<MemoryActionType, CompressionOptimizerActionSummary>();
  let windowFrom = events[0]?.timestamp ?? generatedAt;
  let windowTo = events[0]?.timestamp ?? generatedAt;

  for (const event of events) {
    if (event.timestamp < windowFrom) windowFrom = event.timestamp;
    if (event.timestamp > windowTo) windowTo = event.timestamp;
    totalCounts[event.outcome] += 1;

    let summary = actionMap.get(event.action);
    if (!summary) {
      summary = {
        action: event.action,
        total: 0,
        outcomes: { applied: 0, skipped: 0, failed: 0 },
        quality: { good: 0, poor: 0, unknown: 0 },
      };
      actionMap.set(event.action, summary);
    }

    summary.total += 1;
    summary.outcomes[event.outcome] += 1;
    const quality = parseRecallQuality(event.reason);
    summary.quality[quality] += 1;
  }

  const actionSummaries = [...actionMap.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.action.localeCompare(b.action);
  });

  const ruleUpdates = actionSummaries.map((summary): CompressionOptimizerRuleUpdate => {
    const notes: string[] = [];
    if (summary.total < SPARSE_SAMPLE) {
      notes.push("Sparse sample size; holding baseline policy.");
      return {
        action: summary.action,
        delta: 0,
        direction: "hold",
        confidence: "low",
        notes,
      };
    }

    const successRate = summary.outcomes.applied / summary.total;
    const failureRate = summary.outcomes.failed / summary.total;
    const qualitySeen = summary.quality.good + summary.quality.poor;
    const qualitySignal = qualitySeen > 0
      ? (summary.quality.good - summary.quality.poor) / qualitySeen
      : 0;
    const rawDelta = clamp((successRate - failureRate) * 0.12 + qualitySignal * 0.06, -MAX_DELTA, MAX_DELTA);
    const delta = roundDelta(rawDelta);

    const direction = delta > 0 ? "increase" : delta < 0 ? "decrease" : "hold";
    if (direction === "decrease" && summary.outcomes.failed > summary.outcomes.applied) {
      notes.push("Failures exceed applied outcomes; conservative down-adjustment.");
    } else if (direction === "increase" && summary.quality.good > summary.quality.poor) {
      notes.push("Good recall quality markers support this action.");
    } else if (direction === "decrease" && summary.quality.poor > summary.quality.good) {
      notes.push("Poor recall quality markers exceed good markers.");
    } else {
      notes.push("Outcomes are stable; keep bounded adjustments.");
    }

    const magnitude = Math.abs(delta);
    const confidence = magnitude >= 0.09 ? "high" : magnitude >= 0.04 ? "medium" : "low";
    return {
      action: summary.action,
      delta,
      direction,
      confidence,
      notes,
    };
  });

  return {
    generatedAt,
    sourceWindow: {
      from: events.length > 0 ? windowFrom : generatedAt,
      to: events.length > 0 ? windowTo : generatedAt,
    },
    eventCounts: totalCounts,
    actionSummaries,
    ruleUpdates,
    guidelineVersion: nextGuidelineVersion(previousState),
    optimizerVersion: nextOptimizerVersion(previousState),
  };
}

export function buildCompressionGuidelinesMarkdown(
  events: MemoryActionEvent[],
  generatedAtIso: string = new Date().toISOString(),
  previousState: CompressionGuidelineOptimizerState | null = null,
): string {
  const candidate = computeCompressionGuidelineCandidate(events, {
    generatedAtIso,
    previousState,
  });

  const actionLines =
    candidate.actionSummaries.length === 0
      ? ["- (none)"]
      : candidate.actionSummaries.map((item) => `- ${item.action}: ${item.total}`);
  const outcomeLines: string[] = [
    `- applied: ${candidate.eventCounts.applied}`,
    `- skipped: ${candidate.eventCounts.skipped}`,
    `- failed: ${candidate.eventCounts.failed}`,
  ];
  const updateLines =
    candidate.ruleUpdates.length === 0
      ? ["- No telemetry events available yet. Keep defaults conservative and gather action data first."]
      : candidate.ruleUpdates.map((update) => {
          const sign = update.delta > 0 ? "+" : "";
          return `- ${update.action}: ${update.direction} (${sign}${update.delta.toFixed(3)}, confidence=${update.confidence}) — ${update.notes.join(" ")}`;
        });

  return [
    "# Compression Guidelines",
    "",
    `Generated: ${candidate.generatedAt}`,
    `Source events analyzed: ${candidate.eventCounts.total}`,
    `Source window: ${candidate.sourceWindow.from} -> ${candidate.sourceWindow.to}`,
    `Guideline version: ${candidate.guidelineVersion}`,
    "",
    "## Action Distribution",
    ...actionLines,
    "",
    "## Outcome Distribution",
    ...outcomeLines,
    "",
    "## Suggested Guidelines",
    ...updateLines,
    "",
  ].join("\n");
}
