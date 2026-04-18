/**
 * JSON schema contract for BenchmarkResult payloads.
 */

export const BENCHMARK_RESULT_SCHEMA = {
  type: "object",
  required: ["meta", "config", "cost", "results", "environment"],
  properties: {
    meta: {
      type: "object",
      required: [
        "id",
        "benchmark",
        "benchmarkTier",
        "version",
        "remnicVersion",
        "gitSha",
        "timestamp",
        "mode",
        "runCount",
        "seeds",
      ],
      properties: {
        id: { type: "string" },
        benchmark: { type: "string" },
        benchmarkTier: {
          type: "string",
          enum: ["published", "remnic", "custom"],
        },
        version: { type: "string" },
        remnicVersion: { type: "string" },
        gitSha: { type: "string" },
        timestamp: { type: "string" },
        mode: { type: "string", enum: ["full", "quick"] },
        runCount: { type: "number" },
        seeds: {
          type: "array",
          items: { type: "number" },
        },
      },
    },
    config: {
      type: "object",
      required: [
        "systemProvider",
        "judgeProvider",
        "adapterMode",
        "remnicConfig",
      ],
      properties: {
        systemProvider: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["provider", "model"],
              properties: {
                provider: { type: "string" },
                model: { type: "string" },
                baseUrl: { type: "string" },
              },
            },
          ],
        },
        judgeProvider: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["provider", "model"],
              properties: {
                provider: { type: "string" },
                model: { type: "string" },
                baseUrl: { type: "string" },
              },
            },
          ],
        },
        adapterMode: { type: "string" },
        remnicConfig: { type: "object" },
      },
    },
    cost: {
      type: "object",
      required: [
        "totalTokens",
        "inputTokens",
        "outputTokens",
        "estimatedCostUsd",
        "totalLatencyMs",
        "meanQueryLatencyMs",
      ],
      properties: {
        totalTokens: { type: "number" },
        inputTokens: { type: "number" },
        outputTokens: { type: "number" },
        estimatedCostUsd: { type: "number" },
        totalLatencyMs: { type: "number" },
        meanQueryLatencyMs: { type: "number" },
      },
    },
    results: {
      type: "object",
      required: ["tasks", "aggregates"],
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            required: [
              "taskId",
              "question",
              "expected",
              "actual",
              "scores",
              "latencyMs",
              "tokens",
            ],
            properties: {
              taskId: { type: "string" },
              question: { type: "string" },
              expected: { type: "string" },
              actual: { type: "string" },
              scores: { type: "object" },
              latencyMs: { type: "number" },
              tokens: {
                type: "object",
                required: ["input", "output"],
                properties: {
                  input: { type: "number" },
                  output: { type: "number" },
                },
              },
            },
          },
        },
        aggregates: { type: "object" },
        statistics: { type: "object" },
      },
    },
    environment: {
      type: "object",
      required: ["os", "nodeVersion"],
      properties: {
        os: { type: "string" },
        nodeVersion: { type: "string" },
        hardware: { type: "string" },
      },
    },
  },
} as const;
