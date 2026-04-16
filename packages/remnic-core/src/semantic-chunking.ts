/**
 * Semantic Chunking with Smoothing-Based Topic Boundaries (Issue #368)
 *
 * An optional alternative to the recursive chunker in chunking.ts.
 * Uses sentence embeddings + cosine similarity + smoothing to detect
 * natural topic boundaries, producing more coherent chunks.
 */

import { chunkContent, type Chunk, type ChunkResult } from "./chunking.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SemanticChunkingConfig {
  /** Whether semantic chunking is enabled. Default: false. */
  enabled: boolean;
  /** Target tokens per chunk. Default: 200. */
  targetTokens: number;
  /** Minimum tokens for a segment before merging with neighbor. Default: 100. */
  minTokens: number;
  /** Maximum tokens for a segment before recursive splitting. Default: 400. */
  maxTokens: number;
  /** Window size for the moving-average smoothing filter. Default: 3. */
  smoothingWindowSize: number;
  /** How many standard deviations below the mean constitutes a boundary. Default: 1.0. */
  boundaryThresholdStdDevs: number;
  /** Batch size for embedding requests. Default: 32. */
  embeddingBatchSize: number;
  /** Fall back to recursive chunking when embeddings are unavailable. Default: true. */
  fallbackToRecursive: boolean;
}

export const DEFAULT_SEMANTIC_CHUNKING_CONFIG: SemanticChunkingConfig = {
  enabled: false,
  targetTokens: 200,
  minTokens: 100,
  maxTokens: 400,
  smoothingWindowSize: 3,
  boundaryThresholdStdDevs: 1.0,
  embeddingBatchSize: 32,
  fallbackToRecursive: true,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SemanticChunk extends Chunk {
  /** Optional topic hint derived from position. */
  topicLabel?: string;
  /** Cosine similarity score at the trailing boundary of this chunk. */
  boundaryScore: number;
}

export interface SemanticChunkResult {
  /** Whether content was split into multiple chunks. */
  chunked: boolean;
  /** The chunks produced. */
  chunks: SemanticChunk[];
  /** Sentence indices where topic splits occurred. */
  boundaries: number[];
  /** Which algorithm produced the result. */
  method: "semantic" | "recursive-fallback";
}

// ---------------------------------------------------------------------------
// Embedding function signature
// ---------------------------------------------------------------------------

/** Caller-provided function that embeds an array of texts, returning vectors. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

// ---------------------------------------------------------------------------
// Math utilities (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two vectors.
 * Returns a value in [-1, 1]. Identical direction = 1, orthogonal = 0.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`,
    );
  }
  if (a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Arithmetic mean of a numeric series.
 */
export function mean(series: number[]): number {
  if (series.length === 0) return 0;
  let sum = 0;
  for (const v of series) sum += v;
  return sum / series.length;
}

/**
 * Population standard deviation of a numeric series.
 */
export function stddev(series: number[]): number {
  if (series.length === 0) return 0;
  const m = mean(series);
  let sumSq = 0;
  for (const v of series) {
    const d = v - m;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / series.length);
}

/**
 * Simple moving average over a 1D series.
 * The window is centered: for window size W, each output[i] averages
 * series[i - floor(W/2) .. i + floor(W/2)], clamped to bounds.
 */
export function movingAverage(series: number[], windowSize: number): number[] {
  if (series.length === 0) return [];
  if (windowSize < 1) windowSize = 1;

  const halfW = Math.floor(windowSize / 2);
  const result: number[] = new Array(series.length);

  for (let i = 0; i < series.length; i++) {
    const lo = Math.max(0, i - halfW);
    const hi = Math.min(series.length - 1, i + halfW);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += series[j];
    result[i] = sum / (hi - lo + 1);
  }
  return result;
}

/**
 * Find indices in the series that are local minima AND below the threshold.
 * A local minimum is a point lower than both its immediate neighbors
 * (or lower-or-equal at series boundaries).
 */
export function findLocalMinima(
  series: number[],
  threshold: number,
): number[] {
  if (series.length <= 2) return [];

  const minima: number[] = [];
  for (let i = 1; i < series.length - 1; i++) {
    if (
      series[i] < series[i - 1] &&
      series[i] < series[i + 1] &&
      series[i] < threshold
    ) {
      minima.push(i);
    }
  }
  return minima;
}

// ---------------------------------------------------------------------------
// Sentence tokenizer
// ---------------------------------------------------------------------------

/**
 * Split text into sentences at punctuation boundaries.
 * Preserves punctuation with the preceding sentence.
 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const sentenceRegex = /[^.!?]*[.!?]+(?:\s+|$)/g;

  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = sentenceRegex.exec(text)) !== null) {
    sentences.push(match[0].trim());
    lastIndex = sentenceRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
      sentences.push(remaining);
    }
  }

  return sentences.filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 chars per token for English. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Core semantic chunking
// ---------------------------------------------------------------------------

/**
 * Batch-embed sentences using the provided embed function.
 * Respects the configured batch size.
 */
async function batchEmbed(
  sentences: string[],
  embedFn: EmbedFn,
  batchSize: number,
): Promise<number[][]> {
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < sentences.length; i += batchSize) {
    const batch = sentences.slice(i, i + batchSize);
    const batchResult = await embedFn(batch);
    for (const vec of batchResult) {
      allEmbeddings.push(vec);
    }
  }

  return allEmbeddings;
}

