/**
 * Memory reconstruction (E-Mem-inspired).
 *
 * Scans recalled memories for entity references that lack context
 * in the recall set, then identifies candidates for targeted retrieval.
 */

/**
 * Find entity names mentioned in recalled snippets that are known entities
 * but not represented in the recalled entity refs.
 */
export function findUnresolvedEntityRefs(
  recalledSnippets: string[],
  recalledEntityRefs: string[],
  knownEntities: string[],
): string[] {
  const refSet = new Set(recalledEntityRefs.map((r) => r.toLowerCase()));
  const combinedText = recalledSnippets.join(" ").toLowerCase();

  const unresolved: string[] = [];
  for (const entity of knownEntities) {
    const lower = entity.toLowerCase();
    if (refSet.has(lower)) continue; // already covered
    if (combinedText.includes(lower)) {
      unresolved.push(entity);
    }
  }
  return unresolved;
}
