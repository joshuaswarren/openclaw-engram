import type { AggregateMetrics } from "../../types.js";

export function overlapCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of right) {
    if (left.has(token)) count += 1;
  }
  return count;
}

export function prefixAggregates(
  prefix: string,
  aggregates: AggregateMetrics,
): AggregateMetrics {
  const prefixed: AggregateMetrics = {};

  for (const [metric, aggregate] of Object.entries(aggregates)) {
    prefixed[`${prefix}.${metric}`] = aggregate;
  }

  return prefixed;
}

export function pairIdFromTaskId(taskId: string): string {
  return taskId.replace(/^(clean|dirty):/, "");
}
