/**
 * Ingestion citation accuracy benchmark.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import type { ExtractedPage } from "../../../ingestion-types.js";
import type { BenchJudge } from "../../../adapters/types.js";
import { aggregateTaskScores, llmJudgeScore, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

export const ingestionCitationAccuracyDefinition: BenchmarkDefinition = {
  id: "ingestion-citation-accuracy",
  title: "Ingestion: Citation Accuracy",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-citation-accuracy",
    version: "1.0.0",
    description: "Verifies that claims in generated summaries cite valid source chunks via LLM judge.",
    category: "ingestion",
  },
};

function extractClaims(pages: ExtractedPage[]): Array<{ claim: string; sourceContent: string }> {
  const claims: Array<{ claim: string; sourceContent: string }> = [];
  for (const page of pages) {
    if (!page.content) continue;
    const sentences = page.content
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
    for (const sentence of sentences) {
      claims.push({ claim: sentence, sourceContent: page.content });
    }
  }
  return claims;
}

export async function runIngestionCitationAccuracyBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  if (!options.ingestionAdapter) {
    throw new Error("ingestionAdapter is required for ingestion benchmarks");
  }
  const fixture = emailFixture.generate();

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "bench-citation-"));
  try {
    await options.ingestionAdapter!.reset();

    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const { result: ingestionLog, durationMs } = await timed(() =>
      options.ingestionAdapter!.ingest(fixtureDir),
    );

    const graph = await options.ingestionAdapter.getMemoryGraph();
    const claims = extractClaims(graph.pages);

    const judge: BenchJudge | undefined = options.system?.judge;

    const originalSources = fixture.files.map((f) => f.content).join("\n\n---\n\n");

    let validCitations = 0;
    let scoredClaims = 0;

    if (claims.length > 0) {
      for (const { claim, sourceContent } of claims) {
        const score = await llmJudgeScore(
          judge,
          `Does the page content support this claim with evidence from the original sources? Claim: "${claim}"`,
          sourceContent,
          originalSources,
        );
        if (score >= 0) {
          scoredClaims += 1;
          if (score >= 0.5) {
            validCitations += 1;
          }
        }
      }
    }

    const citationAccuracy = scoredClaims > 0 ? validCitations / scoredClaims : -1;

    const scores: Record<string, number> = {
      total_claims: claims.length,
    };
    if (citationAccuracy >= 0) {
      scores.valid_citations = validCitations;
      scores.citation_accuracy = citationAccuracy;
    }

    const tasks = [
      {
        taskId: `citation-accuracy-${fixture.id}`,
        question: `Verify citation accuracy for ${fixture.id} fixture`,
        expected: `All claims cite valid source chunks`,
        actual: judge
          ? `${validCitations}/${scoredClaims} claims cite valid source chunks (${claims.length} total claims)`
          : `No judge available; ${claims.length} claims extracted`,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          fixtureId: fixture.id,
          totalClaims: claims.length,
          scoredClaims,
          validCitations,
          citationAccuracy,
          judgeAvailable: judge !== undefined,
          ingestionErrors: ingestionLog.errors,
        },
      },
    ];

    const remnicVersion = await getRemnicVersion();
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
        totalLatencyMs: durationMs,
        meanQueryLatencyMs: durationMs,
      },
      results: {
        tasks,
        aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
      },
      environment: {
        os: process.platform,
        nodeVersion: process.version,
        hardware: process.arch,
      },
    };
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}