/**
 * Build segments from boundary indices.
 * boundaries are sentence indices at which splits occur (i.e., the split
 * happens AFTER the boundary index sentence).
 */
function buildSegments(
  sentences: string[],
  boundaries: number[],
): string[][] {
  const sorted = [...boundaries].sort((a, b) => a - b);
  const segments: string[][] = [];
  let start = 0;

  for (const b of sorted) {
    // Split after sentence at index b: segment is [start .. b]
    const splitPoint = b + 1;
    if (splitPoint > start && splitPoint <= sentences.length) {
      segments.push(sentences.slice(start, splitPoint));
      start = splitPoint;
    }
  }

  // Remaining sentences
  if (start < sentences.length) {
    segments.push(sentences.slice(start));
  }

  return segments;
}

/**
 * Merge short segments (below minTokens) with their neighbor.
 * Prefers merging forward; falls back to merging backward.
 */
function mergeShortSegments(
  segments: string[][],
  minTokens: number,
): string[][] {
  if (segments.length <= 1) return segments;

  const merged: string[][] = [];
  let buffer: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    buffer = [...buffer, ...segments[i]];
    const tokenCount = estimateTokens(buffer.join(" "));

    if (tokenCount >= minTokens || i === segments.length - 1) {
      merged.push(buffer);
      buffer = [];
    }
  }

  // If the last merge left a dangling buffer, attach it to the last segment
  if (buffer.length > 0) {
    if (merged.length > 0) {
      merged[merged.length - 1] = [...merged[merged.length - 1], ...buffer];
    } else {
      merged.push(buffer);
    }
  }

  return merged;
}

/**
 * Split an oversized segment using recursive chunking.
 */
function splitLongSegment(
  segment: string[],
  maxTokens: number,
  targetTokens: number,
): SemanticChunk[] {
  const text = segment.join(" ");
  const result: ChunkResult = chunkContent(text, {
    targetTokens,
    minTokens: Math.min(targetTokens, maxTokens),
    overlapSentences: 0,
  });

  return result.chunks.map((c) => ({
    content: c.content,
    index: c.index,
    tokenCount: c.tokenCount,
    boundaryScore: 0,
  }));
}

/**
 * Semantic chunking with smoothing-based topic boundary detection.
 *
 * @param content   - Full text to chunk.
 * @param embedFn   - Async function that embeds an array of texts.
 * @param config    - Optional partial config overrides.
 * @returns SemanticChunkResult
 */
