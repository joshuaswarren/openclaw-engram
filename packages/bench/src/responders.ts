import {
  FallbackLlmClient,
  type FallbackLlmRuntimeContext,
  type GatewayConfig,
} from "@remnic/core";
import type {
  BenchJudge,
  BenchJudgeResult,
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

const AMA_BENCH_RECOMMENDED_JUDGE_SYSTEM_PROMPT = [
  "You are evaluating an AMA-Bench long-horizon memory question.",
  "Decide whether the predicted answer correctly answers the question using the reference answer as ground truth.",
  "Award 1 only when the predicted answer contains the same essential information as the reference answer.",
  "Award 0 when the answer is wrong, missing, contradictory, or only vaguely related.",
  "Ignore harmless wording differences, formatting differences, and extra explanation that does not change the answer.",
  'Return only JSON: {"score":0 or 1,"reason":"short reason"}.',
].join(" ");

const SCORE_CUE_REGEX = /\b(score|rated|rating|grade|graded|result|overall|final)\b/;

export interface GatewayResponderOptions {
  gatewayConfig?: GatewayConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  llmFactory?: (
    gatewayConfig: GatewayConfig,
    runtimeContext: FallbackLlmRuntimeContext,
  ) => Pick<FallbackLlmClient, "chatCompletion">;
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
  async function scoreWithMetrics(
    question: string,
    predicted: string,
    expected: string,
  ): Promise<BenchJudgeResult> {
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

    return {
      score: parseScalarJudgeScore(completion.text),
      tokens: completion.tokens,
      latencyMs: completion.latencyMs,
      model: completion.model,
    };
  }

  return {
    async score(question: string, predicted: string, expected: string): Promise<number> {
      return (await scoreWithMetrics(question, predicted, expected)).score;
    },
    scoreWithMetrics,
  };
}

export function createProviderBackedJudge(
  config: ProviderFactoryConfig,
  providerInstance?: LlmProvider,
): BenchJudge {
  validateProviderConfig(config, "judge");
  return createJudgeFromProvider(providerInstance ?? createProvider(config));
}

function createAmaBenchRecommendedJudgeFromProvider(provider: LlmProvider): BenchJudge {
  async function scoreWithMetrics(
    question: string,
    predicted: string,
    expected: string,
  ): Promise<BenchJudgeResult> {
    const completion = await provider.complete(
      [
        `QUESTION: ${question}`,
        "",
        `REFERENCE_ANSWER: ${expected}`,
        "",
        `PREDICTED_ANSWER: ${predicted}`,
        "",
        "Judge the predicted answer under the AMA-Bench binary accuracy protocol.",
      ].join("\n"),
      {
        systemPrompt: AMA_BENCH_RECOMMENDED_JUDGE_SYSTEM_PROMPT,
        temperature: 0,
      },
    );

    return {
      score: parseAmaBenchBinaryJudgeScore(completion.text),
      tokens: completion.tokens,
      latencyMs: completion.latencyMs,
      model: completion.model,
    };
  }

  return {
    async score(question: string, predicted: string, expected: string): Promise<number> {
      return (await scoreWithMetrics(question, predicted, expected)).score;
    },
    scoreWithMetrics,
  };
}

export function createProviderBackedAmaBenchRecommendedJudge(
  config: ProviderFactoryConfig,
  providerInstance?: LlmProvider,
): BenchJudge {
  validateProviderConfig(config, "AMA-Bench recommended judge");
  return createAmaBenchRecommendedJudgeFromProvider(
    providerInstance ?? createProvider(config),
  );
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

  const runtimeContext: FallbackLlmRuntimeContext = {
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
  };
  const llm = options.llmFactory?.(options.gatewayConfig, runtimeContext)
    ?? new FallbackLlmClient(options.gatewayConfig, runtimeContext);

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
  kind: "responder" | "judge" | "AMA-Bench recommended judge",
): void {
  if (typeof config.model !== "string" || config.model.trim().length === 0) {
    throw new Error(`provider-backed ${kind} requires a non-empty model`);
  }
}

function parseScalarJudgeScore(raw: string): number {
  const trimmed = raw.trim();

  const fractionMatches = [
    ...trimmed.matchAll(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/g),
  ];
  for (const match of fractionMatches.reverse()) {
    const numerator = Number.parseFloat(match[1]);
    const denominator = Number.parseFloat(match[2]);
    if (isPlausibleSlashScoreFraction(trimmed, match, numerator, denominator)) {
      return clampNormalizedScore(numerator / denominator);
    }
  }

  const percentMatches = [...trimmed.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)];
  for (const match of percentMatches.reverse()) {
    const percent = Number.parseFloat(match[1]);
    if (Number.isFinite(percent)) {
      return clampNormalizedScore(percent / 100);
    }
  }

  const outOfMatches = [
    ...trimmed.matchAll(/(-?\d+(?:\.\d+)?)\s+out\s+of\s+(-?\d+(?:\.\d+)?)/gi),
  ];
  for (const match of outOfMatches.reverse()) {
    const numerator = Number.parseFloat(match[1]);
    const denominator = Number.parseFloat(match[2]);
    if (isPlausibleScoreFraction(numerator, denominator)) {
      return clampNormalizedScore(numerator / denominator);
    }
  }

  const scalarMatches = [...trimmed.matchAll(/-?\d+(?:\.\d+)?/g)];
  for (const match of scalarMatches.reverse()) {
    const value = Number.parseFloat(match[0]);
    if (isPlausibleScalarScore(value)) {
      return clampNormalizedScore(value);
    }
  }

  return -1;
}

