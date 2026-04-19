import {
  FallbackLlmClient,
  type GatewayConfig,
} from "@remnic/core";
import type {
  BenchJudge,
  BenchResponder,
  BenchResponse,
} from "./adapters/types.js";
import { createProvider } from "./providers/factory.js";
import type {
  LlmProvider,
  ProviderFactoryConfig,
} from "./providers/types.js";
import type { StructuredJudge } from "./judges/sealed-rubric.js";

const DEFAULT_RESPONDER_SYSTEM_PROMPT = [
  "You answer benchmark questions using only the supplied Remnic memory context.",
  "If the context does not contain enough information, say that the answer is unknown.",
  "Do not invent facts that are not grounded in the provided context.",
].join(" ");

const DEFAULT_JUDGE_SYSTEM_PROMPT = [
  "You are grading a benchmark answer against an expected answer.",
  "Return only a numeric score from 0.00 to 1.00 inclusive.",
  "Use 1.00 for a fully correct answer, 0.00 for a fully incorrect answer, and fractional values for partial matches.",
].join(" ");

export interface GatewayResponderOptions {
  gatewayConfig?: GatewayConfig;
  agentId?: string;
}

export function createResponderFromProvider(provider: LlmProvider): BenchResponder {
  return {
    async respond(question: string, recalledText: string): Promise<BenchResponse> {
      const completion = await provider.complete(
        [
          `QUESTION: ${question}`,
          "",
          "REMNIC_MEMORY_CONTEXT:",
          recalledText.trim().length > 0 ? recalledText : "(no memory context available)",
          "",
          "Answer the question using only the supplied memory context.",
        ].join("\n"),
        {
          systemPrompt: DEFAULT_RESPONDER_SYSTEM_PROMPT,
          temperature: 0,
        },
      );

      return {
        text: completion.text,
        tokens: completion.tokens,
        latencyMs: completion.latencyMs,
        model: completion.model,
      };
    },
  };
}

export function createProviderBackedResponder(
  config: ProviderFactoryConfig,
  providerInstance?: LlmProvider,
): BenchResponder {
  validateProviderConfig(config, "responder");
  return createResponderFromProvider(providerInstance ?? createProvider(config));
}

function createJudgeFromProvider(provider: LlmProvider): BenchJudge {
  return {
    async score(question: string, predicted: string, expected: string): Promise<number> {
      const completion = await provider.complete(
        [
          `QUESTION: ${question}`,
          "",
          `EXPECTED_ANSWER: ${expected}`,
          "",
          `PREDICTED_ANSWER: ${predicted}`,
          "",
          "Score the predicted answer against the expected answer.",
        ].join("\n"),
        {
          systemPrompt: DEFAULT_JUDGE_SYSTEM_PROMPT,
          temperature: 0,
        },
      );

      return parseScalarJudgeScore(completion.text);
    },
  };
}

export function createProviderBackedJudge(
  config: ProviderFactoryConfig,
  providerInstance?: LlmProvider,
): BenchJudge {
  validateProviderConfig(config, "judge");
  return createJudgeFromProvider(providerInstance ?? createProvider(config));
}

export function createStructuredJudgeFromProvider(
  provider: LlmProvider,
): StructuredJudge {
  return {
    async evaluate(request) {
      const completion = await provider.complete(request.user, {
        systemPrompt: request.system,
        temperature: 0,
      });
      return completion.text;
    },
  };
}

export function createProviderBackedStructuredJudge(
  config: ProviderFactoryConfig,
  providerInstance?: LlmProvider,
): StructuredJudge {
  validateProviderConfig(config, "judge");
  return createStructuredJudgeFromProvider(providerInstance ?? createProvider(config));
}

export function createGatewayResponder(
  options: GatewayResponderOptions,
): BenchResponder {
  if (!options.gatewayConfig) {
    throw new Error("gateway responder requires gatewayConfig");
  }

  const llm = new FallbackLlmClient(options.gatewayConfig);

  return {
    async respond(question: string, recalledText: string): Promise<BenchResponse> {
      const startedAt = performance.now();
      const response = await llm.chatCompletion(
        [
          { role: "system", content: DEFAULT_RESPONDER_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `QUESTION: ${question}`,
              "",
              "REMNIC_MEMORY_CONTEXT:",
              recalledText.trim().length > 0
                ? recalledText
                : "(no memory context available)",
              "",
              "Answer the question using only the supplied memory context.",
            ].join("\n"),
          },
        ],
        {
          temperature: 0,
          agentId: options.agentId,
        },
      );

      if (!response?.content) {
        throw new Error("gateway responder returned no content");
      }

      return {
        text: response.content,
        tokens: {
          input: response.usage?.inputTokens ?? 0,
          output: response.usage?.outputTokens ?? 0,
        },
        latencyMs: Math.round(performance.now() - startedAt),
        model: response.modelUsed,
      };
    },
  };
}

function validateProviderConfig(
  config: ProviderFactoryConfig,
  kind: "responder" | "judge",
): void {
  if (typeof config.model !== "string" || config.model.trim().length === 0) {
    throw new Error(`provider-backed ${kind} requires a non-empty model`);
  }
}

function parseScalarJudgeScore(raw: string): number {
  const trimmed = raw.trim();

  const fractionMatch = trimmed.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (fractionMatch) {
    const numerator = Number.parseFloat(fractionMatch[1]);
    const denominator = Number.parseFloat(fractionMatch[2]);
    if (
      Number.isFinite(numerator) &&
      Number.isFinite(denominator) &&
      denominator > 0
    ) {
      return clampNormalizedScore(numerator / denominator);
    }
  }

  const percentMatch = trimmed.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (percentMatch) {
    const percent = Number.parseFloat(percentMatch[1]);
    if (Number.isFinite(percent)) {
      return clampNormalizedScore(percent / 100);
    }
  }

  const scalarMatch = trimmed.match(/-?\d+(?:\.\d+)?/);
  if (!scalarMatch) {
    return -1;
  }

  const value = Number.parseFloat(scalarMatch[0]);
  if (!Number.isFinite(value)) {
    return -1;
  }

  return clampNormalizedScore(value);
}

function clampNormalizedScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
