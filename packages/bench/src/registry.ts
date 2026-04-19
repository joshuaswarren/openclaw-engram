/**
 * Published benchmark registry for @remnic/bench phase 1.
 */

import type { BenchmarkDefinition, BenchmarkResult, ResolvedRunBenchmarkOptions } from "./types.js";
import {
  amaBenchDefinition,
  runAmaBenchBenchmark,
} from "./benchmarks/published/ama-bench/runner.js";
import {
  amemGymDefinition,
  runAMemGymBenchmark,
} from "./benchmarks/published/amemgym/runner.js";
import {
  memoryArenaDefinition,
  runMemoryArenaBenchmark,
} from "./benchmarks/published/memory-arena/runner.js";
import {
  longMemEvalDefinition,
  runLongMemEvalBenchmark,
} from "./benchmarks/published/longmemeval/runner.js";
import {
  locomoDefinition,
  runLoCoMoBenchmark,
} from "./benchmarks/published/locomo/runner.js";
import {
  beamDefinition,
  runBeamBenchmark,
} from "./benchmarks/published/beam/runner.js";
import {
  personaMemDefinition,
  runPersonaMemBenchmark,
} from "./benchmarks/published/personamem/runner.js";
import {
  memBenchDefinition,
  runMemBenchBenchmark,
} from "./benchmarks/published/membench/runner.js";
import {
  memoryAgentBenchDefinition,
  runMemoryAgentBenchBenchmark,
} from "./benchmarks/published/memoryagentbench/runner.js";
import {
  taxonomyAccuracyDefinition,
  runTaxonomyAccuracyBenchmark,
} from "./benchmarks/remnic/taxonomy-accuracy/runner.js";
import {
  extractionJudgeCalibrationDefinition,
  runExtractionJudgeCalibrationBenchmark,
} from "./benchmarks/remnic/extraction-judge-calibration/runner.js";
import {
  enrichmentFidelityDefinition,
  runEnrichmentFidelityBenchmark,
} from "./benchmarks/remnic/enrichment-fidelity/runner.js";
import {
  entityConsolidationDefinition,
  runEntityConsolidationBenchmark,
} from "./benchmarks/remnic/entity-consolidation/runner.js";
import {
  pageVersioningDefinition,
  runPageVersioningBenchmark,
} from "./benchmarks/remnic/page-versioning/runner.js";
import {
  retrievalPersonalizationDefinition,
  runRetrievalPersonalizationBenchmark,
} from "./benchmarks/remnic/retrieval-personalization/runner.js";
import {
  ingestionEntityRecallDefinition,
  runIngestionEntityRecallBenchmark,
} from "./benchmarks/remnic/ingestion-entity-recall/runner.js";
import {
  ingestionSchemaCompletenessDefinition,
  runIngestionSchemaCompletenessBenchmark,
} from "./benchmarks/remnic/ingestion-schema-completeness/runner.js";
import {
  ingestionBacklinkF1Definition,
  runIngestionBacklinkF1Benchmark,
} from "./benchmarks/remnic/ingestion-backlink-f1/runner.js";
import {
  ingestionSetupFrictionDefinition,
  runIngestionSetupFrictionBenchmark,
} from "./benchmarks/remnic/ingestion-setup-friction/runner.js";
import {
  ingestionCitationAccuracyDefinition,
  runIngestionCitationAccuracyBenchmark,
} from "./benchmarks/remnic/ingestion-citation-accuracy/runner.js";

interface RegisteredBenchmark extends BenchmarkDefinition {
  run?: (options: ResolvedRunBenchmarkOptions) => Promise<BenchmarkResult>;
}

const REGISTERED_BENCHMARKS: RegisteredBenchmark[] = [
  {
    ...amaBenchDefinition,
    run: runAmaBenchBenchmark,
  },
  {
    ...memoryArenaDefinition,
    run: runMemoryArenaBenchmark,
  },
  {
    ...amemGymDefinition,
    run: runAMemGymBenchmark,
  },
  {
    ...longMemEvalDefinition,
    run: runLongMemEvalBenchmark,
  },
  {
    ...locomoDefinition,
    run: runLoCoMoBenchmark,
  },
  {
    ...beamDefinition,
    run: runBeamBenchmark,
  },
  {
    ...personaMemDefinition,
    run: runPersonaMemBenchmark,
  },
  {
    ...memBenchDefinition,
    run: runMemBenchBenchmark,
  },
  {
    ...memoryAgentBenchDefinition,
    run: runMemoryAgentBenchBenchmark,
  },
  {
    ...taxonomyAccuracyDefinition,
    run: runTaxonomyAccuracyBenchmark,
  },
  {
    ...extractionJudgeCalibrationDefinition,
    run: runExtractionJudgeCalibrationBenchmark,
  },
  {
    ...enrichmentFidelityDefinition,
    run: runEnrichmentFidelityBenchmark,
  },
  {
    ...entityConsolidationDefinition,
    run: runEntityConsolidationBenchmark,
  },
  {
    ...pageVersioningDefinition,
    run: runPageVersioningBenchmark,
  },
  {
    ...retrievalPersonalizationDefinition,
    run: runRetrievalPersonalizationBenchmark,
  },
  {
    ...ingestionEntityRecallDefinition,
    run: runIngestionEntityRecallBenchmark,
  },
  {
    ...ingestionSchemaCompletenessDefinition,
    runnerAvailable: false,
    run: runIngestionSchemaCompletenessBenchmark,
  },
  {
    ...ingestionBacklinkF1Definition,
    run: runIngestionBacklinkF1Benchmark,
  },
  {
    ...ingestionSetupFrictionDefinition,
    run: runIngestionSetupFrictionBenchmark as (options: ResolvedRunBenchmarkOptions) => Promise<BenchmarkResult>,
  },
  {
    ...ingestionCitationAccuracyDefinition,
    runnerAvailable: false,
    run: runIngestionCitationAccuracyBenchmark,
  },
];

export function listBenchmarks(): BenchmarkDefinition[] {
  return REGISTERED_BENCHMARKS.map(stripRuntimeFields);
}

export function getBenchmark(id: string): BenchmarkDefinition | undefined {
  const benchmark = REGISTERED_BENCHMARKS.find((candidate) => candidate.id === id);
  return benchmark ? stripRuntimeFields(benchmark) : undefined;
}

export function getRegisteredBenchmark(
  id: string,
): RegisteredBenchmark | undefined {
  return REGISTERED_BENCHMARKS.find((candidate) => candidate.id === id);
}

function stripRuntimeFields(benchmark: RegisteredBenchmark): BenchmarkDefinition {
  return {
    id: benchmark.id,
    title: benchmark.title,
    tier: benchmark.tier,
    status: benchmark.status,
    runnerAvailable: benchmark.runnerAvailable,
    meta: benchmark.meta,
  };
}
