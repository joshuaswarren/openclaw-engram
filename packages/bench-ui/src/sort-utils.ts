const metricPriority = [
  "score",
  "accuracy",
  "f1",
  "exact_match",
  "llm_judge",
  "semantic_similarity",
  "precision",
  "recall",
];

export function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

export function compareMetricNames(left: string, right: string): number {
  const leftIndex = metricPriority.indexOf(left);
  const rightIndex = metricPriority.indexOf(right);

  if (leftIndex !== rightIndex) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  }

  return compareStrings(left, right);
}
