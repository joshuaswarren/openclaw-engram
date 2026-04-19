/**
 * Deterministic temporal retrieval benchmark over the schema-tier corpus.
 */

import { randomUUID } from "node:crypto";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import type { SchemaTierPage } from "../../../fixtures/schema-tiers/index.js";
import {
  buildTieredAggregates,
  overlapCount,
} from "../retrieval-shared.js";
import {
  RETRIEVAL_TEMPORAL_FIXTURE,
  RETRIEVAL_TEMPORAL_SMOKE_FIXTURE,
  type RetrievalTemporalCase,
} from "./fixture.js";

export const retrievalTemporalDefinition: BenchmarkDefinition = {
  id: "retrieval-temporal",
  title: "Retrieval Temporal",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "retrieval-temporal",
    version: "1.0.0",
    description:
      "Deterministic clean-vs-dirty retrieval benchmark for temporal qrels under half-open windows.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #448",
  },
};

export async function runRetrievalTemporalBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);
  const tasks: TaskResult[] = [];

  for (const sample of cases) {
    validateHalfOpenWindow(sample.window.start, sample.window.end);
    const startedAt = performance.now();
    const rankedPages = rankPages(sample.query, sample.pages);
    const latencyMs = Math.round(performance.now() - startedAt);
    const expectedJson = JSON.stringify({
      expectedPageIds: sample.expectedPageIds,
      window: sample.window,
    });
    const actualJson = JSON.stringify({
      retrievedPageIds: rankedPages.slice(0, 5).map((page) => page.id),
      matchingPageIds: matchingPageIds(rankedPages, sample),
    });

    tasks.push({
      taskId: sample.id,
      question: sample.title,
      expected: expectedJson,
      actual: actualJson,
      scores: {
        qrel_at_1: temporalQrelAtK(rankedPages, sample, 1),
        qrel_at_3: temporalQrelAtK(rankedPages, sample, 3),
        qrel_at_5: temporalQrelAtK(rankedPages, sample, 5),
      },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: {
        tier: sample.tier,
        window: sample.window,
        retrievedPageIds: rankedPages.slice(0, 5).map((page) => page.id),
        matchingPageIds: matchingPageIds(rankedPages, sample),
      },
    });
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);

  return {
    meta: {
      id: randomUUID(),
      benchmark: options.benchmark.id,
      benchmarkTier: options.benchmark.tier,
      version: options.benchmark.meta.version,
      remnicVersion,
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: options.mode,
      runCount: 1,
      seeds: [options.seed ?? 0],
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "direct",
      remnicConfig: options.remnicConfig ?? {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: buildTieredAggregates(tasks),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

function loadCases(
  mode: "quick" | "full",
  limit?: number,
): RetrievalTemporalCase[] {
  const baseCases = mode === "quick"
    ? RETRIEVAL_TEMPORAL_SMOKE_FIXTURE
    : RETRIEVAL_TEMPORAL_FIXTURE;

  if (limit === undefined) {
    return baseCases;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("retrieval-temporal limit must be a positive integer");
  }

  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error("retrieval-temporal fixture is empty after applying the requested limit.");
  }
  return limited;
}

function rankPages(query: string, pages: SchemaTierPage[]): SchemaTierPage[] {
  return [...pages].sort((left, right) => {
    const scoreDelta = scorePage(query, right) - scorePage(query, left);
    if (scoreDelta !== 0) return scoreDelta;
    return left.id.localeCompare(right.id);
  });
}

function scorePage(query: string, page: SchemaTierPage): number {
  const queryTokens = tokenize(query);
  const ownerHit = queryTokens.has(page.owner.toLowerCase()) ? 3 : 0;
  const titleScore = overlapCount(queryTokens, tokenize(page.title)) * 4;
  const canonicalTitleScore = overlapCount(queryTokens, tokenize(page.canonicalTitle)) * 3;
  const aliasScore = overlapCount(queryTokens, tokenize(page.aliases.join(" "))) * 2;
  const bodyScore = overlapCount(queryTokens, tokenize(page.body)) * 2;
  const timelineScore = overlapCount(queryTokens, tokenize(page.timeline.join(" "))) * 1.5;

  return ownerHit + titleScore + canonicalTitleScore + aliasScore + bodyScore + timelineScore;
}

function temporalQrelAtK(
  rankedPages: SchemaTierPage[],
  sample: RetrievalTemporalCase,
  k: number,
): number {
  const topK = rankedPages.slice(0, k);
  return topK.some((page) => pageQualifies(page, sample)) ? 1 : 0;
}

function pageQualifies(page: SchemaTierPage, sample: RetrievalTemporalCase): boolean {
  if (!sample.expectedPageIds.includes(page.id)) return false;
  return pageHasTemporalEvidenceInWindow(page, sample.window.start, sample.window.end);
}

function pageHasTemporalEvidenceInWindow(
  page: SchemaTierPage,
  startIso: string,
  endIso: string,
): boolean {
  const { startMs, endMs } = validateHalfOpenWindow(startIso, endIso);

  const evidenceTimestamps = collectEvidenceTimestamps(page);
  return evidenceTimestamps.some((timestamp) => timestamp >= startMs && timestamp < endMs);
}

function validateHalfOpenWindow(
  startIso: string,
  endIso: string,
): { startMs: number; endMs: number } {
  const startMs = parseStrictIsoTimestamp(startIso);
  const endMs = parseStrictIsoTimestamp(endIso);

  if (startMs === null || endMs === null || startMs >= endMs) {
    throw new Error("retrieval-temporal window must use valid half-open ISO timestamps");
  }

  return { startMs, endMs };
}

function collectEvidenceTimestamps(page: SchemaTierPage): number[] {
  const timestamps = new Set<number>();

  const created = parseTimestamp(page.frontmatter.created);
  if (created !== null) timestamps.add(created);

  for (const entry of page.frontmatter.timeline ?? []) {
    const timestamp = parseTimelineEntry(entry);
    if (timestamp !== null) timestamps.add(timestamp);
  }

  return [...timestamps];
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  return parseStrictIsoTimestamp(value);
}

function parseTimelineEntry(entry: string): number | null {
  const match = entry.match(/^(\d{4})-(\d{2})-(\d{2})(?=$|[:\s])/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date.getTime();
}

function parseStrictIsoTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString() === value ? date.getTime() : null;
}

function matchingPageIds(
  rankedPages: SchemaTierPage[],
  sample: RetrievalTemporalCase,
): string[] {
  return rankedPages
    .filter((page) => pageQualifies(page, sample))
    .map((page) => page.id);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 || (token.length >= 2 && /\d/.test(token))),
  );
}
