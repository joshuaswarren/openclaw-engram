/**
 * Enrichment pipeline orchestrator (issue #365).
 *
 * For each entity, determines the importance tier, resolves the providers
 * to run, executes them in sequence (respecting rate limits), tags
 * candidates, and caps at `maxCandidatesPerEntity`.
 *
 * Actual persistence of accepted candidates is the caller's responsibility.
 */

import type { LoggerBackend } from "../logger.js";
import type { EnrichmentProviderRegistry } from "./provider-registry.js";
import type {
  EnrichmentCandidate,
  EnrichmentPipelineConfig,
  EnrichmentProvider,
  EnrichmentResult,
  EntityEnrichmentInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Rate-limit tracking
// ---------------------------------------------------------------------------

interface RateLimitBucket {
  minuteCount: number;
  minuteReset: number;
  dayCount: number;
  dayReset: number;
}

function isRateLimited(
  provider: EnrichmentProvider,
  config: EnrichmentPipelineConfig,
  buckets: Map<string, RateLimitBucket>,
): boolean {
  const providerCfg = config.providers.find((p) => p.id === provider.id);
  if (!providerCfg?.rateLimit) return false;

  const now = Date.now();
  let bucket = buckets.get(provider.id);
  if (!bucket) {
    bucket = {
      minuteCount: 0,
      minuteReset: now + 60_000,
      dayCount: 0,
      dayReset: now + 86_400_000,
    };
    buckets.set(provider.id, bucket);
  }

  // Reset windows if expired
  if (now >= bucket.minuteReset) {
    bucket.minuteCount = 0;
    bucket.minuteReset = now + 60_000;
  }
  if (now >= bucket.dayReset) {
    bucket.dayCount = 0;
    bucket.dayReset = now + 86_400_000;
  }

  const { maxPerMinute, maxPerDay } = providerCfg.rateLimit;
  return bucket.minuteCount >= maxPerMinute || bucket.dayCount >= maxPerDay;
}

function recordCall(
  providerId: string,
  buckets: Map<string, RateLimitBucket>,
): void {
  const bucket = buckets.get(providerId);
  if (bucket) {
    bucket.minuteCount += 1;
    bucket.dayCount += 1;
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runEnrichmentPipeline(
  entities: EntityEnrichmentInput[],
  registry: EnrichmentProviderRegistry,
  config: EnrichmentPipelineConfig,
  log: LoggerBackend,
): Promise<EnrichmentResult[]> {
  if (!config.enabled) return [];
  if (entities.length === 0) return [];

  const rateBuckets = new Map<string, RateLimitBucket>();
  const results: EnrichmentResult[] = [];

  for (const entity of entities) {
    const providers = registry.getForImportance(entity.importanceLevel, config);

    for (const provider of providers) {
      const start = Date.now();

      // Check availability
      let available: boolean;
      try {
        available = await provider.isAvailable();
      } catch {
        available = false;
      }

      if (!available) {
        log.debug?.(
          `enrichment: skipping provider ${provider.id} for ${entity.name} — unavailable`,
        );
        results.push({
          entityName: entity.name,
          provider: provider.id,
          candidatesFound: 0,
          candidatesAccepted: 0,
          candidatesRejected: 0,
          elapsed: Date.now() - start,
        });
        continue;
      }

      // Check rate limit
      if (isRateLimited(provider, config, rateBuckets)) {
        log.debug?.(
          `enrichment: skipping provider ${provider.id} for ${entity.name} — rate limited`,
        );
        results.push({
          entityName: entity.name,
          provider: provider.id,
          candidatesFound: 0,
          candidatesAccepted: 0,
          candidatesRejected: 0,
          elapsed: Date.now() - start,
        });
        continue;
      }

      // Run provider
      let candidates: EnrichmentCandidate[];
      try {
        candidates = await provider.enrich(entity);
        recordCall(provider.id, rateBuckets);
      } catch (err) {
        log.error?.(
          `enrichment: provider ${provider.id} failed for ${entity.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        results.push({
          entityName: entity.name,
          provider: provider.id,
          candidatesFound: 0,
          candidatesAccepted: 0,
          candidatesRejected: 0,
          elapsed: Date.now() - start,
        });
        continue;
      }

      // Tag each candidate with provider id
      for (const candidate of candidates) {
        candidate.source = provider.id;
      }

      // Cap at maxCandidatesPerEntity
      const maxCandidates = config.maxCandidatesPerEntity;
      const accepted =
        maxCandidates > 0 && candidates.length > maxCandidates
          ? candidates.slice(0, maxCandidates)
          : candidates;
      const rejected = candidates.length - accepted.length;

      results.push({
        entityName: entity.name,
        provider: provider.id,
        candidatesFound: candidates.length,
        candidatesAccepted: accepted.length,
        candidatesRejected: rejected,
        elapsed: Date.now() - start,
      });
    }
  }

  return results;
}