function parseAmaBenchBinaryJudgeScore(raw: string): number {
  const trimmed = raw.trim();
  const jsonCandidates = extractJsonObjects(trimmed);
  for (const jsonCandidate of jsonCandidates.reverse()) {
    try {
      const parsed = JSON.parse(jsonCandidate) as { score?: unknown };
      if (parsed.score === 0 || parsed.score === 1) {
        return parsed.score;
      }
      if (parsed.score === "0" || parsed.score === "1") {
        return Number(parsed.score);
      }
    } catch {
      // Keep scanning for a later score object.
    }
  }

  const scalar = parseScalarJudgeScore(trimmed);
  if (scalar === 0 || scalar === 1) {
    return scalar;
  }
  if (scalar > 0.5) {
    return 1;
  }
  if (scalar >= 0) {
    return 0;
  }
  if (/^\s*no[.!]?\s*$/i.test(trimmed)) {
    return 0;
  }
  if (
    /\b(?:not|never|isn'?t|wasn'?t|doesn'?t|didn'?t|cannot|can'?t)\b(?:\s+\w+){0,3}\s+(?:incorrect|false|fail(?:ed|s|ing)?)\b/i.test(
      trimmed,
    )
  ) {
    return 1;
  }
  if (/\b(incorrect|false|fail(?:ed|s)?)\b/i.test(trimmed)) {
    return 0;
  }
  if (
    /\b(?:not|never|isn'?t|wasn'?t|doesn'?t|didn'?t|cannot|can'?t)\b(?:\s+\w+){0,3}\s+(?:correct|true|pass(?:ed|es|ing)?|match(?:es|ed|ing)?|same)\b/i.test(
      trimmed,
    )
  ) {
    return 0;
  }
  if (/\b(correct|yes|true|pass)\b/i.test(trimmed)) {
    return 1;
  }
  return -1;
}

function extractJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        objects.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function isPlausibleScoreFraction(
  numerator: number,
  denominator: number,
): boolean {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return false;
  }

  if (denominator <= 0 || numerator < 0 || numerator > denominator) {
    return false;
  }

  return denominator <= 10 || denominator === 100 || denominator % 5 === 0;
}

function isPlausibleSlashScoreFraction(
  raw: string,
  match: RegExpMatchArray,
  numerator: number,
  denominator: number,
): boolean {
  if (!isPlausibleScoreFraction(numerator, denominator)) {
    return false;
  }

  const start = match.index ?? -1;
  if (start < 0) {
    return false;
  }

  if (denominator <= 10 || denominator === 100) {
    const end = start + match[0].length;
    const afterContext = raw.slice(end);
    if (/^\s*\/\s*\d/.test(afterContext)) {
      return false;
    }
    return isStandaloneSlashScore(raw, start, end) || hasScoreCueBefore(raw, start);
  }

  const end = start + match[0].length;
  if (isStandaloneSlashScore(raw, start, end)) {
    return true;
  }

  return hasScoreCueBefore(raw, start);
}

function isStandaloneSlashScore(
  raw: string,
  start: number,
  end: number,
): boolean {
  return raw.slice(0, start).trim().length === 0 &&
    /^[\s.!?]*$/.test(raw.slice(end));
}

function hasScoreCueBefore(raw: string, start: number): boolean {
  const beforeContext = raw
    .slice(Math.max(0, start - 20), start)
    .toLowerCase();

  return SCORE_CUE_REGEX.test(beforeContext);
}

function isPlausibleScalarScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function clampNormalizedScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
