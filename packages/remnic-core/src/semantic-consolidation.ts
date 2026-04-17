/**
 * semantic-consolidation.ts — Semantic Consolidation Engine
 *
 * Finds clusters of semantically similar memories using token overlap,
 * synthesizes canonical versions via LLM, and archives the originals.
 * Reduces memory store bloat while preserving all unique information.
 */

import type { MemoryFile, PluginConfig } from "./types.js";
import { normalizeRecallTokens, countRecallTokenOverlap } from "./recall-tokenization.js";
import { runPostConsolidationMaterialize } from "./connectors/codex-materialize-runner.js";
import type { MaterializeResult, RolloutSummaryInput } from "./connectors/codex-materialize.js";
import { discoverMemoryExtensions, renderExtensionsBlock } from "./memory-extension-host/index.js";
import { log } from "./logger.js";
import { resolveExtensionsRoot } from "./config.js";

export interface ConsolidationCluster {
  category: string;
  memories: MemoryFile[];
  overlapScore: number;
  canonicalContent?: string;
}

export interface SemanticConsolidationResult {
  clustersFound: number;
  memoriesConsolidated: number;
  memoriesArchived: number;
  errors: number;
  clusters: ConsolidationCluster[];
}

/**
 * Find clusters of semantically similar memories using token overlap.
 */
export function findSimilarClusters(
  memories: MemoryFile[],
  config: {
    threshold: number;
    minClusterSize: number;
    excludeCategories: string[];
    maxPerRun: number;
  },
): ConsolidationCluster[] {
  const excluded = new Set(config.excludeCategories);

  // Group by category first
  const byCategory = new Map<string, MemoryFile[]>();
  for (const m of memories) {
    const cat = m.frontmatter.category;
    if (excluded.has(cat)) continue;
    if (m.frontmatter.status && m.frontmatter.status !== "active") continue;
    const list = byCategory.get(cat) ?? [];
    list.push(m);
    byCategory.set(cat, list);
  }

  const clusters: ConsolidationCluster[] = [];
  let totalCandidates = 0;

  for (const [category, mems] of byCategory) {
    if (totalCandidates >= config.maxPerRun) break;

    // Token-normalize all memories in this category
    const tokenized = mems.map((m) => ({
      memory: m,
      tokens: new Set(normalizeRecallTokens(m.content, [])),
    }));

    // Track which memories are already clustered
    const clustered = new Set<string>();

    for (let i = 0; i < tokenized.length && totalCandidates < config.maxPerRun; i++) {
      if (clustered.has(tokenized[i].memory.frontmatter.id)) continue;

      const cluster: MemoryFile[] = [tokenized[i].memory];
      let totalOverlap = 0;
      let comparisons = 0;

      for (let j = i + 1; j < tokenized.length; j++) {
        if (clustered.has(tokenized[j].memory.frontmatter.id)) continue;

        const aTokens = tokenized[i].tokens;
        const bTokens = tokenized[j].tokens;
        if (aTokens.size === 0 || bTokens.size === 0) continue;

        // Bidirectional overlap: what fraction of tokens are shared
        const overlap = countRecallTokenOverlap(aTokens, [...bTokens].join(" "));
        const maxTokens = Math.max(aTokens.size, bTokens.size);
        const score = maxTokens > 0 ? overlap / maxTokens : 0;

        if (score >= config.threshold) {
          cluster.push(tokenized[j].memory);
          totalOverlap += score;
          comparisons++;
          // Enforce maxPerRun within a single cluster
          if (totalCandidates + cluster.length >= config.maxPerRun) break;
        }
      }

      if (cluster.length >= config.minClusterSize) {
        for (const m of cluster) clustered.add(m.frontmatter.id);
        clusters.push({
          category,
          memories: cluster,
          overlapScore: comparisons > 0 ? totalOverlap / comparisons : 0,
        });
        totalCandidates += cluster.length;
      }
    }
  }

  return clusters;
}

/**
 * Build the LLM prompt for synthesizing a canonical memory from a cluster.
 */
export function buildConsolidationPrompt(cluster: ConsolidationCluster): string {
  const memoryTexts = cluster.memories
    .map(
      (m, i) =>
        `Memory ${i + 1} (${m.frontmatter.id}, created ${m.frontmatter.created}):\n${m.content}`,
    )
    .join("\n\n");

  return `You are a memory consolidation system. The following ${cluster.memories.length} memories in the "${cluster.category}" category contain overlapping information.

Synthesize them into ONE canonical memory that:
1. Preserves ALL unique information from every source memory
2. Removes redundancy and repetition
3. Uses clear, concise language
4. Maintains the same category and tone
5. Does NOT add information that isn't in the sources

${memoryTexts}

Write ONLY the consolidated memory content (no metadata, no explanation, no preamble):`;
}

/**
 * Parse the LLM response to extract the canonical content.
 */
export function parseConsolidationResponse(response: string): string {
  return response.trim();
}

// Re-export resolveExtensionsRoot from its canonical location (config.ts) so
// existing imports from this module continue to work without breaking changes.
// The local import (above) is used by buildExtensionsBlockForConsolidation.
export { resolveExtensionsRoot };

/**
 * Discover extensions and build the block to append to a consolidation prompt.
 * Returns "" when extensions are disabled or none are found.
 */
export async function buildExtensionsBlockForConsolidation(
  config: PluginConfig,
): Promise<string> {
  if (!config.memoryExtensionsEnabled) return "";
  const root = resolveExtensionsRoot(config);
  const extensions = await discoverMemoryExtensions(root, log);
  if (extensions.length === 0) return "";
  return renderExtensionsBlock(extensions);
}

/**
 * Optional post-consolidation hook — materializes the namespace into Codex's
 * native memory layout when the consolidation run finishes. Kept here (rather
 * than in orchestrator.ts) so #378 doesn't conflict with Wave 1 edits.
 *
 * Safe to call regardless of config state: honors `codexMaterializeMemories`
 * and `codexMaterializeOnConsolidation` and silently becomes a no-op when
 * either is disabled.
 */
export async function materializeAfterSemanticConsolidation(options: {
  config: PluginConfig;
  namespace?: string;
  memories?: MemoryFile[];
  memoryDir?: string;
  codexHome?: string;
  rolloutSummaries?: RolloutSummaryInput[];
  now?: Date;
}): Promise<MaterializeResult | null> {
  // Delegates to the shared post-consolidation helper so semantic and causal
  // flows stay in lock-step — any guard/logging change happens in one place.
  return runPostConsolidationMaterialize("[semantic-consolidation]", options);
}
