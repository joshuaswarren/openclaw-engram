import type { MemoryIntent, RecallPlanMode } from "./types.js";

const GOAL_PATTERNS: Array<{ re: RegExp; goal: string }> = [
  { re: /\b(debug|fix|error|incident|outage|failure)\b/i, goal: "stabilize" },
  { re: /\b(deploy|release|ship|publish)\b/i, goal: "release" },
  { re: /\b(plan|roadmap|strategy|design)\b/i, goal: "plan" },
  { re: /\b(review|audit|security|hardening)\b/i, goal: "review" },
  { re: /\b(sales|deal|customer|client|prospect)\b/i, goal: "close_deal" },
];

const ACTION_PATTERNS: Array<{ re: RegExp; action: string }> = [
  { re: /\b(review|audit|inspect|check)\b/i, action: "review" },
  { re: /\b(plan|design|brainstorm|spec)\b/i, action: "plan" },
  { re: /\b(implement|build|code|patch|fix)\b/i, action: "execute" },
  { re: /\b(summarize|recap|what happened|timeline)\b/i, action: "summarize" },
  { re: /\b(decide|decision|choose)\b/i, action: "decide" },
];

const ENTITY_PATTERNS: Array<{ re: RegExp; entityType: string }> = [
  { re: /\b(pr|pull request|branch|repo|github|ci|workflow)\b/i, entityType: "repo" },
  { re: /\b(discord|slack|channel|gateway|agent)\b/i, entityType: "ops" },
  { re: /\b(customer|client|deal|lead|account)\b/i, entityType: "client" },
  { re: /\b(model|llm|qmd|embedding|retrieval|memory)\b/i, entityType: "ai" },
  { re: /\b(doc|readme|docs|changelog)\b/i, entityType: "docs" },
];

export function inferIntentFromText(text: string): MemoryIntent {
  const goal = GOAL_PATTERNS.find((p) => p.re.test(text))?.goal ?? "unknown";
  const actionType = ACTION_PATTERNS.find((p) => p.re.test(text))?.action ?? "unknown";
  const entityTypes = Array.from(
    new Set(ENTITY_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.entityType)),
  );

  return {
    goal,
    actionType,
    entityTypes,
  };
}

export function intentCompatibilityScore(queryIntent: MemoryIntent, memoryIntent: MemoryIntent): number {
  const queryHasSignal =
    queryIntent.goal !== "unknown" ||
    queryIntent.actionType !== "unknown" ||
    queryIntent.entityTypes.length > 0;
  const memoryHasSignal =
    memoryIntent.goal !== "unknown" ||
    memoryIntent.actionType !== "unknown" ||
    memoryIntent.entityTypes.length > 0;
  if (!queryHasSignal || !memoryHasSignal) return 0;

  let score = 0;
  if (
    queryIntent.goal !== "unknown" &&
    memoryIntent.goal !== "unknown" &&
    queryIntent.goal === memoryIntent.goal
  ) {
    score += 0.5;
  }
  if (
    queryIntent.actionType !== "unknown" &&
    memoryIntent.actionType !== "unknown" &&
    queryIntent.actionType === memoryIntent.actionType
  ) {
    score += 0.3;
  }

  const overlap = queryIntent.entityTypes.filter((et) => memoryIntent.entityTypes.includes(et)).length;
  if (overlap > 0) {
    const denom = Math.max(queryIntent.entityTypes.length, memoryIntent.entityTypes.length, 1);
    score += 0.2 * (overlap / denom);
  }

  return Math.max(0, Math.min(1, score));
}

export function planRecallMode(prompt: string): RecallPlanMode {
  const p = prompt.trim();
  if (p.length === 0) return "no_recall";

  if (/\b(timeline|sequence|history|what happened|chain of events|root cause)\b/i.test(p)) {
    return "graph_mode";
  }

  if (/\b(previous|earlier|remember|last time|did we|what did we decide|context)\b/i.test(p)) {
    return "full";
  }

  // Reserve no_recall for low-information acknowledgements; avoid broad regressions.
  if (
    p.length <= 18 &&
    /^(ok|okay|kk|thanks|thx|got it|sounds good|yep|yes|nope|no|done|cool|works)$/i.test(p)
  ) {
    return "no_recall";
  }

  return "minimal";
}
