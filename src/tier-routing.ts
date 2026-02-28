import type { MemoryFile } from "./types.js";
import { computeLifecycleValueInputs, type LifecycleSignals } from "./lifecycle.js";

export type MemoryTier = "hot" | "cold";

export interface TierRoutingPolicy {
  enabled: boolean;
  demotionMinAgeDays: number;
  demotionValueThreshold: number;
  promotionValueThreshold: number;
}

export interface TierTransitionDecision {
  currentTier: MemoryTier;
  nextTier: MemoryTier;
  valueScore: number;
  changed: boolean;
  reason: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function daysSince(iso: string | undefined, nowMs: number): number {
  if (!iso) return 365;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 365;
  return Math.max(0, (nowMs - ts) / 86_400_000);
}

export function computeTierValueScore(
  memory: Pick<MemoryFile, "frontmatter">,
  now: Date,
  signals?: LifecycleSignals,
): number {
  const fm = memory.frontmatter;
  const inputs = computeLifecycleValueInputs(memory, now, signals);
  const correctionBoost = fm.category === "correction" ? 0.08 : 0;
  const confirmedBoost = fm.verificationState === "user_confirmed" ? 0.05 : 0;

  const score = (inputs.confidence * 0.24)
    + (inputs.access * 0.26)
    + (inputs.recency * 0.2)
    + (inputs.importance * 0.2)
    + (inputs.feedback * 0.1)
    + correctionBoost
    + confirmedBoost
    - (inputs.disputedPenalty * 0.5);

  return clamp01(score);
}

export function decideTierTransition(
  memory: Pick<MemoryFile, "frontmatter">,
  currentTier: MemoryTier,
  policy: TierRoutingPolicy,
  now: Date,
  signals?: LifecycleSignals,
): TierTransitionDecision {
  const valueScore = computeTierValueScore(memory, now, signals);
  if (!policy.enabled) {
    return {
      currentTier,
      nextTier: currentTier,
      valueScore,
      changed: false,
      reason: "tier_migration_disabled",
    };
  }

  if (currentTier === "hot") {
    const ageDays = daysSince(memory.frontmatter.updated ?? memory.frontmatter.created, now.getTime());
    if (ageDays >= policy.demotionMinAgeDays && valueScore <= policy.demotionValueThreshold) {
      return {
        currentTier,
        nextTier: "cold",
        valueScore,
        changed: true,
        reason: "value_below_demotion_threshold",
      };
    }
    return {
      currentTier,
      nextTier: currentTier,
      valueScore,
      changed: false,
      reason: ageDays < policy.demotionMinAgeDays ? "demotion_min_age_not_met" : "value_above_demotion_threshold",
    };
  }

  if (valueScore >= policy.promotionValueThreshold) {
    return {
      currentTier,
      nextTier: "hot",
      valueScore,
      changed: true,
      reason: "value_above_promotion_threshold",
    };
  }
  return {
    currentTier,
    nextTier: currentTier,
    valueScore,
    changed: false,
    reason: "value_below_promotion_threshold",
  };
}
