import path from "node:path";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import { throwIfAborted } from "./abort-error.js";
import {
  resolveAbstractionNodeStoreDir,
  validateAbstractionNode,
  type AbstractionNode,
} from "./abstraction-nodes.js";
import {
  resolveCueAnchorStoreDir,
  validateCueAnchor,
  type CueAnchor,
  type CueAnchorType,
} from "./cue-anchors.js";
import { countRecallTokenOverlap, normalizeRecallTokens } from "./recall-tokenization.js";

export interface HarmonicMatchedAnchor {
  anchorId: string;
  anchorType: CueAnchorType;
  anchorValue: string;
}

export interface HarmonicRetrievalResult {
  node: AbstractionNode;
  score: number;
  nodeScore: number;
  anchorScore: number;
  matchedFields: string[];
  matchedAnchors: HarmonicMatchedAnchor[];
}

interface HarmonicCandidate {
  node: AbstractionNode;
  nodeScore: number;
  anchorScore: number;
  matchedFields: Set<string>;
  matchedAnchors: Map<string, HarmonicMatchedAnchor>;
}

function scoreNode(node: AbstractionNode, queryTokens: Set<string>): { score: number; matchedFields: string[] } {
  const matchedFields: string[] = [];
  let score = 0;

  const titleMatches = countRecallTokenOverlap(queryTokens, node.title);
  if (titleMatches > 0) {
    score += titleMatches * 3;
    matchedFields.push("title");
  }

  const summaryMatches = countRecallTokenOverlap(queryTokens, node.summary);
  if (summaryMatches > 0) {
    score += summaryMatches * 3;
    matchedFields.push("summary");
  }

  const tagMatches = countRecallTokenOverlap(queryTokens, node.tags?.join(" "));
  if (tagMatches > 0) {
    score += tagMatches * 2;
    matchedFields.push("tags");
  }

  const entityMatches = countRecallTokenOverlap(queryTokens, node.entityRefs?.join(" "));
  if (entityMatches > 0) {
    score += entityMatches * 2;
    matchedFields.push("entityRefs");
  }

  const kindMatches = countRecallTokenOverlap(queryTokens, `${node.kind} ${node.abstractionLevel}`);
  if (kindMatches > 0) {
    score += kindMatches;
    matchedFields.push("kind");
  }

  return { score, matchedFields };
}

function scoreAnchor(anchor: CueAnchor, queryTokens: Set<string>): { score: number; matchedFields: string[] } {
  const matchedFields: string[] = [];
  let score = 0;

  const valueMatches = countRecallTokenOverlap(queryTokens, anchor.anchorValue);
  const normalizedMatches = countRecallTokenOverlap(queryTokens, anchor.normalizedCue);
  const cueMatches = Math.max(valueMatches, normalizedMatches);
  if (cueMatches > 0) {
    score += cueMatches * 4;
    if (valueMatches > 0) matchedFields.push("anchorValue");
    if (normalizedMatches > 0) matchedFields.push("anchor");
  }

  const typeMatches = countRecallTokenOverlap(queryTokens, anchor.anchorType);
  if (typeMatches > 0) {
    score += typeMatches;
    matchedFields.push("anchorType");
  }

  const tagMatches = countRecallTokenOverlap(queryTokens, anchor.tags?.join(" "));
  if (tagMatches > 0) {
    score += tagMatches * 2;
    matchedFields.push("anchorTags");
  }

  return { score, matchedFields };
}

async function readAbstractionNodes(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
}): Promise<AbstractionNode[]> {
  const rootDir = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const files = await listJsonFiles(path.join(rootDir, "nodes"));
  const nodes: AbstractionNode[] = [];
  for (const filePath of files) {
    try {
      nodes.push(validateAbstractionNode(await readJsonFile(filePath)));
    } catch {
      // fail-open: invalid artifacts stay visible via status tooling instead of recall
    }
  }
  return nodes;
}

async function readCueAnchors(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
}): Promise<CueAnchor[]> {
  const abstractionRoot = resolveAbstractionNodeStoreDir(options.memoryDir, options.abstractionNodeStoreDir);
  const rootDir = resolveCueAnchorStoreDir(abstractionRoot);
  const files = await listJsonFiles(rootDir);
  const anchors: CueAnchor[] = [];
  for (const filePath of files) {
    try {
      anchors.push(validateCueAnchor(await readJsonFile(filePath)));
    } catch {
      // fail-open: invalid artifacts stay visible via status tooling instead of recall
    }
  }
  return anchors;
}

export async function searchHarmonicRetrieval(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  query: string;
  maxResults: number;
  sessionKey?: string;
  anchorsEnabled: boolean;
  abortSignal?: AbortSignal;
}): Promise<HarmonicRetrievalResult[]> {
  throwIfAborted(options.abortSignal);
  const queryTokens = new Set(normalizeRecallTokens(options.query, ["what", "which"]));
  if (queryTokens.size === 0 || options.maxResults <= 0) return [];

  const nodes = await readAbstractionNodes(options);
  const candidates = new Map<string, HarmonicCandidate>();

  for (const node of nodes) {
    throwIfAborted(options.abortSignal);
    const { score, matchedFields } = scoreNode(node, queryTokens);
    if (score <= 0) continue;
    candidates.set(node.nodeId, {
      node,
      nodeScore: score,
      anchorScore: 0,
      matchedFields: new Set(matchedFields),
      matchedAnchors: new Map(),
    });
  }

  if (options.anchorsEnabled) {
    throwIfAborted(options.abortSignal);
    const anchors = await readCueAnchors(options);
    const nodeIndex = new Map(nodes.map((node) => [node.nodeId, node]));
    for (const anchor of anchors) {
      throwIfAborted(options.abortSignal);
      const { score, matchedFields } = scoreAnchor(anchor, queryTokens);
      if (score <= 0) continue;
      for (const nodeRef of anchor.nodeRefs) {
        const node = nodeIndex.get(nodeRef);
        if (!node) continue;
        const existing = candidates.get(nodeRef) ?? {
          node,
          nodeScore: 0,
          anchorScore: 0,
          matchedFields: new Set<string>(),
          matchedAnchors: new Map<string, HarmonicMatchedAnchor>(),
        };
        existing.anchorScore += score;
        existing.matchedFields.add("anchor");
        for (const field of matchedFields) existing.matchedFields.add(field);
        existing.matchedAnchors.set(anchor.anchorId, {
          anchorId: anchor.anchorId,
          anchorType: anchor.anchorType,
          anchorValue: anchor.anchorValue,
        });
        candidates.set(nodeRef, existing);
      }
    }
  }

  return [...candidates.values()]
    .map((candidate) => {
      let score = candidate.nodeScore + candidate.anchorScore;
      if (options.sessionKey && candidate.node.sessionKey === options.sessionKey) score += 0.5;
      return {
        node: candidate.node,
        score,
        nodeScore: candidate.nodeScore,
        anchorScore: candidate.anchorScore,
        matchedFields: [...candidate.matchedFields].sort(),
        matchedAnchors: [...candidate.matchedAnchors.values()].sort((left, right) =>
          left.anchorType.localeCompare(right.anchorType) || left.anchorValue.localeCompare(right.anchorValue)
        ),
      };
    })
    .filter((result) => result.nodeScore > 0 || result.anchorScore > 0)
    .sort(
      (left, right) =>
        right.score - left.score
        || right.anchorScore - left.anchorScore
        || right.node.recordedAt.localeCompare(left.node.recordedAt),
    )
    .slice(0, options.maxResults);
}