export async function semanticChunkContent(
  content: string,
  embedFn: EmbedFn,
  config?: Partial<SemanticChunkingConfig>,
): Promise<SemanticChunkResult> {
  const cfg: SemanticChunkingConfig = {
    ...DEFAULT_SEMANTIC_CHUNKING_CONFIG,
    ...config,
  };

  // --- Empty / trivially short input ---
  if (!content || content.trim().length === 0) {
    return {
      chunked: false,
      chunks: [],
      boundaries: [],
      method: "semantic",
    };
  }

  const sentences = splitSentences(content);

  if (sentences.length <= 1) {
    const tokenCount = estimateTokens(content);
    return {
      chunked: false,
      chunks: [
        {
          content: content.trim(),
          index: 0,
          tokenCount,
          boundaryScore: 1,
        },
      ],
      boundaries: [],
      method: "semantic",
    };
  }

  // If total tokens is short enough, return as single chunk
  const totalTokens = estimateTokens(content);
  if (totalTokens <= cfg.minTokens) {
    return {
      chunked: false,
      chunks: [
        {
          content: content.trim(),
          index: 0,
          tokenCount: totalTokens,
          boundaryScore: 1,
        },
      ],
      boundaries: [],
      method: "semantic",
    };
  }

  // --- Attempt embedding ---
  let embeddings: number[][];
  try {
    embeddings = await batchEmbed(sentences, embedFn, cfg.embeddingBatchSize);
  } catch {
    // Embedding failed — fall back if configured
    if (cfg.fallbackToRecursive) {
      return buildRecursiveFallback(content, cfg);
    }
    throw new Error(
      "Semantic chunking failed: embedding function threw and fallbackToRecursive is disabled",
    );
  }

  if (embeddings.length !== sentences.length) {
    if (cfg.fallbackToRecursive) {
      return buildRecursiveFallback(content, cfg);
    }
    throw new Error(
      `Semantic chunking failed: expected ${sentences.length} embeddings but received ${embeddings.length}`,
    );
  }

  // --- Compute pairwise cosine similarity ---
  const similarities: number[] = [];
  for (let i = 0; i < sentences.length - 1; i++) {
    similarities.push(cosineSimilarity(embeddings[i], embeddings[i + 1]));
  }

  // If only one pair (2 sentences), nothing to smooth or split meaningfully
  if (similarities.length <= 1) {
    return {
      chunked: false,
      chunks: [
        {
          content: content.trim(),
          index: 0,
          tokenCount: totalTokens,
          boundaryScore: similarities.length === 1 ? similarities[0] : 1,
        },
      ],
      boundaries: [],
      method: "semantic",
    };
  }

  // --- Smooth the similarity series ---
  const smoothed = movingAverage(similarities, cfg.smoothingWindowSize);

  // --- Detect boundaries: local minima below (mean - k * stddev) ---
  const m = mean(smoothed);
  const s = stddev(smoothed);
  const threshold = m - cfg.boundaryThresholdStdDevs * s;
  const rawBoundaries = findLocalMinima(smoothed, threshold);

  // --- Build segments, merge short, split long ---
  let segments = buildSegments(sentences, rawBoundaries);
  segments = mergeShortSegments(segments, cfg.minTokens);

  // --- Convert segments to chunks, splitting oversized ones ---
  const chunks: SemanticChunk[] = [];
  const finalBoundaries: number[] = [];
  let sentenceOffset = 0;

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const segment = segments[segIdx];
    const segText = segment.join(" ");
    const segTokens = estimateTokens(segText);

    if (segTokens > cfg.maxTokens) {
      // Recursive split for oversized segment
      const subChunks = splitLongSegment(segment, cfg.maxTokens, cfg.targetTokens);
      for (const sc of subChunks) {
        chunks.push({
          ...sc,
          index: chunks.length,
        });
      }
    } else {
      // Compute boundary score: the similarity at the trailing edge
      const trailingSentenceIdx = sentenceOffset + segment.length - 1;
      let bScore = 1;
      if (
        trailingSentenceIdx < similarities.length &&
        segIdx < segments.length - 1
      ) {
        bScore = smoothed[trailingSentenceIdx] ?? similarities[trailingSentenceIdx] ?? 1;
      }

      chunks.push({
        content: segText,
        index: chunks.length,
        tokenCount: segTokens,
        boundaryScore: bScore,
      });
    }

    // Record boundaries (all but the last segment produce a boundary)
    if (segIdx < segments.length - 1) {
      finalBoundaries.push(sentenceOffset + segment.length - 1);
    }
    sentenceOffset += segment.length;
  }

  return {
    chunked: chunks.length > 1,
    chunks,
    boundaries: finalBoundaries,
    method: "semantic",
  };
}

// ---------------------------------------------------------------------------
// Recursive fallback helper
// ---------------------------------------------------------------------------

function buildRecursiveFallback(
  content: string,
  cfg: SemanticChunkingConfig,
): SemanticChunkResult {
  const result: ChunkResult = chunkContent(content, {
    targetTokens: cfg.targetTokens,
    minTokens: cfg.minTokens,
    overlapSentences: 0,
  });

  return {
    chunked: result.chunked,
    chunks: result.chunks.map((c) => ({
      ...c,
      boundaryScore: 0,
    })),
    boundaries: [],
    method: "recursive-fallback",
  };
}
